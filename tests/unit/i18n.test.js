import { describe, test, expect, beforeAll } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyI18n } from '../../src/shared/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EN_PATH = path.resolve(__dirname, '../../_locales/en/messages.json');
const JA_PATH = path.resolve(__dirname, '../../_locales/ja/messages.json');

describe('_locales message catalogs', () => {
  let en;
  let ja;

  beforeAll(() => {
    en = JSON.parse(fs.readFileSync(EN_PATH, 'utf8'));
    ja = JSON.parse(fs.readFileSync(JA_PATH, 'utf8'));
  });

  test('both locale files are valid JSON objects', () => {
    expect(typeof en).toBe('object');
    expect(typeof ja).toBe('object');
    expect(Object.keys(en).length).toBeGreaterThan(0);
  });

  test('EN and JA have the IDENTICAL set of keys (no missing/extra either way)', () => {
    const enKeys = Object.keys(en).sort();
    const jaKeys = Object.keys(ja).sort();

    const missingInJa = enKeys.filter((k) => !(k in ja));
    const extraInJa = jaKeys.filter((k) => !(k in en));

    expect(missingInJa).toEqual([]);
    expect(extraInJa).toEqual([]);
    expect(jaKeys).toEqual(enKeys);
  });

  test('every entry in both locales has a non-empty string message', () => {
    [
      ['en', en],
      ['ja', ja],
    ].forEach(([name, catalog]) => {
      Object.entries(catalog).forEach(([key, entry]) => {
        expect(typeof entry.message).toBe(`string`);
        expect(entry.message.trim().length).toBeGreaterThan(0);
        expect(`${name}:${key}`).toBeTruthy();
      });
    });
  });

  test('every $NAME$-bearing message declares a matching placeholders block in BOTH locales', () => {
    // Chrome treats `$` as special: a $NAME$ token with no `placeholders` block
    // renders blank at runtime. Any such token MUST therefore be declared.
    // (The `{index}` style token used for the backup-key label is intentionally
    // NOT a Chrome placeholder — it is substituted manually in JS — so it is
    // correctly ignored by this guard.)
    const NAMED = /\$[A-Za-z][A-Za-z0-9_]*\$/;
    Object.keys(en).forEach((key) => {
      [
        ['en', en],
        ['ja', ja],
      ].forEach(([name, catalog]) => {
        if (NAMED.test(catalog[key].message)) {
          expect(`${name}:${key} placeholders`).toBe(`${name}:${key} placeholders`);
          expect(catalog[key].placeholders).toBeDefined();
        }
      });
      // If EN declares placeholders, JA must declare the same named set.
      if (en[key].placeholders) {
        expect(ja[key].placeholders).toBeDefined();
        expect(Object.keys(ja[key].placeholders).sort()).toEqual(
          Object.keys(en[key].placeholders).sort()
        );
      }
    });
  });
});

describe('applyI18n DOM localization', () => {
  test('sets textContent from the mocked getMessage for [data-i18n] elements', () => {
    document.body.innerHTML = `
      <div id="t1" data-i18n="optionsTabTranslation">RAW</div>
      <button id="t2" data-i18n="popupSettingsBtn">RAW</button>
    `;

    applyI18n(document);

    const expected1 = chrome.i18n.getMessage('optionsTabTranslation');
    const expected2 = chrome.i18n.getMessage('popupSettingsBtn');
    expect(expected1).toBeTruthy();
    expect(document.getElementById('t1').textContent).toBe(expected1);
    expect(document.getElementById('t2').textContent).toBe(expected2);
  });

  test('sets attribute variants (placeholder / aria-label / title)', () => {
    document.body.innerHTML = `
      <input id="p1" data-i18n-placeholder="optionsRowApiKeyPlaceholder" placeholder="RAW" />
      <button id="a1" data-i18n-aria-label="optionsRowDeleteCustomModel" aria-label="RAW"></button>
      <button id="ti1" data-i18n-title="optionsRowResetStatsTitle" title="RAW"></button>
    `;

    applyI18n(document);

    expect(document.getElementById('p1').getAttribute('placeholder')).toBe(
      chrome.i18n.getMessage('optionsRowApiKeyPlaceholder')
    );
    expect(document.getElementById('a1').getAttribute('aria-label')).toBe(
      chrome.i18n.getMessage('optionsRowDeleteCustomModel')
    );
    expect(document.getElementById('ti1').getAttribute('title')).toBe(
      chrome.i18n.getMessage('optionsRowResetStatsTitle')
    );
  });

  test('leaves untagged / missing-key elements untouched (graceful fallback)', () => {
    document.body.innerHTML = `
      <div id="u1">Untouched English</div>
      <div id="u2" data-i18n="thisKeyDoesNotExist">Hardcoded Fallback</div>
    `;

    applyI18n(document);

    expect(document.getElementById('u1').textContent).toBe('Untouched English');
    // Missing key -> getMessage returns '' -> applyI18n must NOT blank it.
    expect(document.getElementById('u2').textContent).toBe('Hardcoded Fallback');
  });

  test('localizes a cloned template fragment (dynamic-row path)', () => {
    document.body.innerHTML = `
      <template id="tpl">
        <label data-i18n="optionsRowProvider">Provider</label>
      </template>
    `;
    const tpl = document.getElementById('tpl');
    const clone = tpl.content.cloneNode(true);
    applyI18n(clone);
    expect(clone.querySelector('label').textContent).toBe(
      chrome.i18n.getMessage('optionsRowProvider')
    );
  });
});
