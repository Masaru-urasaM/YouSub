import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// The bridge holds module-level state (injection flag, pending map, id counter),
// so re-import a fresh copy per test via jest.resetModules() for isolation.
let RoughTranslateBridge;

function dispatchResponse(requestId, translations, opts = {}) {
  const source = 'source' in opts ? opts.source : window;
  const type = 'type' in opts ? opts.type : 'YOUSUB_ROUGH_TRANSLATE_RESPONSE';
  const event = new Event('message');
  Object.defineProperty(event, 'source', { value: source, configurable: true });
  Object.defineProperty(event, 'data', {
    value: { type, requestId, translations },
    configurable: true,
  });
  window.dispatchEvent(event);
}

function lastRequest(postSpy) {
  return postSpy.mock.calls
    .map((c) => c[0])
    .find((m) => m && m.type === 'YOUSUB_ROUGH_TRANSLATE_REQUEST');
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.resetModules();
  ({ RoughTranslateBridge } = await import('../../src/content/rough-translate-bridge.js'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('RoughTranslateBridge.translateBatch', () => {
  test('empty batch resolves [] with no injection or postMessage', async () => {
    const postSpy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});

    const result = await RoughTranslateBridge.translateBatch([], 'en', 'vi');

    expect(result).toEqual([]);
    expect(chrome.runtime.getURL).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test('injects the main-world translator once (idempotent)', () => {
    jest.useFakeTimers();
    jest.spyOn(window, 'postMessage').mockImplementation(() => {});

    RoughTranslateBridge.translateBatch(['a'], 'en', 'vi');
    RoughTranslateBridge.translateBatch(['b'], 'en', 'vi');

    expect(chrome.runtime.getURL).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.getURL).toHaveBeenCalledWith('src/content/main-world-translator.js');
  });

  test('posts a correlated request and resolves translations in order', async () => {
    jest.useFakeTimers();
    const postSpy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});

    const p = RoughTranslateBridge.translateBatch(['Hello', 'World'], 'en', 'vi');
    jest.advanceTimersByTime(50); // fire the deferred post

    const req = lastRequest(postSpy);
    expect(req).toMatchObject({ texts: ['Hello', 'World'], src: 'en', tgt: 'vi' });
    expect(typeof req.requestId).toBe('string');

    dispatchResponse(req.requestId, ['Xin chào', 'Thế giới']);

    await expect(p).resolves.toEqual(['Xin chào', 'Thế giới']);
  });

  test('ignores responses with wrong requestId, type, or source', async () => {
    jest.useFakeTimers();
    const postSpy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});

    const p = RoughTranslateBridge.translateBatch(['a', 'b'], 'en', 'vi');
    jest.advanceTimersByTime(50);
    const req = lastRequest(postSpy);

    dispatchResponse('wrong-id', ['X', 'Y']); // wrong requestId
    dispatchResponse(req.requestId, ['X', 'Y'], { type: 'SOMETHING_ELSE' }); // wrong type
    dispatchResponse(req.requestId, ['X', 'Y'], { source: {} }); // wrong source

    jest.advanceTimersByTime(2500); // none matched → timeout to all-null

    await expect(p).resolves.toEqual([null, null]);
  });

  test('times out to all-null (never rejects) when no response arrives', async () => {
    jest.useFakeTimers();
    jest.spyOn(window, 'postMessage').mockImplementation(() => {});

    const p = RoughTranslateBridge.translateBatch(['a', 'b', 'c'], 'en', 'vi');
    jest.advanceTimersByTime(50 + 2500);

    await expect(p).resolves.toEqual([null, null, null]);
  });

  test('coerces a mismatched-length response to all-null', async () => {
    jest.useFakeTimers();
    const postSpy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});

    const p = RoughTranslateBridge.translateBatch(['a', 'b'], 'en', 'vi');
    jest.advanceTimersByTime(50);
    const req = lastRequest(postSpy);

    dispatchResponse(req.requestId, ['only-one']); // length 1 ≠ 2

    await expect(p).resolves.toEqual([null, null]);
  });
});
