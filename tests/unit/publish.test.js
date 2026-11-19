import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  parseDotEnv,
  createAmoJwt,
  createServiceAccountJwt,
  buildAmoVersionPayload,
  resolveTargetConfig,
  publishChrome,
  publishFirefox,
} from '../../scripts/publish.js';

const MANIFEST = JSON.parse(fs.readFileSync(path.resolve('manifest.json'), 'utf8'));
const AMO_META = JSON.parse(fs.readFileSync(path.resolve('scripts', 'amo-metadata.json'), 'utf8'));

function makeJsonResponse(status, bodyObj) {
  const raw = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    async text() {
      return raw;
    },
  };
}

describe('scripts/publish.js store automation', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yousub-publish-test-'));
    const distDir = path.join(tempDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    const slug = String(MANIFEST.name || 'yousub')
      .toLowerCase()
      .replace(/\s+/g, '-');
    fs.writeFileSync(path.join(distDir, `${slug}-v${MANIFEST.version}-chrome.zip`), 'PK\x05\x06');
    fs.writeFileSync(path.join(distDir, `${slug}-v${MANIFEST.version}-firefox.zip`), 'PK\x05\x06');
  });

  afterAll(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test('parseDotEnv parses assignments, interpolates variables, and skips raw non-assignment lines', () => {
    const raw = `
# Comment
CHROME_EXTENSION_ID=jlpgmjpekhnlncfdkmddoienleiljehk
CHROME_WEB_STORE="https://chromewebstore.google.com/detail/yousub/\${CHROME_EXTENSION_ID}"
RAW_NON_ASSIGNMENT_HEADER
CWS_PUBLISHER_ID='pub-123'
`;
    const parsed = parseDotEnv(raw, { FALLBACK_VAR: 'ok' });
    expect(parsed).toEqual({
      CHROME_EXTENSION_ID: 'jlpgmjpekhnlncfdkmddoienleiljehk',
      CHROME_WEB_STORE:
        'https://chromewebstore.google.com/detail/yousub/jlpgmjpekhnlncfdkmddoienleiljehk',
      CWS_PUBLISHER_ID: 'pub-123',
    });
  });

  test('createAmoJwt creates a verifiable HS256 JWT token', () => {
    const token = createAmoJwt('user:123:456', 'supersecret', 1700000000, 'jti-1');
    const [hdr, pay, sig] = token.split('.');
    expect(JSON.parse(Buffer.from(hdr, 'base64url').toString('utf8'))).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(pay, 'base64url').toString('utf8'))).toEqual({
      iss: 'user:123:456',
      jti: 'jti-1',
      iat: 1700000000,
      exp: 1700000240,
    });
    const expectedSig = crypto
      .createHmac('sha256', 'supersecret')
      .update(`${hdr}.${pay}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(sig).toBe(expectedSig);
  });

  test('createServiceAccountJwt and publishChrome exchange a Service Account JSON key via jwt-bearer', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const saJson = JSON.stringify({
      client_email: 'yousub-bot@test-proj.iam.gserviceaccount.com',
      private_key: privateKey,
    });

    const jwt = createServiceAccountJwt(JSON.parse(saJson), 1700000000);
    const parts = jwt.split('.');
    expect(parts.length).toBe(3);
    expect(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))).toMatchObject({
      iss: 'yousub-bot@test-proj.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/chromewebstore',
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(makeJsonResponse(200, { access_token: 'sa_tok_1' }))
      .mockResolvedValueOnce(makeJsonResponse(200, { uploadState: 'SUCCEEDED' }))
      .mockResolvedValueOnce(makeJsonResponse(200, { itemId: 'ghkhpekngpdkbkpnookplgdhladbijnf' }))
      .mockResolvedValueOnce(makeJsonResponse(200, { state: 'PENDING_REVIEW' }));

    const res = await publishChrome(
      {
        env: {
          CWS_PUBLISHER_ID: 'pub-sa',
          CWS_ITEM_ID: 'jlpgmjpekhnlncfdkmddoienleiljehk',
          CWS_SERVICE_ACCOUNT_JSON: saJson,
        },
        manifest: MANIFEST,
        cwd: tempDir,
      },
      { fetchImpl: fetchMock, log: jest.fn() }
    );

    expect(res.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][1].body)).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer'
    );
  });

  test('buildAmoVersionPayload formats initial add-on creation vs subsequent version update', () => {
    const initial = buildAmoVersionPayload('uuid-1', AMO_META, true, 'Policy prose');
    expect(initial.name).toEqual(AMO_META.name);
    expect(initial.categories).toEqual(AMO_META.categories);
    expect(initial.privacy_policy).toEqual({ 'en-US': 'Policy prose' });
    expect(initial.version).toEqual({
      upload: 'uuid-1',
      license: 'AGPL-3.0-only',
      release_notes: AMO_META.release_notes,
      approval_notes: AMO_META.approval_notes,
    });

    const update = buildAmoVersionPayload('uuid-2', AMO_META, false, 'Ignored');
    expect(update).toEqual({
      upload: 'uuid-2',
      license: 'AGPL-3.0-only',
      release_notes: AMO_META.release_notes,
      approval_notes: AMO_META.approval_notes,
    });
  });

  test('resolveTargetConfig validates Chrome and Firefox credential completeness', () => {
    const chromeMissing = resolveTargetConfig(
      'chrome',
      { CHROME_EXTENSION_ID: 'ghkhpekngpdkbkpnookplgdhladbijnf' },
      MANIFEST,
      tempDir
    );
    expect(chromeMissing.zipExists).toBe(true);
    expect(chromeMissing.hasAuth).toBe(false);
    expect(chromeMissing.missingCredentials).toContain('CWS_PUBLISHER_ID');

    const firefoxReady = resolveTargetConfig(
      'firefox',
      { AMO_JWT_ISSUER: 'user:1:2', AMO_JWT_SECRET: 'sec' },
      MANIFEST,
      tempDir
    );
    expect(firefoxReady.geckoId).toBe('yousub@xinh.tools');
    expect(firefoxReady.zipExists).toBe(true);
    expect(firefoxReady.hasAuth).toBe(true);
  });

  test('publishChrome supports --dry-run without auth and uploads/publishes via API v2 when configured', async () => {
    const dry = await publishChrome(
      {
        env: { CHROME_EXTENSION_ID: 'ghkhpekngpdkbkpnookplgdhladbijnf' },
        manifest: MANIFEST,
        dryRun: true,
        cwd: tempDir,
      },
      { log: jest.fn() }
    );
    expect(dry).toMatchObject({ ok: true, dryRun: true, ready: false });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(makeJsonResponse(200, { access_token: 'tok_abc' }))
      .mockResolvedValueOnce(makeJsonResponse(200, { uploadState: 'SUCCEEDED' }))
      .mockResolvedValueOnce(makeJsonResponse(200, { itemId: 'jlpgmjpekhnlncfdkmddoienleiljehk' }))
      .mockResolvedValueOnce(makeJsonResponse(200, { state: 'PENDING_REVIEW' }));

    const result = await publishChrome(
      {
        env: {
          CWS_PUBLISHER_ID: 'pub-99',
          CHROME_EXTENSION_ID: 'jlpgmjpekhnlncfdkmddoienleiljehk',
          CWS_CLIENT_ID: 'cid',
          CWS_CLIENT_SECRET: 'csec',
          CWS_REFRESH_TOKEN: 'rtok',
        },
        manifest: MANIFEST,
        staged: true,
        cwd: tempDir,
      },
      { fetchImpl: fetchMock, log: jest.fn() }
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://chromewebstore.googleapis.com/upload/v2/publishers/pub-99/items/jlpgmjpekhnlncfdkmddoienleiljehk:upload'
    );
    expect(fetchMock.mock.calls[3][0]).toBe(
      'https://chromewebstore.googleapis.com/v2/publishers/pub-99/items/jlpgmjpekhnlncfdkmddoienleiljehk:publish'
    );
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
      publishType: 'STAGED_PUBLISH',
    });
  });

  test('publishFirefox handles initial creation (404 lookup) and existing updates (200 lookup) with validation poll', async () => {
    const dry = await publishFirefox(
      { env: {}, manifest: MANIFEST, metadata: AMO_META, dryRun: true, cwd: tempDir },
      { log: jest.fn() }
    );
    expect(dry).toMatchObject({ ok: true, dryRun: true, ready: false });

    // Initial listing creation path (addon GET returns 404)
    const fetchInitial = jest
      .fn()
      .mockResolvedValueOnce(makeJsonResponse(201, { uuid: 'up-1', processed: false }))
      .mockResolvedValueOnce(makeJsonResponse(200, { uuid: 'up-1', processed: true, valid: true }))
      .mockResolvedValueOnce(makeJsonResponse(404, { detail: 'Not found' }))
      .mockResolvedValueOnce(makeJsonResponse(201, { id: 1001, guid: 'yousub@xinh.tools' }));

    const initialRes = await publishFirefox(
      {
        env: { AMO_JWT_ISSUER: 'iss', AMO_JWT_SECRET: 'sec' },
        manifest: MANIFEST,
        metadata: AMO_META,
        privacyPolicyText: '# Privacy Policy',
        pollIntervalMs: 1,
        cwd: tempDir,
      },
      { fetchImpl: fetchInitial, sleepImpl: async () => {}, log: jest.fn() }
    );

    expect(initialRes.ok).toBe(true);
    expect(initialRes.initialCreate).toBe(true);
    expect(fetchInitial.mock.calls[3][0]).toBe('https://addons.mozilla.org/api/v5/addons/addon/');

    // Existing addon version update path (addon GET returns 200)
    const fetchUpdate = jest
      .fn()
      .mockResolvedValueOnce(makeJsonResponse(201, { uuid: 'up-2', processed: true, valid: true }))
      .mockResolvedValueOnce(makeJsonResponse(200, { id: 1001, guid: 'yousub@xinh.tools' }))
      .mockResolvedValueOnce(makeJsonResponse(201, { id: 5002, version: '0.2.5' }));

    const updateRes = await publishFirefox(
      {
        env: { AMO_JWT_ISSUER: 'iss', AMO_JWT_SECRET: 'sec' },
        manifest: MANIFEST,
        metadata: AMO_META,
        pollIntervalMs: 1,
        cwd: tempDir,
      },
      { fetchImpl: fetchUpdate, sleepImpl: async () => {}, log: jest.fn() }
    );

    expect(updateRes.ok).toBe(true);
    expect(updateRes.initialCreate).toBe(false);
    expect(fetchUpdate.mock.calls[2][0]).toBe(
      'https://addons.mozilla.org/api/v5/addons/addon/yousub%40xinh.tools/versions/'
    );
  });
});
