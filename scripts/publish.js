import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const CWS_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CWS_API_BASE = 'https://chromewebstore.googleapis.com';
const AMO_API_BASE = 'https://addons.mozilla.org/api/v5';

/**
 * Parse a .env file into a plain key-value map while ignoring comments,
 * blank lines, and non-assignment lines (such as raw key lists).
 * Supports basic `${VAR}` interpolation from parsed values or existing env.
 * @param {string} rawText
 * @param {Record<string, string | undefined>} [baseEnv={}]
 * @returns {Record<string, string>}
 */
export function parseDotEnv(rawText, baseEnv = {}) {
  const out = {};
  if (typeof rawText !== 'string' || !rawText.trim()) return out;

  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let val = match[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    val = val.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, refKey) => {
      if (refKey in out) return out[refKey];
      if (refKey in baseEnv && baseEnv[refKey] != null) return String(baseEnv[refKey]);
      return '';
    });
    out[key] = val;
  }
  return out;
}

/**
 * Load `.env` from cwd when present, letting real process.env take precedence.
 * @param {string} [envPath]
 * @param {Record<string, string | undefined>} [targetEnv=process.env]
 * @returns {Record<string, string | undefined>}
 */
export function loadEnv(envPath = path.resolve(process.cwd(), '.env'), targetEnv = process.env) {
  let fileEnv = {};
  if (fs.existsSync(envPath)) {
    fileEnv = parseDotEnv(fs.readFileSync(envPath, 'utf8'), targetEnv);
  }
  return { ...fileEnv, ...targetEnv };
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Create an HS256 JWT token for Mozilla AMO API v5 authentication.
 * @param {string} issuer
 * @param {string} secret
 * @param {number} [nowSec]
 * @param {string} [jti]
 * @returns {string}
 */
export function createAmoJwt(
  issuer,
  secret,
  nowSec = Math.floor(Date.now() / 1000),
  jti = crypto.randomUUID()
) {
  if (!issuer || !secret) {
    throw new Error('AMO_JWT_ISSUER and AMO_JWT_SECRET are required to sign AMO JWT');
  }
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: issuer,
      jti,
      iat: nowSec,
      exp: nowSec + 240,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${signingInput}.${signature}`;
}

/**
 * Create a signed RS256 JWT assertion for a Google Cloud Service Account.
 * @param {{ client_email?: string, private_key?: string }} saObj
 * @param {number} [nowSec]
 * @returns {string}
 */
export function createServiceAccountJwt(saObj, nowSec = Math.floor(Date.now() / 1000)) {
  if (!saObj || !saObj.client_email || !saObj.private_key) {
    throw new Error('Service Account JSON must include client_email and private_key');
  }
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: saObj.client_email,
      scope: 'https://www.googleapis.com/auth/chromewebstore',
      aud: CWS_OAUTH_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );
  const signingInput = `${header}.${payload}`;
  const sigBuf = crypto.createSign('RSA-SHA256').update(signingInput).sign(saObj.private_key);
  return `${signingInput}.${base64UrlEncode(sigBuf)}`;
}

function loadServiceAccountJson(env, cwd = process.cwd()) {
  if (env.CWS_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(env.CWS_SERVICE_ACCOUNT_JSON);
  }
  if (env.CWS_SERVICE_ACCOUNT_PATH) {
    const resolved = path.resolve(cwd, env.CWS_SERVICE_ACCOUNT_PATH);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Service account JSON file not found: ${resolved}`);
    }
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  }
  return null;
}

/**
 * Build request payload for either creating a new AMO add-on listing or adding a version.
 * @param {string} uploadUuid
 * @param {object} metadata
 * @param {boolean} isInitialCreate
 * @param {string} [privacyPolicyText]
 * @returns {object}
 */
export function buildAmoVersionPayload(uploadUuid, metadata, isInitialCreate, privacyPolicyText) {
  const versionObj = {
    upload: uploadUuid,
    license: metadata.license || 'AGPL-3.0-only',
  };
  if (metadata.release_notes) versionObj.release_notes = metadata.release_notes;
  if (metadata.approval_notes) versionObj.approval_notes = metadata.approval_notes;

  if (!isInitialCreate) {
    return versionObj;
  }

  const addonPayload = {
    name: metadata.name,
    summary: metadata.summary,
    categories: metadata.categories,
    requires_payment: Boolean(metadata.requires_payment),
    is_experimental: Boolean(metadata.is_experimental),
    version: versionObj,
  };
  if (metadata.homepage) addonPayload.homepage = metadata.homepage;
  if (metadata.support_email) addonPayload.support_email = metadata.support_email;
  if (privacyPolicyText && privacyPolicyText.trim()) {
    addonPayload.privacy_policy = { 'en-US': privacyPolicyText.trim() };
  }
  return addonPayload;
}

/**
 * Resolve release package paths and credential availability from env + manifest.
 * @param {'chrome' | 'firefox'} platform
 * @param {Record<string, string | undefined>} env
 * @param {object} manifest
 * @param {string} [cwd=process.cwd()]
 */
export function resolveTargetConfig(platform, env, manifest, cwd = process.cwd()) {
  const slug = String(manifest.name || 'yousub')
    .toLowerCase()
    .replace(/\s+/g, '-');
  const version = manifest.version;
  const zipPath = path.resolve(cwd, 'dist', `${slug}-v${version}-${platform}.zip`);
  const zipExists = fs.existsSync(zipPath);

  if (platform === 'chrome') {
    const itemId = env.CWS_ITEM_ID || env.CHROME_EXTENSION_ID || '';
    const publisherId = env.CWS_PUBLISHER_ID || '';
    const accessToken = env.CWS_ACCESS_TOKEN || '';
    const saPath = env.CWS_SERVICE_ACCOUNT_PATH
      ? path.resolve(cwd, env.CWS_SERVICE_ACCOUNT_PATH)
      : '';
    const hasServiceAccount = Boolean(
      env.CWS_SERVICE_ACCOUNT_JSON || (saPath && fs.existsSync(saPath))
    );
    const hasOAuth = Boolean(env.CWS_CLIENT_ID && env.CWS_CLIENT_SECRET && env.CWS_REFRESH_TOKEN);
    const missing = [];
    if (!publisherId) missing.push('CWS_PUBLISHER_ID');
    if (!itemId) missing.push('CWS_ITEM_ID (or CHROME_EXTENSION_ID)');
    if (env.CWS_SERVICE_ACCOUNT_PATH && !fs.existsSync(saPath)) {
      missing.push(`CWS_SERVICE_ACCOUNT_PATH (missing file: ${saPath})`);
    } else if (!accessToken && !hasServiceAccount && !hasOAuth) {
      missing.push(
        'CWS_SERVICE_ACCOUNT_PATH / CWS_SERVICE_ACCOUNT_JSON or (CWS_CLIENT_ID + CWS_CLIENT_SECRET + CWS_REFRESH_TOKEN)'
      );
    }
    return {
      platform,
      version,
      zipPath,
      zipExists,
      itemId,
      publisherId,
      hasAuth: missing.length === 0,
      missingCredentials: missing,
    };
  }

  const geckoId = manifest?.browser_specific_settings?.gecko?.id || env.GECKO_ADDON_ID || '';
  const issuer = env.AMO_JWT_ISSUER || '';
  const secret = env.AMO_JWT_SECRET || '';
  const missing = [];
  if (!geckoId) missing.push('manifest.browser_specific_settings.gecko.id');
  if (!issuer) missing.push('AMO_JWT_ISSUER');
  if (!secret) missing.push('AMO_JWT_SECRET');
  return {
    platform,
    version,
    zipPath,
    zipExists,
    geckoId,
    hasAuth: missing.length === 0,
    missingCredentials: missing,
  };
}

async function readJsonSafe(res) {
  const text = await res.text();
  try {
    return { data: text ? JSON.parse(text) : null, raw: text };
  } catch {
    return { data: null, raw: text };
  }
}

async function exchangeCwsToken(env, fetchImpl, cwd = process.cwd()) {
  if (env.CWS_ACCESS_TOKEN) return env.CWS_ACCESS_TOKEN;

  const saObj = loadServiceAccountJson(env, cwd);
  if (saObj) {
    const assertion = createServiceAccountJwt(saObj);
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const res = await fetchImpl(CWS_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const { data, raw } = await readJsonSafe(res);
    if (!res.ok || !data?.access_token) {
      throw new Error(
        `CWS Service Account token exchange failed (${res.status}): ${raw || res.statusText}`
      );
    }
    return data.access_token;
  }

  const body = new URLSearchParams({
    client_id: env.CWS_CLIENT_ID,
    client_secret: env.CWS_CLIENT_SECRET,
    refresh_token: env.CWS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const res = await fetchImpl(CWS_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const { data, raw } = await readJsonSafe(res);
  if (!res.ok || !data?.access_token) {
    throw new Error(`CWS OAuth2 token exchange failed (${res.status}): ${raw || res.statusText}`);
  }
  return data.access_token;
}

/**
 * Upload and submit a package via Chrome Web Store API v2.
 */
export async function publishChrome(
  { env, manifest, dryRun = false, staged = false, cwd = process.cwd() },
  { fetchImpl = globalThis.fetch, log = console.log } = {}
) {
  const cfg = resolveTargetConfig('chrome', env, manifest, cwd);
  if (!cfg.zipExists) {
    throw new Error(`Chrome package missing: ${cfg.zipPath}. Run "npm run package" first.`);
  }

  const uploadUrl = `${CWS_API_BASE}/upload/v2/publishers/${encodeURIComponent(cfg.publisherId || '<CWS_PUBLISHER_ID>')}/items/${encodeURIComponent(cfg.itemId || '<CWS_ITEM_ID>')}:upload`;
  const statusUrl = `${CWS_API_BASE}/v2/publishers/${encodeURIComponent(cfg.publisherId || '<CWS_PUBLISHER_ID>')}/items/${encodeURIComponent(cfg.itemId || '<CWS_ITEM_ID>')}:fetchStatus`;
  const publishUrl = `${CWS_API_BASE}/v2/publishers/${encodeURIComponent(cfg.publisherId || '<CWS_PUBLISHER_ID>')}/items/${encodeURIComponent(cfg.itemId || '<CWS_ITEM_ID>')}:publish`;
  const publishType = staged ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH';

  if (dryRun) {
    log('[DRY-RUN][Chrome] Package verified:', cfg.zipPath);
    log('[DRY-RUN][Chrome] Upload URL:', uploadUrl);
    log('[DRY-RUN][Chrome] Publish URL:', publishUrl, `(${publishType})`);
    log(
      '[DRY-RUN][Chrome] Credentials status:',
      cfg.hasAuth ? 'READY' : `MISSING [${cfg.missingCredentials.join(', ')}]`
    );
    return {
      ok: true,
      dryRun: true,
      ready: cfg.hasAuth,
      missingCredentials: cfg.missingCredentials,
    };
  }

  if (!cfg.hasAuth) {
    throw new Error(
      `Missing Chrome Web Store API credentials: ${cfg.missingCredentials.join(', ')}`
    );
  }

  const token = await exchangeCwsToken(env, fetchImpl, cwd);
  const zipBytes = fs.readFileSync(cfg.zipPath);

  log(`[Chrome] Uploading ${path.basename(cfg.zipPath)} (${zipBytes.length} bytes)...`);
  const uploadRes = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
    },
    body: zipBytes,
  });
  const uploadParsed = await readJsonSafe(uploadRes);
  if (!uploadRes.ok) {
    throw new Error(
      `Chrome upload failed (${uploadRes.status}): ${uploadParsed.raw || uploadRes.statusText}`
    );
  }
  log('[Chrome] Upload response:', JSON.stringify(uploadParsed.data));

  const statusRes = await fetchImpl(statusUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (statusRes.ok) {
    const statusParsed = await readJsonSafe(statusRes);
    log('[Chrome] Item status:', JSON.stringify(statusParsed.data));
  }

  log(`[Chrome] Submitting for review (${publishType})...`);
  const pubRes = await fetchImpl(publishUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ publishType }),
  });
  const pubParsed = await readJsonSafe(pubRes);
  if (!pubRes.ok) {
    throw new Error(
      `Chrome publish failed (${pubRes.status}): ${pubParsed.raw || pubRes.statusText}`
    );
  }
  log('[Chrome] Submitted:', JSON.stringify(pubParsed.data));
  return { ok: true, upload: uploadParsed.data, publish: pubParsed.data };
}

/**
 * Upload, validate, and submit a package via Mozilla AMO API v5.
 */
export async function publishFirefox(
  {
    env,
    manifest,
    metadata,
    privacyPolicyText = '',
    dryRun = false,
    channel = 'listed',
    pollIntervalMs = 2500,
    maxPollAttempts = 40,
    cwd = process.cwd(),
  },
  {
    fetchImpl = globalThis.fetch,
    sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = console.log,
  } = {}
) {
  const cfg = resolveTargetConfig('firefox', env, manifest, cwd);
  if (!cfg.zipExists) {
    throw new Error(`Firefox package missing: ${cfg.zipPath}. Run "npm run package" first.`);
  }

  const uploadUrl = `${AMO_API_BASE}/addons/upload/`;
  const addonUrl = `${AMO_API_BASE}/addons/addon/${encodeURIComponent(cfg.geckoId)}/`;

  if (dryRun) {
    log('[DRY-RUN][Firefox] Package verified:', cfg.zipPath);
    log('[DRY-RUN][Firefox] Upload URL:', uploadUrl, `(channel=${channel})`);
    log('[DRY-RUN][Firefox] Addon Lookup URL:', addonUrl);
    log(
      '[DRY-RUN][Firefox] Credentials status:',
      cfg.hasAuth ? 'READY' : `MISSING [${cfg.missingCredentials.join(', ')}]`
    );
    return {
      ok: true,
      dryRun: true,
      ready: cfg.hasAuth,
      missingCredentials: cfg.missingCredentials,
    };
  }

  if (!cfg.hasAuth) {
    throw new Error(`Missing Firefox AMO credentials: ${cfg.missingCredentials.join(', ')}`);
  }

  const jwt = createAmoJwt(env.AMO_JWT_ISSUER, env.AMO_JWT_SECRET);
  const authHeaders = { Authorization: `JWT ${jwt}` };

  const zipBytes = fs.readFileSync(cfg.zipPath);
  const form = new FormData();
  form.append(
    'upload',
    new Blob([zipBytes], { type: 'application/zip' }),
    path.basename(cfg.zipPath)
  );
  form.append('channel', channel);

  log(`[Firefox] Uploading ${path.basename(cfg.zipPath)} to AMO (${channel})...`);
  const uploadRes = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: authHeaders,
    body: form,
  });
  const uploadParsed = await readJsonSafe(uploadRes);
  if (!uploadRes.ok || !uploadParsed.data?.uuid) {
    throw new Error(
      `AMO upload failed (${uploadRes.status}): ${uploadParsed.raw || uploadRes.statusText}`
    );
  }

  const uploadUuid = uploadParsed.data.uuid;
  const pollUrl = `${AMO_API_BASE}/addons/upload/${encodeURIComponent(uploadUuid)}/`;
  let validationState = uploadParsed.data;

  for (let i = 0; i < maxPollAttempts && !validationState.processed; i++) {
    await sleepImpl(pollIntervalMs);
    const pollRes = await fetchImpl(pollUrl, { headers: authHeaders });
    const pollParsed = await readJsonSafe(pollRes);
    if (!pollRes.ok) {
      throw new Error(`AMO validation poll failed (${pollRes.status}): ${pollParsed.raw}`);
    }
    validationState = pollParsed.data;
  }

  if (!validationState.processed) {
    throw new Error(`AMO validation timed out for upload ${uploadUuid}`);
  }
  if (!validationState.valid) {
    throw new Error(
      `AMO validation failed for ${uploadUuid}: ${JSON.stringify(validationState.validation)}`
    );
  }
  log(`[Firefox] Validation passed (upload=${uploadUuid})`);

  const existingRes = await fetchImpl(addonUrl, { headers: authHeaders });
  const isInitialCreate = existingRes.status === 404;
  if (!isInitialCreate && !existingRes.ok) {
    const existingErr = await readJsonSafe(existingRes);
    throw new Error(`AMO addon lookup failed (${existingRes.status}): ${existingErr.raw}`);
  }

  const submitUrl = isInitialCreate
    ? `${AMO_API_BASE}/addons/addon/`
    : `${AMO_API_BASE}/addons/addon/${encodeURIComponent(cfg.geckoId)}/versions/`;
  const payload = buildAmoVersionPayload(uploadUuid, metadata, isInitialCreate, privacyPolicyText);

  log(
    `[Firefox] Submitting ${isInitialCreate ? 'initial listing + version' : 'new version'} to ${submitUrl}...`
  );
  const freshJwt = createAmoJwt(env.AMO_JWT_ISSUER, env.AMO_JWT_SECRET);
  const submitRes = await fetchImpl(submitUrl, {
    method: 'POST',
    headers: {
      Authorization: `JWT ${freshJwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const submitParsed = await readJsonSafe(submitRes);
  if (!submitRes.ok) {
    throw new Error(
      `AMO submission failed (${submitRes.status}): ${submitParsed.raw || submitRes.statusText}`
    );
  }
  log('[Firefox] Submitted successfully:', JSON.stringify(submitParsed.data));
  return { ok: true, initialCreate: isInitialCreate, submission: submitParsed.data };
}

function parseCliArgs(argv) {
  const args = { target: 'all', dryRun: false, staged: false, channel: 'listed' };
  for (const token of argv) {
    if (token.startsWith('--target=')) {
      args.target = token.slice('--target='.length).toLowerCase();
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token === '--staged') {
      args.staged = true;
    } else if (token === '--unlisted') {
      args.channel = 'unlisted';
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  const env = loadEnv();
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  const metadata = JSON.parse(
    fs.readFileSync(path.resolve('scripts', 'amo-metadata.json'), 'utf8')
  );
  let privacyPolicyText = '';
  if (fs.existsSync('privacy-policy.md')) {
    privacyPolicyText = fs
      .readFileSync('privacy-policy.md', 'utf8')
      .replace(/^<!--[\s\S]*?-->\s*/u, '');
  }

  const targets = args.target === 'all' ? ['chrome', 'firefox'] : [args.target];
  for (const t of targets) {
    if (t !== 'chrome' && t !== 'firefox') {
      throw new Error(`Invalid target "${t}". Use --target=chrome|firefox|all`);
    }
  }

  for (const t of targets) {
    if (t === 'chrome') {
      await publishChrome({ env, manifest, dryRun: args.dryRun, staged: args.staged });
    } else {
      await publishFirefox({
        env,
        manifest,
        metadata,
        privacyPolicyText,
        dryRun: args.dryRun,
        channel: args.channel,
      });
    }
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(`\n[Publish ERROR] ${err.message}`);
    process.exit(1);
  });
}
