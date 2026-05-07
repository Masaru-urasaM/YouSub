import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { RoughTranslator, _internals } from '../../src/background/rough-translator.js';

const { _pairAvailability, _translatorInstances } = _internals;

let originalFetch;

beforeEach(() => {
  jest.clearAllMocks();
  _pairAvailability.clear();
  _translatorInstances.clear();
  delete self.translation;
  delete self.ai;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete self.translation;
  delete self.ai;
});

// ─── Tier 1: Chrome Translator API ──────────────────────────

describe('Tier 1: Chrome Translator API', () => {
  test('uses Chrome Translator when available (translation.canTranslate)', async () => {
    const mockTranslator = { translate: jest.fn(async () => 'Xin chao') };
    self.translation = {
      canTranslate: jest.fn(async () => 'readily'),
      createTranslator: jest.fn(async () => mockTranslator)
    };
    globalThis.fetch = jest.fn();

    const result = await RoughTranslator.translate('Hello', 'en', 'vi');

    expect(result).toBe('Xin chao');
    expect(mockTranslator.translate).toHaveBeenCalledWith('Hello');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('uses Chrome Translator via ai.translator namespace', async () => {
    const mockTranslator = { translate: jest.fn(async () => 'Bonjour') };
    self.ai = {
      translator: {
        capabilities: jest.fn(async () => ({
          languagePairAvailable: jest.fn(() => 'readily')
        })),
        create: jest.fn(async () => mockTranslator)
      }
    };
    globalThis.fetch = jest.fn();

    const result = await RoughTranslator.translate('Hello', 'en', 'fr');

    expect(result).toBe('Bonjour');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('accepts after-download status as available', async () => {
    const mockTranslator = { translate: jest.fn(async () => 'Hola') };
    self.translation = {
      canTranslate: jest.fn(async () => 'after-download'),
      createTranslator: jest.fn(async () => mockTranslator)
    };
    globalThis.fetch = jest.fn();

    const result = await RoughTranslator.translate('Hello', 'en', 'es');

    expect(result).toBe('Hola');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('caches availability per language pair', async () => {
    const canTranslate = jest.fn(async () => 'readily');
    const mockTranslator = { translate: jest.fn(async () => 'OK') };
    self.translation = {
      canTranslate,
      createTranslator: jest.fn(async () => mockTranslator)
    };
    globalThis.fetch = jest.fn();

    await RoughTranslator.translate('Hello', 'en', 'vi');
    await RoughTranslator.translate('World', 'en', 'vi');

    expect(canTranslate).toHaveBeenCalledTimes(1);
  });

  test('caches translator instances per language pair', async () => {
    const mockTranslator = { translate: jest.fn(async () => 'OK') };
    const createTranslator = jest.fn(async () => mockTranslator);
    self.translation = {
      canTranslate: jest.fn(async () => 'readily'),
      createTranslator
    };
    globalThis.fetch = jest.fn();

    await RoughTranslator.translate('Hello', 'en', 'vi');
    await RoughTranslator.translate('World', 'en', 'vi');

    expect(createTranslator).toHaveBeenCalledTimes(1);
  });

  test('falls back to Google when Chrome Translator fails for a text', async () => {
    const mockTranslator = { translate: jest.fn(async () => { throw new Error('model error'); }) };
    self.translation = {
      canTranslate: jest.fn(async () => 'readily'),
      createTranslator: jest.fn(async () => mockTranslator)
    };
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [[['Xin chao']]]
    }));

    const result = await RoughTranslator.translate('Hello', 'en', 'vi');

    expect(result).toBe('Xin chao');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

// ─── Tier 2: Google Translate Fallback ──────────────────────

describe('Tier 2: Google Translate fallback', () => {
  test('uses Google when Chrome Translator unavailable', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [[['Xin chao']]]
    }));

    const result = await RoughTranslator.translate('Hello', 'en', 'vi');

    expect(result).toBe('Xin chao');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test('uses Google when canTranslate returns no', async () => {
    self.translation = {
      canTranslate: jest.fn(async () => 'no'),
      createTranslator: jest.fn()
    };
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [[['Hola']]]
    }));

    const result = await RoughTranslator.translate('Hello', 'en', 'es');

    expect(result).toBe('Hola');
    expect(self.translation.createTranslator).not.toHaveBeenCalled();
  });

  test('returns null when Google returns non-OK status', async () => {
    globalThis.fetch = jest.fn(async () => ({ ok: false, status: 429 }));

    const result = await RoughTranslator.translate('Hello', 'en', 'vi');

    expect(result).toBeNull();
  });
});

// ─── Tier 3: Both fail ─────────────────────────────────────

describe('Tier 3: both tiers fail', () => {
  test('returns null when both Chrome and Google fail', async () => {
    const mockTranslator = { translate: jest.fn(async () => { throw new Error('fail'); }) };
    self.translation = {
      canTranslate: jest.fn(async () => 'readily'),
      createTranslator: jest.fn(async () => mockTranslator)
    };
    globalThis.fetch = jest.fn(async () => { throw new Error('network error'); });

    const result = await RoughTranslator.translate('Hello', 'en', 'vi');

    expect(result).toBeNull();
  });

  test('returns null for empty input', async () => {
    expect(await RoughTranslator.translate('', 'en', 'vi')).toBeNull();
    expect(await RoughTranslator.translate('   ', 'en', 'vi')).toBeNull();
    expect(await RoughTranslator.translate(null, 'en', 'vi')).toBeNull();
  });
});

// ─── translateBatch ─────────────────────────────────────────

describe('translateBatch', () => {
  test('returns array of correct length with mixed results', async () => {
    let callCount = 0;
    globalThis.fetch = jest.fn(async () => {
      callCount++;
      if (callCount === 2) throw new Error('fail');
      return { ok: true, json: async () => [[['result']]] };
    });

    const results = await RoughTranslator.translateBatch(
      ['Hello', 'World', 'Test'], 'en', 'vi'
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toBe('result');
    expect(results[1]).toBeNull();
    expect(results[2]).toBe('result');
  });

  test('returns all nulls when all translations fail', async () => {
    globalThis.fetch = jest.fn(async () => { throw new Error('fail'); });

    const results = await RoughTranslator.translateBatch(
      ['A', 'B'], 'en', 'vi'
    );

    expect(results).toEqual([null, null]);
  });

  test('handles empty array', async () => {
    const results = await RoughTranslator.translateBatch([], 'en', 'vi');
    expect(results).toEqual([]);
  });
});
