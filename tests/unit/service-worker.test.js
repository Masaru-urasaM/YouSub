import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests for src/background/service-worker.js (message + streaming port routers).
 */

const mockTranslate = jest.fn();
const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
  hasAnyForVideoTarget: jest.fn(),
  removeByVideoId: jest.fn(),
  clearAll: jest.fn(),
};
const mockProviders = {
  testApiKey: jest.fn(),
};
const mockHealthManager = {
  getSummary: jest.fn(),
};

jest.unstable_mockModule('../../src/shared/libs/browser-polyfill.js', () => ({}));
jest.unstable_mockModule('../../src/background/translator.js', () => ({
  translate: mockTranslate,
}));
jest.unstable_mockModule('../../src/background/cache.js', () => ({
  Cache: mockCache,
}));
jest.unstable_mockModule('../../src/background/providers.js', () => ({
  Providers: mockProviders,
}));
jest.unstable_mockModule('../../src/background/health.js', () => ({
  HealthManager: mockHealthManager,
}));

await import('../../src/background/service-worker.js');

const onMessageHandler = browser.runtime.onMessage._listeners[0];
const onConnectHandler = browser.runtime.onConnect._listeners[0];

function sendMessageAsync(request, sender = { tab: { id: 7 } }) {
  return new Promise((resolve) => {
    const keepOpen = onMessageHandler(request, sender, resolve);
    expect(keepOpen).toBe(true);
  });
}

function makePort(name = 'yousub-stream', tabId = 9) {
  const msgListeners = [];
  const discListeners = [];
  return {
    name,
    sender: tabId != null ? { tab: { id: tabId } } : {},
    postMessage: jest.fn(),
    onMessage: { addListener: (fn) => msgListeners.push(fn) },
    onDisconnect: { addListener: (fn) => discListeners.push(fn) },
    emitMessage: (msg) => Promise.all(msgListeners.map((fn) => fn(msg))),
    emitDisconnect: () => discListeners.forEach((fn) => fn()),
  };
}

describe('service-worker.js routers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    browser.storage.local.store = {};
    global.fetch = jest.fn();
  });

  describe('runtime.onMessage router', () => {
    test('YOUSUB_TRANSLATE_REQUEST returns cached result on HIT and writes cache stats', async () => {
      mockCache.get.mockResolvedValue(['cached-1']);

      const res = await sendMessageAsync({
        type: 'YOUSUB_TRANSLATE_REQUEST',
        videoId: 'v1',
        sourceLang: '',
        targetLang: 'vi',
        segments: [{ text: 'hi', startMs: 0 }],
      });

      expect(mockCache.get).toHaveBeenCalledWith('v1', 'auto', 'vi');
      expect(mockTranslate).not.toHaveBeenCalled();
      expect(res).toEqual({ success: true, translated: ['cached-1'], fromCache: true });
      expect(browser.storage.local.store.yousub_stats_v1.source).toBe('cache');
    });

    test('YOUSUB_TRANSLATE_REQUEST translates on MISS, caches clean result, and stores api stats', async () => {
      mockCache.get.mockResolvedValue(null);
      mockTranslate.mockResolvedValue({
        success: true,
        hadFallback: false,
        translated: ['xin chao'],
        stats: { model: 'gpt-4o', totalTokens: 10, batchCount: 1, durationMs: 200 },
      });

      const res = await sendMessageAsync({
        type: 'YOUSUB_TRANSLATE_REQUEST',
        videoId: 'v2',
        sourceLang: 'en',
        targetLang: 'vi',
        segments: [{ text: 'hello', startMs: 0 }],
      });

      expect(mockCache.set).toHaveBeenCalledWith('v2', 'en', 'vi', ['xin chao']);
      expect(res.success).toBe(true);
      expect(browser.storage.local.store.yousub_stats_v2).toMatchObject({
        source: 'api',
        model: 'gpt-4o',
        totalTokens: 10,
      });
    });

    test('YOUSUB_TRANSLATE_REQUEST skips caching when hadFallback is true or failed', async () => {
      mockCache.get.mockResolvedValue(null);
      mockTranslate.mockResolvedValue({ success: true, hadFallback: true, translated: ['x'] });

      await sendMessageAsync({
        type: 'YOUSUB_TRANSLATE_REQUEST',
        videoId: 'v3',
        sourceLang: 'en',
        targetLang: 'vi',
        segments: [{ text: 'x', startMs: 0 }],
      });
      expect(mockCache.set).not.toHaveBeenCalled();

      mockTranslate.mockResolvedValue({ success: false, failureReason: 'NO_KEYS' });
      const failRes = await sendMessageAsync(
        {
          type: 'YOUSUB_TRANSLATE_REQUEST',
          videoId: 'v4',
          sourceLang: 'en',
          targetLang: 'vi',
          segments: [{ text: 'x', startMs: 0 }],
        },
        {}
      );
      expect(failRes).toEqual({ success: false, failureReason: 'NO_KEYS' });
      expect(browser.storage.local.store.yousub_stats_v4).toBeUndefined();
    });

    test('YOUSUB_FETCH_TEXT fetches with credentials and surfaces HTTP error as BACKGROUND_CRASH', async () => {
      global.fetch.mockResolvedValue({ ok: true, text: async () => '<xml/>' });
      const okRes = await sendMessageAsync({ type: 'YOUSUB_FETCH_TEXT', url: 'https://yt/c' });
      expect(global.fetch).toHaveBeenCalledWith('https://yt/c', { credentials: 'include' });
      expect(okRes).toEqual({ success: true, text: '<xml/>' });

      global.fetch.mockResolvedValue({ ok: false, status: 403 });
      const errRes = await sendMessageAsync({ type: 'YOUSUB_FETCH_TEXT', url: 'https://yt/c' });
      expect(errRes).toEqual({
        success: false,
        failureReason: 'BACKGROUND_CRASH',
        error: 'HTTP 403',
      });
    });

    test('YOUSUB_CHECK_CACHE, CLEAR_VIDEO_CACHE, CLEAR_CACHE dispatch and broadcast', async () => {
      mockCache.hasAnyForVideoTarget.mockResolvedValue(true);
      expect(
        await sendMessageAsync({ type: 'YOUSUB_CHECK_CACHE', videoId: 'v1', targetLang: 'vi' })
      ).toEqual({ exists: true });

      browser.tabs.query.mockResolvedValue([{ id: 11 }, { id: 12 }]);
      expect(await sendMessageAsync({ type: 'YOUSUB_CLEAR_VIDEO_CACHE', videoId: 'v1' })).toEqual({
        success: true,
      });
      expect(mockCache.removeByVideoId).toHaveBeenCalledWith('v1');
      await Promise.resolve();
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(11, {
        type: 'YOUSUB_CACHE_CLEARED',
        videoId: 'v1',
      });

      mockCache.clearAll.mockResolvedValue(5);
      expect(await sendMessageAsync({ type: 'YOUSUB_CLEAR_CACHE' })).toEqual({
        success: true,
        count: 5,
      });
      await Promise.resolve();
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(12, { type: 'YOUSUB_CACHE_CLEARED' });
    });

    test('YOUSUB_TEST_API_KEY, OPEN_SETTINGS, GET_HEALTH_SUMMARY, FETCH_OLLAMA_MODELS, and invalid type', async () => {
      mockProviders.testApiKey.mockResolvedValue({ success: true });
      expect(
        await sendMessageAsync({
          type: 'YOUSUB_TEST_API_KEY',
          provider: 'openai',
          model: 'm',
          apiKey: 'k',
        })
      ).toEqual({ success: true });

      expect(await sendMessageAsync({ type: 'YOUSUB_OPEN_SETTINGS' })).toEqual({ success: true });
      expect(browser.runtime.openOptionsPage).toHaveBeenCalled();

      browser.storage.local.store = { yousub_api_keys: [{ apiKey: 'k1' }] };
      mockHealthManager.getSummary.mockResolvedValue([{ status: 'healthy' }]);
      expect(await sendMessageAsync({ type: 'YOUSUB_GET_HEALTH_SUMMARY' })).toEqual({
        success: true,
        summary: [{ status: 'healthy' }],
      });

      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: 'qwen' }] }),
      });
      expect(
        await sendMessageAsync({
          type: 'YOUSUB_FETCH_OLLAMA_MODELS',
          endpoint: 'http://localhost:11434/api/tags',
        })
      ).toEqual({ success: true, models: [{ name: 'qwen' }] });

      global.fetch.mockResolvedValue({ ok: false, status: 502 });
      expect(
        await sendMessageAsync({
          type: 'YOUSUB_FETCH_OLLAMA_MODELS',
          endpoint: 'http://localhost:11434/api/tags',
        })
      ).toEqual({ success: false, failureReason: 'BACKGROUND_CRASH', error: 'Ollama HTTP 502' });

      expect(await sendMessageAsync({ type: 'UNKNOWN_TYPE' })).toEqual({
        success: false,
        failureReason: 'INVALID_REQUEST_TYPE',
      });
    });
  });

  describe('runtime.onConnect streaming port', () => {
    test('ignores non-yousub-stream ports', () => {
      const port = makePort('other-port');
      onConnectHandler(port);
      expect(port.postMessage).not.toHaveBeenCalled();
    });

    test('responds to PING with PONG and aborts signal on disconnect', async () => {
      const port = makePort('yousub-stream', null);
      onConnectHandler(port);

      await port.emitMessage({ type: 'PING' });
      expect(port.postMessage).toHaveBeenCalledWith({ type: 'PONG' });

      mockCache.get.mockResolvedValue(null);
      let capturedSignal;
      mockTranslate.mockImplementation(async (_seg, _sl, _tl, _tab, _onChunk, signal) => {
        capturedSignal = signal;
        return { success: false, failureReason: 'ABORTED' };
      });

      await port.emitMessage({
        type: 'YOUSUB_TRANSLATE_STREAM',
        segments: [{ text: 'a', startMs: 0 }],
        videoId: 'v-abort',
        sourceLang: 'en',
        targetLang: 'vi',
      });

      expect(capturedSignal.aborted).toBe(false);
      port.emitDisconnect();
      expect(capturedSignal.aborted).toBe(true);
    });

    test('streams CHUNK, PROGRESS, caches on clean COMPLETE, and emits ERROR on failure or throw', async () => {
      const port = makePort('yousub-stream', 42);
      onConnectHandler(port);

      // Cache HIT
      mockCache.get.mockResolvedValue(['cached']);
      await port.emitMessage({
        type: 'YOUSUB_TRANSLATE_STREAM',
        segments: [{ text: 'a', startMs: 0 }],
        videoId: 'v-hit',
        targetLang: 'vi',
      });
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'COMPLETE',
        translated: ['cached'],
        fromCache: true,
      });

      // Cache MISS + CHUNK + PROGRESS + COMPLETE
      port.postMessage.mockClear();
      mockCache.get.mockResolvedValue(null);
      mockTranslate.mockImplementation(
        async (_segs, _sl, _tl, _tabId, onChunk, _sig, onProgress) => {
          onChunk(0, ['A'], 0);
          onProgress();
          return { success: true, hadFallback: false, translated: ['A'] };
        }
      );
      await port.emitMessage({
        type: 'YOUSUB_TRANSLATE_STREAM',
        segments: [{ text: 'a', startMs: 0 }],
        videoId: 'v-miss',
        sourceLang: 'en',
        targetLang: 'vi',
      });
      expect(mockCache.set).toHaveBeenCalledWith('v-miss', 'en', 'vi', ['A']);
      expect(port.postMessage).toHaveBeenNthCalledWith(1, {
        type: 'CHUNK',
        startIndex: 0,
        translated: ['A'],
        chunk: 0,
      });
      expect(port.postMessage).toHaveBeenNthCalledWith(2, { type: 'PROGRESS' });
      expect(port.postMessage).toHaveBeenNthCalledWith(3, {
        type: 'COMPLETE',
        success: true,
        hadFallback: false,
        translated: ['A'],
      });

      // Failure result -> ERROR
      port.postMessage.mockClear();
      mockTranslate.mockResolvedValue({ success: false, failureReason: 'ALL_FAILED' });
      await port.emitMessage({
        type: 'YOUSUB_TRANSLATE_STREAM',
        segments: [],
        videoId: 'v-err',
        targetLang: 'vi',
      });
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'ERROR',
        success: false,
        failureReason: 'ALL_FAILED',
      });

      // Exception -> STREAM_CRASH
      port.postMessage.mockClear();
      mockTranslate.mockRejectedValue(new Error('boom'));
      await port.emitMessage({
        type: 'YOUSUB_TRANSLATE_STREAM',
        segments: [],
        videoId: 'v-crash',
        targetLang: 'vi',
      });
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'ERROR',
        error: 'boom',
        failureReason: 'STREAM_CRASH',
      });
    });
  });
});
