import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// chrome mock auto-loads via jest.config.js setupFilesAfterEach.
//
// TrustedTypes holds a module-level `policy` singleton that init() sets exactly
// once (guarded by `if (policy) return`). There is no exported reset, so to test
// each branch in isolation we reload the module fresh with jest.resetModules() +
// dynamic import(). window.trustedTypes is undefined in jsdom, so we stub it to
// drive the "policy created" branch.

async function loadFresh() {
  jest.resetModules();
  const mod = await import('../../src/shared/trusted-types.js');
  return mod.TrustedTypes;
}

describe('TrustedTypes', () => {
  const originalTrustedTypes = window.trustedTypes;

  beforeEach(() => {
    delete window.trustedTypes;
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (originalTrustedTypes === undefined) {
      delete window.trustedTypes;
    } else {
      window.trustedTypes = originalTrustedTypes;
    }
  });

  describe('No Trusted Types support (jsdom default)', () => {
    test('init() is a no-op and toSafeHTML() passes the string through unchanged', async () => {
      const TrustedTypes = await loadFresh();
      expect(() => TrustedTypes.init()).not.toThrow();

      const html = '<b>hello</b>';
      expect(TrustedTypes.toSafeHTML(html)).toBe(html);
    });

    test('toSafeHTML() passthrough works even without calling init()', async () => {
      const TrustedTypes = await loadFresh();
      expect(TrustedTypes.toSafeHTML('plain')).toBe('plain');
    });
  });

  describe('Trusted Types available', () => {
    test('init() creates the yousub-policy and toSafeHTML() routes through createHTML', async () => {
      const createHTML = jest.fn((html) => ({ wrapped: html }));
      const createPolicy = jest.fn(() => ({ createHTML }));
      window.trustedTypes = { createPolicy };

      const TrustedTypes = await loadFresh();
      TrustedTypes.init();

      expect(createPolicy).toHaveBeenCalledTimes(1);
      expect(createPolicy).toHaveBeenCalledWith('yousub-policy', expect.any(Object));

      const result = TrustedTypes.toSafeHTML('<i>x</i>');
      expect(createHTML).toHaveBeenCalledWith('<i>x</i>');
      expect(result).toEqual({ wrapped: '<i>x</i>' });
    });

    test('the created policy passes HTML/script/scriptURL through unchanged', async () => {
      let capturedRules = null;
      const createPolicy = jest.fn((name, rules) => {
        capturedRules = rules;
        return { createHTML: rules.createHTML };
      });
      window.trustedTypes = { createPolicy };

      const TrustedTypes = await loadFresh();
      TrustedTypes.init();

      expect(capturedRules.createHTML('<p>a</p>')).toBe('<p>a</p>');
      expect(capturedRules.createScript('var x = 1;')).toBe('var x = 1;');
      expect(capturedRules.createScriptURL('https://e.com/s.js')).toBe('https://e.com/s.js');
    });

    test('init() is idempotent — a second call does not recreate the policy', async () => {
      const createPolicy = jest.fn(() => ({ createHTML: (h) => h }));
      window.trustedTypes = { createPolicy };

      const TrustedTypes = await loadFresh();
      TrustedTypes.init();
      TrustedTypes.init();

      expect(createPolicy).toHaveBeenCalledTimes(1);
    });

    test('init() swallows a createPolicy failure and toSafeHTML() falls back to passthrough', async () => {
      const createPolicy = jest.fn(() => {
        throw new Error('duplicate policy name');
      });
      window.trustedTypes = { createPolicy };

      const TrustedTypes = await loadFresh();
      expect(() => TrustedTypes.init()).not.toThrow();

      // policy stayed null -> toSafeHTML returns the raw string.
      expect(TrustedTypes.toSafeHTML('<span>e</span>')).toBe('<span>e</span>');
    });
  });
});
