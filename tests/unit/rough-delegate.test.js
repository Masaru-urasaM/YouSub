import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { _internals } from '../../src/background/translator.js';

const { buildRoughTranslateDelegate, ROUGH_DELEGATE_TIMEOUT_MS } = _internals;

/**
 * Phase B-d — buildRoughTranslateDelegate: the service-worker side of MergeFixer's
 * rough back-translation. It returns undefined (so MergeFixer.fix uses its in-worker
 * RoughTranslator seam) when delegation is impossible, or an async delegate that
 * round-trips to the content script via browser.tabs.sendMessage and honors the
 * RoughTranslator contract: resolves to Array<string|null> of length === texts.length
 * and NEVER rejects.
 *
 * browser.tabs.sendMessage is reassigned per test (not the shared mock). Fake timers
 * are used so the internal ROUGH_DELEGATE_TIMEOUT_MS race is deterministic and no real
 * 3s timer lingers past a test.
 */
let originalSendMessage;

beforeEach(() => {
  jest.useFakeTimers();
  originalSendMessage = browser.tabs.sendMessage;
});

afterEach(() => {
  browser.tabs.sendMessage = originalSendMessage;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('buildRoughTranslateDelegate — gating', () => {
  test('returns undefined when the source language is "auto"', () => {
    expect(buildRoughTranslateDelegate(7, 'auto')).toBeUndefined();
  });

  test('returns undefined when there is no tabId', () => {
    expect(buildRoughTranslateDelegate(null, 'en')).toBeUndefined();
    expect(buildRoughTranslateDelegate(0, 'en')).toBeUndefined();
    expect(buildRoughTranslateDelegate(undefined, 'en')).toBeUndefined();
  });

  test('returns undefined when the source language is missing', () => {
    expect(buildRoughTranslateDelegate(7, '')).toBeUndefined();
    expect(buildRoughTranslateDelegate(7, undefined)).toBeUndefined();
  });

  test('returns a function for a real tabId + concrete source language', () => {
    expect(typeof buildRoughTranslateDelegate(7, 'en')).toBe('function');
  });

  test('does not call tabs.sendMessage when gated off (undefined delegate)', () => {
    browser.tabs.sendMessage = jest.fn(() => Promise.resolve());
    // Gated cases produce no delegate, so nothing can post.
    buildRoughTranslateDelegate(null, 'en');
    buildRoughTranslateDelegate(7, 'auto');
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe('buildRoughTranslateDelegate — delegate behavior', () => {
  test('posts the correct envelope and resolves the translations', async () => {
    browser.tabs.sendMessage = jest.fn(() =>
      Promise.resolve({ translations: ['Xin chào', 'Thế giới'] })
    );
    const delegate = buildRoughTranslateDelegate(42, 'en');

    const result = await delegate(['Hello', 'World'], 'en', 'vi');

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(42, {
      type: 'YOUSUB_ROUGH_TRANSLATE',
      texts: ['Hello', 'World'],
      src: 'en',
      tgt: 'vi',
    });
    expect(result).toEqual(['Xin chào', 'Thế giới']);
  });

  test('coerces a mismatched-length response to all-null', async () => {
    browser.tabs.sendMessage = jest.fn(() => Promise.resolve({ translations: ['only-one'] }));
    const delegate = buildRoughTranslateDelegate(42, 'en');

    await expect(delegate(['a', 'b'], 'en', 'vi')).resolves.toEqual([null, null]);
  });

  test('coerces a response with no translations array to all-null', async () => {
    const delegate = buildRoughTranslateDelegate(42, 'en');

    browser.tabs.sendMessage = jest.fn(() => Promise.resolve(undefined));
    await expect(delegate(['a', 'b'], 'en', 'vi')).resolves.toEqual([null, null]);

    browser.tabs.sendMessage = jest.fn(() => Promise.resolve({}));
    await expect(delegate(['a', 'b'], 'en', 'vi')).resolves.toEqual([null, null]);

    browser.tabs.sendMessage = jest.fn(() => Promise.resolve({ translations: 'nope' }));
    await expect(delegate(['a', 'b'], 'en', 'vi')).resolves.toEqual([null, null]);
  });

  test('degrades to all-null (never rejects) when tabs.sendMessage rejects', async () => {
    browser.tabs.sendMessage = jest.fn(() => Promise.reject(new Error('no receiving end')));
    const delegate = buildRoughTranslateDelegate(42, 'en');

    await expect(delegate(['a', 'b', 'c'], 'en', 'vi')).resolves.toEqual([null, null, null]);
  });

  test('times out to all-null when the content side never responds', async () => {
    browser.tabs.sendMessage = jest.fn(() => new Promise(() => {})); // never resolves
    const delegate = buildRoughTranslateDelegate(42, 'en');

    const p = delegate(['a', 'b'], 'en', 'vi');
    await jest.advanceTimersByTimeAsync(ROUGH_DELEGATE_TIMEOUT_MS);

    await expect(p).resolves.toEqual([null, null]);
  });

  test('passes through the src/tgt it is called with (not the build-time src)', async () => {
    browser.tabs.sendMessage = jest.fn(() => Promise.resolve({ translations: ['x'] }));
    const delegate = buildRoughTranslateDelegate(42, 'en');

    await delegate(['one'], 'ja', 'vi'); // called with a different src than built with

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(42, {
      type: 'YOUSUB_ROUGH_TRANSLATE',
      texts: ['one'],
      src: 'ja',
      tgt: 'vi',
    });
  });
});
