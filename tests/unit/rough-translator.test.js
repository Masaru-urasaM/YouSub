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
  // RoughTranslator must NEVER reach the network: it is on-device only, with no
  // third-party fallback (privacy). Any fetch call is a regression.
  globalThis.fetch = jest.fn(() => {
    throw new Error('RoughTranslator must not perform any network request');
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete self.translation;
  delete self.ai;
});

// ─── Chrome on-device Translator ────────────────────────────

describe('Chrome on-device Translator', () => {
  test('uses Chrome Translator when available (translation.canTranslate)', async () => {
    const mockTranslator = { translate: jest.fn(async () => 'Xin chao') };
    self.translation = {
      canTranslate: jest.fn(async () => 'readily'),
      createTranslator: jest.fn(async () => mockTranslator),
    };

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
          languagePairAvailable: jest.fn(() => 'readily'),
        })),
        create: jest.fn(async () => mockTranslator),
      },
    };

    const result = await RoughTranslator.translate('Hello', 'en', 'fr');

    expect(result).toBe('Bonjour');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('accepts after-download status as available', async () => {
    const mockTranslator = { translate: jest.fn(async () => 'Hola') };
    self.translation = {
      canTranslate: jest.fn(async () => 'after-download'),
      createTranslator: jest.fn(async () => mockTranslator),
    };

    const result = await RoughTranslator.translate('Hello', 'en', 'es');

    expect(result).toBe('Hola');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('caches availability per language pair', async () => {
    const canTranslate = jest.fn(async () => 'readily');
    const mockTranslator = { translate: jest.fn(async () => 'OK') };
    self.translation = {
      canTranslate,
      createTranslator: jest.fn(async () => mockTranslator),
    };

    await RoughTranslator.translate('Hello', 'en', 'vi');
    await RoughTranslator.translate('World', 'en', 'vi');

    expect(canTranslate).toHaveBeenCalledTimes(1);
  });

  test('caches translator instances per language pair', async () => {
    const mockTranslator = { translate: jest.fn(async () => 'OK') };
    const createTranslator = jest.fn(async () => mockTranslator);
    self.translation = {
      canTranslate: jest.fn(async () => 'readily'),
      createTranslator,
    };

    await RoughTranslator.translate('Hello', 'en', 'vi');
    await RoughTranslator.translate('World', 'en', 'vi');

    expect(createTranslator).toHaveBeenCalledTimes(1);
  });

  test('returns null when on-device translation yields an empty result', async () => {
    const mockTranslator = { translate: jest.fn(async () => '') };
    self.translation = {
      canTranslate: jest.fn(async () => 'readily'),
      createTranslator: jest.fn(async () => mockTranslator),
    };

    const result = await RoughTranslator.translate('Hello', 'en', 'vi');

    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('returns null when the translator cannot be created', async () => {
    self.translation = {
      canTranslate: jest.fn(async () => 'readily'),
      createTranslator: jest.fn(async () => null),
    };

    const result = await RoughTranslator.translate('Hello', 'en', 'vi');

    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ─── No network fallback (privacy) ──────────────────────────

describe('No network fallback (privacy)', () => {
  test('returns null when on-device Translator is unavailable, never calls network', async () => {
    // No self.translation / self.ai → availability check returns false.
    const result = await RoughTranslator.translate('Hello', 'en', 'vi');

    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('returns null when canTranslate reports "no", never creates a translator or calls network', async () => {
    self.translation = {
      canTranslate: jest.fn(async () => 'no'),
      createTranslator: jest.fn(),
    };

    const result = await RoughTranslator.translate('Hello', 'en', 'es');

    expect(result).toBeNull();
    expect(self.translation.createTranslator).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('returns null when on-device translation throws, with no network fallback', async () => {
    const mockTranslator = {
      translate: jest.fn(async () => {
        throw new Error('model error');
      }),
    };
    self.translation = {
      canTranslate: jest.fn(async () => 'readily'),
      createTranslator: jest.fn(async () => mockTranslator),
    };

    const result = await RoughTranslator.translate('Hello', 'en', 'vi');

    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
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
    const mockTranslator = {
      translate: jest.fn(async (text) => {
        if (text === 'World') throw new Error('fail');
        return `t:${text}`;
      }),
    };
    self.translation = {
      canTranslate: jest.fn(async () => 'readily'),
      createTranslator: jest.fn(async () => mockTranslator),
    };

    const results = await RoughTranslator.translateBatch(['Hello', 'World', 'Test'], 'en', 'vi');

    expect(results).toHaveLength(3);
    expect(results[0]).toBe('t:Hello');
    expect(results[1]).toBeNull();
    expect(results[2]).toBe('t:Test');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('returns all nulls when on-device translation is unavailable', async () => {
    const results = await RoughTranslator.translateBatch(['A', 'B'], 'en', 'vi');

    expect(results).toEqual([null, null]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('preserves order for all-successful translations', async () => {
    const mockTranslator = { translate: jest.fn(async (text) => `t:${text}`) };
    self.translation = {
      canTranslate: jest.fn(async () => 'readily'),
      createTranslator: jest.fn(async () => mockTranslator),
    };

    const results = await RoughTranslator.translateBatch(['A', 'B', 'C'], 'en', 'vi');

    expect(results).toEqual(['t:A', 't:B', 't:C']);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('handles empty array', async () => {
    const results = await RoughTranslator.translateBatch([], 'en', 'vi');
    expect(results).toEqual([]);
  });
});
