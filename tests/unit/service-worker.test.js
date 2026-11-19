import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests for src/background/service-worker.js (message + streaming port routers).
 */

const mockTranslate = jest.fn();
const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
  getGenerated: jest.fn(),
  setGenerated: jest.fn(),
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
const mockVideoTranscriber = {
  hasActiveGeminiKey: jest.fn(),
  transcribeVideoWindow: jest.fn(),
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
jest.unstable_mockModule('../../src/background/video-transcriber.js', () => mockVideoTranscriber);

await import('../../src/background/service-worker.js');
const { Logger } = await import('../../src/shared/logger.js');

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
    browser.storage.session.store = {};
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

    test('YOUSUB_CHECK_GEMINI_AVAILABLE, generated cache handlers, and yousub-gemini-video port work', async () => {
      browser.storage.local.store = { yousub_gemini_fallback_enabled: true };
      mockVideoTranscriber.hasActiveGeminiKey.mockResolvedValue(true);
      expect(await sendMessageAsync({ type: 'YOUSUB_CHECK_GEMINI_AVAILABLE' })).toEqual({
        available: true,
        enabled: true,
        hasKey: true,
      });

      mockCache.getGenerated.mockResolvedValue({
        entries: [{ startMs: 0, endMs: 1000, text: 'x' }],
      });
      expect(
        await sendMessageAsync({
          type: 'YOUSUB_GET_GENERATED_CACHE',
          videoId: 'v-gen',
          targetLang: 'vi',
        })
      ).toEqual({ cached: { entries: [{ startMs: 0, endMs: 1000, text: 'x' }] } });

      await sendMessageAsync({
        type: 'YOUSUB_SAVE_GENERATED_CACHE',
        videoId: 'v-srt',
        targetLang: 'vi',
        payload: { entries: [{ startMs: 0, endMs: 1000, text: 'y' }] },
      });
      expect(mockCache.setGenerated).toHaveBeenCalledWith('v-srt', 'vi', {
        entries: [{ startMs: 0, endMs: 1000, text: 'y' }],
      });

      // Port: PING, TRANSCRIBE_WINDOW, CANCEL_BATCH, disconnect abort
      const port = makePort('yousub-gemini-video', 12);
      onConnectHandler(port);

      await port.emitMessage({ type: 'PING' });
      expect(port.postMessage).toHaveBeenCalledWith({ type: 'PONG' });

      let capturedSignal;
      mockVideoTranscriber.transcribeVideoWindow.mockImplementation(async ({ signal }) => {
        capturedSignal = signal;
        return { success: true, batchIndex: 0, entries: [{ startMs: 0, endMs: 1000, text: 'ok' }] };
      });
      await port.emitMessage({
        type: 'TRANSCRIBE_WINDOW',
        requestId: 'req-1',
        videoId: 'v-gen',
        batchIndex: 0,
        targetLang: 'vi',
      });
      expect(capturedSignal.aborted).toBe(false);
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'BATCH_RESULT',
        requestId: 'req-1',
        success: true,
        batchIndex: 0,
        entries: [{ startMs: 0, endMs: 1000, text: 'ok' }],
      });

      let resolveDeferred;
      mockVideoTranscriber.transcribeVideoWindow.mockImplementationOnce(
        ({ signal }) =>
          new Promise((resolve) => {
            capturedSignal = signal;
            resolveDeferred = resolve;
          })
      );
      const pendingEmit = port.emitMessage({
        type: 'TRANSCRIBE_WINDOW',
        requestId: 'req-cancel',
        videoId: 'v-gen',
        batchIndex: 1,
        targetLang: 'vi',
      });
      await port.emitMessage({ type: 'CANCEL_BATCH', requestId: 'req-cancel' });
      expect(capturedSignal.aborted).toBe(true);
      resolveDeferred({ success: false, batchIndex: 1, failureReason: 'ABORTED' });
      await pendingEmit;
      port.emitDisconnect();
    });

    test('handles SEEK_PRIORITY, writes streaming/gemini telemetry & stats, and skips length-mismatched cache', async () => {
      const port = makePort('yousub-stream', 55);
      onConnectHandler(port);

      // Length-mismatched old cache is skipped rather than misaligning coalesced segments
      mockCache.get.mockResolvedValue(['old-0', 'old-1', 'old-2']);
      let receivedOpts;
      mockTranslate.mockImplementation(
        async (_segs, _sl, _tl, _tabId, _onChunk, _sig, _onProg, opts) => {
          receivedOpts = opts;
          opts?.onStatsUpdate?.({
            model: 'gemini-2.5-flash',
            provider: 'google',
            totalTokens: 100,
            promptTokens: 60,
            completionTokens: 40,
            batchCount: 1,
            durationMs: 900,
          });
          // Simulate dynamic seek event arriving mid-translation
          await port.emitMessage({ type: 'SEEK_PRIORITY', playheadMs: 95000 });
          expect(opts.getPlayheadMs()).toBe(95000);
          return {
            success: true,
            hadFallback: false,
            translated: ['Translated coalesced'],
            stats: {
              model: 'gemini-2.5-flash',
              provider: 'google',
              totalTokens: 120,
              promptTokens: 70,
              completionTokens: 50,
              batchCount: 1,
              durationMs: 1100,
            },
          };
        }
      );

      await port.emitMessage({
        type: 'YOUSUB_TRANSLATE_STREAM',
        videoId: 'v-stream-stats',
        segments: [{ text: 'Merged sentence.', startMs: 0 }],
        sourceLang: 'en',
        targetLang: 'vi',
        playheadMs: 12000,
        coalesceStats: { rawCount: 3, coalescedCount: 1, mergedCues: 2 },
        extractionSource: 'dom-transcript',
      });

      expect(receivedOpts.initialPlayheadMs).toBe(12000);
      expect(browser.storage.local.store['yousub_stats_v-stream-stats']).toMatchObject({
        source: 'api',
        model: 'gemini-2.5-flash',
        totalTokens: 120,
      });
      expect(browser.storage.session.store['yousub_pipeline_v-stream-stats']).toMatchObject({
        stage: 'COMPLETE',
        coalescer: { rawCount: 3, coalescedCount: 1, mergedCues: 2 },
      });

      // Gemini video port persists stats and pipeline telemetry (including initial router state)
      const gPort = makePort('yousub-gemini-video', 56);
      onConnectHandler(gPort);
      let resolveInFlight;
      mockVideoTranscriber.transcribeVideoWindow.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInFlight = resolve;
          })
      );

      const pendingGem = gPort.emitMessage({
        type: 'TRANSCRIBE_WINDOW',
        requestId: 'g-stats-1',
        videoId: 'v-gem-stats',
        batchIndex: 0,
        durationSec: 300,
        windowSec: 240,
        targetLang: 'vi',
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(browser.storage.session.store['yousub_pipeline_v-gem-stats']).toMatchObject({
        mode: 'gemini-video',
        stage: 'ROUTE',
        router: { activeProvider: 'google', activeModel: 'gemini-2.5-flash' },
      });

      resolveInFlight({
        success: true,
        batchIndex: 0,
        model: 'gemini-2.5-flash',
        provider: 'google',
        keyMask: '...9999',
        durationMs: 2100,
        usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600 },
        entries: [{ startMs: 0, endMs: 5000, original: 'Hi', text: 'Chao', isAiGenerated: true }],
      });
      await pendingGem;

      expect(browser.storage.local.store['yousub_stats_v-gem-stats']).toMatchObject({
        source: 'gemini-video',
        model: 'gemini-2.5-flash',
        totalTokens: 600,
      });
      expect(browser.storage.session.store['yousub_pipeline_v-gem-stats']?.mode).toBe(
        'gemini-video'
      );
    });

    test('YOUSUB_LOG_BATCH appends content logs via Logger.appendExternalEntries (Phase 84)', async () => {
      Logger._buffer = [];
      const debugSpy = jest.spyOn(Logger, 'debug');
      const res = await sendMessageAsync({
        type: 'YOUSUB_LOG_BATCH',
        entries: [
          '{"ts":"2026-11-18T10:00:00.000Z","level":"INFO","tag":"PlaybackResume","msg":"ok"}',
        ],
      });
      expect(res).toEqual({ success: true });
      expect(Logger._buffer).toHaveLength(1);
      expect(Logger._buffer[0]).toContain('PlaybackResume');
      expect(debugSpy).not.toHaveBeenCalledWith(
        'ServiceWorker',
        expect.stringContaining('YOUSUB_LOG_BATCH')
      );
      if (Logger._flushTimer) {
        clearTimeout(Logger._flushTimer);
        Logger._flushTimer = null;
      }
      debugSpy.mockRestore();
    });

    test('YOUSUB_TRANSLATE_STREAM forwards style, glossary, video metadata, and variant cache key (Phase 90)', async () => {
      browser.storage.local.store = {
        yousub_translation_style: 'technical',
        yousub_custom_glossary: {
          keepTermsText: 'YouSub',
          glossaryPairsText: 'cue => dòng phụ đề',
          pronounRule: 'Neutral',
        },
      };
      mockCache.get.mockResolvedValue(null);
      mockTranslate.mockResolvedValue({
        success: true,
        translated: ['Xin chào'],
        stats: { totalTokens: 42 },
      });

      const port = makePort('yousub-stream', 77);
      onConnectHandler(port);
      await port.emitMessage({
        type: 'YOUSUB_TRANSLATE_STREAM',
        videoId: 'v-p90',
        segments: [{ text: 'Hello', startMs: 0 }],
        sourceLang: 'en',
        targetLang: 'vi',
        videoTitle: 'Deep Dive Video',
        channelName: 'Dev Channel',
      });

      expect(mockCache.get).toHaveBeenCalledWith(
        'v-p90',
        'en',
        'vi',
        expect.stringMatching(/^technical_/)
      );
      expect(mockTranslate).toHaveBeenCalledWith(
        expect.any(Array),
        'en',
        'vi',
        77,
        expect.any(Function),
        expect.any(Object),
        expect.any(Function),
        expect.objectContaining({
          videoId: 'v-p90',
          styleId: 'technical',
          videoTitle: 'Deep Dive Video',
          channelName: 'Dev Channel',
        })
      );
      expect(mockCache.set).toHaveBeenCalledWith(
        'v-p90',
        'en',
        'vi',
        ['Xin chào'],
        expect.stringMatching(/^technical_/)
      );
    });

    test('records local usage stats on API run and 30-day cache HIT (Phase 91)', async () => {
      browser.storage.local.store = {};
      mockCache.get.mockResolvedValueOnce(null);
      mockTranslate.mockResolvedValueOnce({
        success: true,
        translated: ['Xin chào'],
        stats: { totalTokens: 720, batchCount: 2 },
      });

      const port = makePort('yousub-stream', 88);
      onConnectHandler(port);
      await port.emitMessage({
        type: 'YOUSUB_TRANSLATE_STREAM',
        videoId: 'v-stats-1',
        segments: [{ text: 'Hello', startMs: 0 }],
        sourceLang: 'en',
        targetLang: 'vi',
      });

      expect(browser.storage.local.store.yousub_usage_stats_v1).toMatchObject({
        videosTranslated: 1,
        apiRuns: 1,
        apiBatches: 2,
        tokensUsed: 720,
        cacheHits: 0,
      });

      // Next request hits cache -> increments cacheHits & estimated savings
      mockCache.get.mockResolvedValueOnce(new Array(60).fill('Cached line'));
      await port.emitMessage({
        type: 'YOUSUB_TRANSLATE_STREAM',
        videoId: 'v-stats-2',
        segments: Array.from({ length: 60 }, (_, i) => ({ text: `L${i}`, startMs: i * 1000 })),
        sourceLang: 'en',
        targetLang: 'vi',
      });

      expect(browser.storage.local.store.yousub_usage_stats_v1).toMatchObject({
        videosTranslated: 2,
        cacheHits: 1,
        estimatedRequestsSaved: 2,
        estimatedTokensSaved: 2100,
      });
    });
  });
});
