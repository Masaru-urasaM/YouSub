import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for src/content/main.js (addresses DEFERRED D9 + content entry coverage).
 *
 * Top-level side effects in main.js (PageDetector.init, VideoBinder.bind,
 * SubtitleExtractor.extract, SubtitleParser.fetch, Overlay, SyncEngine,
 * RoughTranslateBridge) are mocked via jest.unstable_mockModule BEFORE importing
 * main.js so there are zero leaked DOM observers or timers across suites.
 */

let onEnterCb = null;
let onLeaveCb = null;
let currentVideoId = 'vid-default';

const mockPageDetector = {
  init: jest.fn((enter, leave) => {
    onEnterCb = enter;
    onLeaveCb = leave;
  }),
  getCurrentVideoId: jest.fn(() => currentVideoId),
};

const mockVideoBinder = {
  bind: jest.fn((cb) => cb({ currentTime: 0 })),
};

const mockSubtitleExtractor = {
  extract: jest.fn(),
  destroy: jest.fn(),
};

const mockSubtitleParser = {
  fetch: jest.fn(),
  parseSubtitleFile: jest.fn(),
};

const mockRoughTranslateBridge = {
  translateBatch: jest.fn(),
};

const mockOverlay = {
  destroy: jest.fn(),
  setLoading: jest.fn(),
  show: jest.fn(),
  hide: jest.fn(),
  showStatus: jest.fn(),
  clearStatus: jest.fn(),
};

const mockSyncEngine = {
  start: jest.fn(),
  stop: jest.fn(),
  updatePartial: jest.fn(),
  updateSubtitles: jest.fn(),
  mergeBatchEntries: jest.fn(),
  getTranslatedCount: jest.fn(() => 0),
  setDualMode: jest.fn(),
  isActive: jest.fn(() => false),
  isDualModeActive: jest.fn(() => false),
};

const mockPlaybackResume = {
  init: jest.fn(),
  onEnter: jest.fn(),
  onLeave: jest.fn(),
  destroy: jest.fn(),
  getCurrentState: jest.fn(() => Promise.resolve({ videoId: 'vid-default', currentTimeSec: 120 })),
  seekTo: jest.fn(() => Promise.resolve(true)),
  addCurrentBookmark: jest.fn(() => Promise.resolve({ videoId: 'vid-default', bookmarks: [] })),
};

jest.unstable_mockModule('../../src/content/page-detector.js', () => ({
  PageDetector: mockPageDetector,
}));
jest.unstable_mockModule('../../src/content/video-binder.js', () => ({
  VideoBinder: mockVideoBinder,
}));
jest.unstable_mockModule('../../src/content/subtitle-extractor.js', () => ({
  SubtitleExtractor: mockSubtitleExtractor,
}));
jest.unstable_mockModule('../../src/content/subtitle-parser.js', () => ({
  SubtitleParser: mockSubtitleParser,
}));
jest.unstable_mockModule('../../src/content/rough-translate-bridge.js', () => ({
  RoughTranslateBridge: mockRoughTranslateBridge,
}));
jest.unstable_mockModule('../../src/content/overlay.js', () => ({
  Overlay: mockOverlay,
}));
jest.unstable_mockModule('../../src/content/sync-engine.js', () => ({
  SyncEngine: mockSyncEngine,
}));
jest.unstable_mockModule('../../src/content/playback-resume.js', () => ({
  PlaybackResume: mockPlaybackResume,
}));

await import('../../src/content/main.js');

const messageListener = chrome.runtime.onMessage._listeners[0];

const flushMicrotasks = async (turns = 40) => {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
};

function makeMockPort() {
  const msgListeners = [];
  const discListeners = [];
  const port = {
    name: 'yousub-stream',
    postMessage: jest.fn(),
    disconnect: jest.fn(),
    onMessage: {
      addListener: jest.fn((fn) => msgListeners.push(fn)),
    },
    onDisconnect: {
      addListener: jest.fn((fn) => discListeners.push(fn)),
    },
    emitMessage: (msg) => msgListeners.forEach((fn) => fn(msg)),
    emitDisconnect: () => discListeners.forEach((fn) => fn()),
  };
  return port;
}

describe('main.js content entry', () => {
  let activePort;

  beforeEach(() => {
    jest.clearAllMocks();
    currentVideoId = 'vid-default';
    chrome.runtime.id = 'mock-extension-id';
    chrome.runtime.lastError = null;
    chrome.storage.local.store = {};
    mockSyncEngine.getTranslatedCount.mockReturnValue(0);
    mockSyncEngine.isActive.mockReturnValue(false);
    mockSyncEngine.isDualModeActive.mockReturnValue(false);
    mockVideoBinder.bind.mockImplementation((cb) => cb({ currentTime: 0 }));

    activePort = makeMockPort();
    chrome.runtime.connect.mockReturnValue(activePort);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('registered PageDetector callbacks and a single runtime onMessage listener', () => {
    expect(typeof onEnterCb).toBe('function');
    expect(typeof onLeaveCb).toBe('function');
    expect(typeof messageListener).toBe('function');
  });

  describe('YOUSUB_ROUGH_TRANSLATE message handler (DEFERRED D9)', () => {
    test('returns true, forwards args to RoughTranslateBridge, and preserves length', async () => {
      mockRoughTranslateBridge.translateBatch.mockResolvedValue(['hello', 'world']);
      const sendResponse = jest.fn();

      const keepOpen = messageListener(
        { type: 'YOUSUB_ROUGH_TRANSLATE', texts: ['xin chao', 'the gioi'], src: 'vi', tgt: 'en' },
        {},
        sendResponse
      );

      expect(keepOpen).toBe(true);
      expect(mockRoughTranslateBridge.translateBatch).toHaveBeenCalledWith(
        ['xin chao', 'the gioi'],
        'vi',
        'en'
      );

      await flushMicrotasks();
      expect(sendResponse).toHaveBeenCalledWith({ translations: ['hello', 'world'] });
    });

    test('responds with all-null array of same length when bridge rejects', async () => {
      mockRoughTranslateBridge.translateBatch.mockRejectedValue(new Error('bridge crash'));
      const sendResponse = jest.fn();

      const keepOpen = messageListener(
        { type: 'YOUSUB_ROUGH_TRANSLATE', texts: ['a', 'b', 'c'], src: 'en', tgt: 'vi' },
        {},
        sendResponse
      );

      expect(keepOpen).toBe(true);
      await flushMicrotasks();
      expect(sendResponse).toHaveBeenCalledWith({ translations: [null, null, null] });
    });

    test('handles undefined texts safely on bridge rejection', async () => {
      mockRoughTranslateBridge.translateBatch.mockRejectedValue(new Error('fail'));
      const sendResponse = jest.fn();

      const keepOpen = messageListener(
        { type: 'YOUSUB_ROUGH_TRANSLATE', src: 'en', tgt: 'vi' },
        {},
        sendResponse
      );

      expect(keepOpen).toBe(true);
      await flushMicrotasks();
      expect(sendResponse).toHaveBeenCalledWith({ translations: [] });
    });
  });

  describe('sourceLang threading (DEFERRED D9)', () => {
    const entries = [
      { startMs: 0, endMs: 1000, text: 'Line 1.' },
      { startMs: 1000, endMs: 2000, text: 'Line 2.' },
    ];

    test('DOM-scrape path forwards concrete sourceLang to YOUSUB_TRANSLATE_STREAM', async () => {
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        cb([{ languageCode: 'en' }], entries, null, 'en');
      });

      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v1', targetLang: 'vi' },
        {},
        jest.fn()
      );
      await flushMicrotasks();

      expect(activePort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'YOUSUB_TRANSLATE_STREAM',
          videoId: 'v1',
          sourceLang: 'en',
          targetLang: 'vi',
        })
      );

      activePort.emitMessage({ type: 'COMPLETE', translated: ['D1', 'D2'], fromCache: false });
      await flushMicrotasks();
      expect(mockSyncEngine.updateSubtitles).toHaveBeenCalled();
    });

    test('DOM-scrape path coerces empty sourceLang to "auto"', async () => {
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        cb([], entries, null, '');
      });

      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v2', targetLang: 'ja' },
        {},
        jest.fn()
      );
      await flushMicrotasks();

      expect(activePort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'YOUSUB_TRANSLATE_STREAM',
          sourceLang: 'auto',
          targetLang: 'ja',
        })
      );

      activePort.emitMessage({ type: 'COMPLETE', translated: ['J1', 'J2'], fromCache: true });
      await flushMicrotasks();
      expect(mockOverlay.showStatus).toHaveBeenCalledWith('Loaded from cache', 'info', 2000);
    });

    test('fallback-fetch path prefers manual English track and threads its languageCode', async () => {
      const tracks = [
        { languageCode: 'fr', baseUrl: 'https://example.com/fr', isAutoGenerated: false },
        { languageCode: 'en', baseUrl: 'https://example.com/en-asr', isAutoGenerated: true },
        { languageCode: 'en', baseUrl: 'https://example.com/en-man', isAutoGenerated: false },
      ];
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        cb(tracks, null, 'no panel', 'auto');
      });
      mockSubtitleParser.fetch.mockResolvedValue(entries);

      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v3', targetLang: 'vi' },
        {},
        jest.fn()
      );
      await flushMicrotasks();

      expect(mockSubtitleParser.fetch).toHaveBeenCalledWith('https://example.com/en-man');
      expect(activePort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'YOUSUB_TRANSLATE_STREAM',
          sourceLang: 'en',
        })
      );

      activePort.emitMessage({ type: 'COMPLETE', translated: ['A', 'B'] });
      await flushMicrotasks();
    });

    test('fallback-fetch path selects non-English track and coerces empty languageCode to "auto"', async () => {
      const tracks = [
        { languageCode: '', baseUrl: 'https://example.com/unk', isAutoGenerated: false },
      ];
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        cb(tracks, null, 'no panel', 'auto');
      });
      mockSubtitleParser.fetch.mockResolvedValue(entries);

      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v4', targetLang: 'vi' },
        {},
        jest.fn()
      );
      await flushMicrotasks();

      expect(mockSubtitleParser.fetch).toHaveBeenCalledWith('https://example.com/unk');
      expect(activePort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ sourceLang: 'auto' })
      );

      activePort.emitMessage({ type: 'COMPLETE', translated: ['A', 'B'] });
      await flushMicrotasks();
    });

    test('shows interactive no-subtitles prompt with SRT/VTT import when neither DOM entries nor track fallback produce subtitles', async () => {
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        cb([], null, 'none', 'auto');
      });
      chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
        if (msg.type === 'YOUSUB_GET_GENERATED_CACHE') cb({ cached: null });
        else if (msg.type === 'YOUSUB_CHECK_GEMINI_AVAILABLE')
          cb({ available: false, hasKey: false });
        else if (cb) cb({ success: true });
      });

      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v5', targetLang: 'vi' },
        {},
        jest.fn()
      );
      await flushMicrotasks();

      expect(mockOverlay.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('Could not find subtitles'),
        'warning',
        0,
        expect.objectContaining({
          id: 'no-subtitles',
          dismissible: true,
          importLabel: 'Import .srt / .vtt',
          onImportSubtitleFile: expect.any(Function),
        })
      );
      expect(mockOverlay.setLoading).toHaveBeenCalledWith(false);

      // Dropping/importing a valid .srt file parses, translates, and saves generated cache
      const promptOpts = mockOverlay.showStatus.mock.calls.at(-1)[3];
      const importedEntries = [{ startMs: 0, endMs: 1500, text: 'Hello SRT' }];
      mockSubtitleParser.parseSubtitleFile.mockReturnValue(importedEntries);

      promptOpts.onImportSubtitleFile('1\n00:00:00,000 --> 00:00:01,500\nHello SRT\n', 'sub.srt');
      await flushMicrotasks();

      expect(activePort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'YOUSUB_TRANSLATE_STREAM',
          videoId: 'v5',
          segments: [{ text: 'Hello SRT', startMs: 0 }],
        })
      );

      activePort.emitMessage({ type: 'COMPLETE', translated: ['Xin chao SRT'] });
      await flushMicrotasks();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'YOUSUB_SAVE_GENERATED_CACHE',
          videoId: 'v5',
          targetLang: 'vi',
        }),
        expect.any(Function)
      );
    });

    test('no-transcript path restores full generated cache, skips Gemini on LIVE, and launches Gemini fallback when available', async () => {
      const listeners = new Map();
      const fakeVideo = {
        currentTime: 0,
        duration: 600,
        addEventListener: jest.fn((evt, fn) => {
          if (!listeners.has(evt)) listeners.set(evt, new Set());
          listeners.get(evt).add(fn);
        }),
        removeEventListener: jest.fn((evt, fn) => listeners.get(evt)?.delete(fn)),
      };
      mockVideoBinder.bind.mockImplementation((cb) => cb(fakeVideo));

      // 1. Full generated cache hit (imported SRT or finished video) restores without Gemini
      mockSubtitleExtractor.extract.mockImplementation((cb) => cb([], null, 'none', 'auto'));
      chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
        if (msg.type === 'YOUSUB_GET_GENERATED_CACHE') {
          cb({
            cached: {
              entries: [{ startMs: 0, endMs: 1000, original: 'Hi', text: 'Chao' }],
              completedBatches: ['all'],
            },
          });
        } else if (cb) cb({});
      });

      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v-cached', targetLang: 'vi' },
        {},
        jest.fn()
      );
      await flushMicrotasks();
      expect(mockSyncEngine.start).toHaveBeenCalledWith(
        [{ startMs: 0, endMs: 1000, original: 'Hi', text: 'Chao' }],
        fakeVideo
      );

      // 2. LIVE_STREAM_DETECTED skips Gemini fallback and shows SRT prompt
      jest.clearAllMocks();
      mockSubtitleExtractor.extract.mockImplementation((cb) =>
        cb([], null, 'LIVE_STREAM_DETECTED', 'auto')
      );
      chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
        if (msg.type === 'YOUSUB_GET_GENERATED_CACHE') cb({ cached: null });
        else if (cb) cb({});
      });
      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v-live', targetLang: 'vi' },
        {},
        jest.fn()
      );
      await flushMicrotasks();
      expect(mockOverlay.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('Live streams'),
        'warning',
        0,
        expect.objectContaining({ onImportSubtitleFile: expect.any(Function) })
      );

      // 3. Gemini available launches windowed scheduler, merges batch 0, and handles private video failure
      jest.clearAllMocks();
      const geminiPort = makeMockPort();
      geminiPort.name = 'yousub-gemini-video';
      chrome.runtime.connect.mockReturnValue(geminiPort);

      mockSubtitleExtractor.extract.mockImplementation((cb) => cb([], null, 'none', 'auto'));
      chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
        if (msg.type === 'YOUSUB_GET_GENERATED_CACHE') cb({ cached: null });
        else if (msg.type === 'YOUSUB_CHECK_GEMINI_AVAILABLE')
          cb({ available: true, hasKey: true });
        else if (cb) cb({});
      });

      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v-gem', targetLang: 'vi' },
        {},
        jest.fn()
      );
      await flushMicrotasks();

      expect(mockSyncEngine.start).toHaveBeenCalledWith([], fakeVideo, { allowEmpty: true });
      const req1 = geminiPort.postMessage.mock.calls[0][0];
      expect(req1.type).toBe('TRANSCRIBE_WINDOW');
      expect(req1.batchIndex).toBe(0);

      geminiPort.emitMessage({
        type: 'BATCH_RESULT',
        requestId: req1.requestId,
        success: true,
        batchIndex: 0,
        entries: [
          { startMs: 1000, endMs: 3000, original: 'Hi', text: 'Chao', isAiGenerated: true },
        ],
      });
      await flushMicrotasks();
      expect(mockSyncEngine.mergeBatchEntries).toHaveBeenCalledWith([
        { startMs: 1000, endMs: 3000, original: 'Hi', text: 'Chao', isAiGenerated: true },
      ]);

      // Batch 1 prefetch starts and fails fatally with private video
      const req2 = geminiPort.postMessage.mock.calls[1][0];
      expect(req2.batchIndex).toBe(1);
      geminiPort.emitMessage({
        type: 'BATCH_RESULT',
        requestId: req2.requestId,
        success: false,
        batchIndex: 1,
        failureReason: 'VIDEO_UNAVAILABLE_OR_PRIVATE',
      });
      await flushMicrotasks();
      expect(mockOverlay.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('private, unlisted, or restricted'),
        'warning',
        0,
        expect.objectContaining({ id: 'no-subtitles', onImportSubtitleFile: expect.any(Function) })
      );

      // 4. Empty/invalid SRT shows warning toast without starting translation
      const lastPromptOpts = mockOverlay.showStatus.mock.calls.at(-1)[3];
      jest.clearAllMocks();
      mockSubtitleParser.parseSubtitleFile.mockReturnValue([]);
      lastPromptOpts.onImportSubtitleFile('bad file', 'bad.srt');
      await flushMicrotasks();
      expect(mockOverlay.showStatus).toHaveBeenCalledWith(
        'No valid subtitle entries found in file',
        'warning',
        4000
      );

      // 5. Partial generated cache restore when Gemini fallback is disabled
      jest.clearAllMocks();
      mockSubtitleExtractor.extract.mockImplementation((cb) => cb([], null, 'none', 'auto'));
      chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
        if (msg.type === 'YOUSUB_GET_GENERATED_CACHE') {
          cb({
            cached: {
              entries: [{ startMs: 0, endMs: 1000, original: 'A', text: 'B' }],
              completedBatches: [0],
            },
          });
        } else if (msg.type === 'YOUSUB_CHECK_GEMINI_AVAILABLE') {
          cb({ available: false, enabled: false, hasKey: true });
        } else if (cb) cb({});
      });
      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v-partial', targetLang: 'vi' },
        {},
        jest.fn()
      );
      await flushMicrotasks();
      expect(mockSyncEngine.start).toHaveBeenCalledWith(
        [{ startMs: 0, endMs: 1000, original: 'A', text: 'B' }],
        fakeVideo
      );

      // 6. Transient 429 error offers Retry AI button that re-queues batch
      jest.clearAllMocks();
      const retryPort = makeMockPort();
      retryPort.name = 'yousub-gemini-video';
      chrome.runtime.connect.mockReturnValue(retryPort);
      mockSubtitleExtractor.extract.mockImplementation((cb) => cb([], null, 'none', 'auto'));
      chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
        if (msg.type === 'YOUSUB_GET_GENERATED_CACHE') cb({ cached: null });
        else if (msg.type === 'YOUSUB_CHECK_GEMINI_AVAILABLE')
          cb({ available: true, hasKey: true });
        else if (cb) cb({});
      });
      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v-retry', targetLang: 'vi' },
        {},
        jest.fn()
      );
      await flushMicrotasks();
      const firstReq = retryPort.postMessage.mock.calls[0][0];
      retryPort.emitMessage({
        type: 'BATCH_RESULT',
        requestId: firstReq.requestId,
        success: false,
        batchIndex: 0,
        failureReason: 'GEMINI_RATE_LIMITED',
      });
      await flushMicrotasks();
      const retryCall = mockOverlay.showStatus.mock.calls.find(
        (c) => c[3]?.actions?.[0]?.label === 'Retry AI'
      );
      expect(retryCall).toBeDefined();
      retryCall[3].actions[0].onClick(jest.fn());
      await flushMicrotasks();
      expect(retryPort.postMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('streaming protocol, partial preservation & errors', () => {
    const entries = [
      { startMs: 0, endMs: 1000, text: 'Hello.' },
      { startMs: 1000, endMs: 2000, text: 'World.' },
    ];

    test('CHUNK updates partial batch and COMPLETE finalizes subtitles', async () => {
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        cb([{ languageCode: 'en' }], entries, null, 'en');
      });

      messageListener({ type: 'YOUSUB_START_TRANSLATION', videoId: 's1' }, {}, jest.fn());
      await flushMicrotasks();

      activePort.emitMessage({
        type: 'CHUNK',
        startIndex: 0,
        translated: ['Xin chao', null],
      });
      expect(mockSyncEngine.updatePartial).toHaveBeenCalledWith(
        [
          { startMs: 0, endMs: 1000, original: 'Hello.', text: 'Xin chao' },
          { startMs: 1000, endMs: 2000, original: 'World.', text: 'World.' },
        ],
        0
      );

      activePort.emitMessage({ type: 'PONG' });
      activePort.emitMessage({ type: 'PROGRESS' });
      activePort.emitMessage({ type: 'COMPLETE', translated: ['Xin chao', 'The gioi'] });
      await flushMicrotasks();

      expect(mockSyncEngine.updateSubtitles).toHaveBeenCalledWith([
        { startMs: 0, endMs: 1000, original: 'Hello.', text: 'Xin chao' },
        { startMs: 1000, endMs: 2000, original: 'World.', text: 'The gioi' },
      ]);
      expect(activePort.disconnect).toHaveBeenCalled();
    });

    test('coalesces fragmented ASR cues before streaming and emits SEEK_PRIORITY on video seek', async () => {
      const listeners = new Map();
      const seekVideo = {
        currentTime: 10,
        addEventListener: jest.fn((evt, fn) => {
          if (!listeners.has(evt)) listeners.set(evt, new Set());
          listeners.get(evt).add(fn);
        }),
        removeEventListener: jest.fn((evt, fn) => listeners.get(evt)?.delete(fn)),
      };
      mockVideoBinder.bind.mockImplementation((cb) => cb(seekVideo));

      const rawFragments = [
        { startMs: 0, endMs: 1200, text: 'We are building' },
        { startMs: 1200, endMs: 2500, text: 'a semantic coalescer.' },
        { startMs: 2500, endMs: 4000, text: 'Next sentence.' },
      ];
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        cb([{ languageCode: 'en' }], rawFragments, null, 'en');
      });

      messageListener({ type: 'YOUSUB_START_TRANSLATION', videoId: 's-coal' }, {}, jest.fn());
      await flushMicrotasks();

      expect(activePort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'YOUSUB_TRANSLATE_STREAM',
          playheadMs: 10000,
          coalesceStats: { rawCount: 3, coalescedCount: 2, mergedCues: 1 },
          segments: [
            { text: 'We are building a semantic coalescer.', startMs: 0 },
            { text: 'Next sentence.', startMs: 2500 },
          ],
        })
      );

      // Simulate user seeking ahead to 125s while stream is open
      seekVideo.currentTime = 125;
      listeners.get('seeking')?.forEach((fn) => fn());
      expect(activePort.postMessage).toHaveBeenCalledWith({
        type: 'SEEK_PRIORITY',
        playheadMs: 125000,
      });

      activePort.emitMessage({ type: 'COMPLETE', translated: ['D1', 'D2'] });
      await flushMicrotasks();
      expect(seekVideo.removeEventListener).toHaveBeenCalledWith('seeking', expect.any(Function));
    });

    test('ERROR preserves partials when SyncEngine.getTranslatedCount() > 0', async () => {
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        cb([{ languageCode: 'en' }], entries, null, 'en');
      });
      mockSyncEngine.getTranslatedCount.mockReturnValue(1);

      messageListener({ type: 'YOUSUB_START_TRANSLATION', videoId: 's2' }, {}, jest.fn());
      await flushMicrotasks();

      activePort.emitMessage({ type: 'ERROR', failureReason: 'INCOMPLETE_AFTER_SWEEP' });
      await flushMicrotasks();

      expect(mockOverlay.destroy).toHaveBeenCalledTimes(1); // initial setup only, NOT torn down
      expect(mockOverlay.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('1/2 lines translated. (INCOMPLETE_AFTER_SWEEP)'),
        'warning',
        8000
      );
    });

    test('ERROR tears down overlay and escapes failure metadata when partialCount === 0', async () => {
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        cb([{ languageCode: 'en' }], entries, null, 'en');
      });

      messageListener({ type: 'YOUSUB_START_TRANSLATION', videoId: 's3' }, {}, jest.fn());
      await flushMicrotasks();

      activePort.emitMessage({
        type: 'ERROR',
        failureReason: '<bad>',
        failures: [
          {
            provider: 'groq',
            model: 'llama<x>',
            status: 429,
            message: 'Limit 6000, Used 5900 try again in 3.5s',
          },
          { provider: 'groq', model: 'llama<x>', status: 429, message: 'duplicate' },
          { provider: 'openai', model: 'm2', status: 500, message: '<script>x</script>' },
          { provider: 'a', model: 'm3', status: 500, message: 'e3' },
          { provider: 'b', model: 'm4', status: 500, message: 'e4' },
          { provider: 'c', model: 'm5', status: 500, message: 'e5' },
          { provider: 'd', model: 'm6', status: 500, message: 'e6' },
        ],
      });
      await flushMicrotasks();

      expect(mockSyncEngine.stop).toHaveBeenCalled();
      expect(mockOverlay.destroy).toHaveBeenCalledTimes(2);
      const errorCall = mockOverlay.showStatus.mock.calls.find((c) => c[1] === 'error');
      expect(errorCall).toBeDefined();
      const [statusHtml, statusType] = errorCall;
      expect(statusType).toBe('error');
      expect(statusHtml).toContain('&lt;bad&gt;');
      expect(statusHtml).toContain('&lt;script&gt;x&lt;/script&gt;');
      expect(statusHtml).toContain('5900/6000 used, retry 3.5s');
      expect(statusHtml).toContain('+ 1 more');
      expect(statusHtml).toContain('Rate limited');
    });

    test('idle watchdog fires TIMEOUT_BACKGROUND when no CHUNK/PROGRESS arrives for 150s', async () => {
      jest.useFakeTimers();
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        cb([{ languageCode: 'en' }], entries, null, 'en');
      });

      messageListener({ type: 'YOUSUB_START_TRANSLATION', videoId: 's4' }, {}, jest.fn());
      await flushMicrotasks();

      // PONG must NOT reset the idle watchdog
      await jest.advanceTimersByTimeAsync(100000);
      activePort.emitMessage({ type: 'PONG' });
      await jest.advanceTimersByTimeAsync(50000);
      await flushMicrotasks();

      expect(activePort.disconnect).toHaveBeenCalled();
      expect(activePort.postMessage).toHaveBeenCalledWith({ type: 'PING' });
      expect(mockOverlay.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('TIMEOUT_BACKGROUND'),
        'error',
        20000
      );
    });

    test('handles port disconnect and invalidated extension context cleanly', async () => {
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        cb([{ languageCode: 'en' }], entries, null, 'en');
      });

      messageListener({ type: 'YOUSUB_START_TRANSLATION', videoId: 's5' }, {}, jest.fn());
      await flushMicrotasks();
      activePort.emitDisconnect();
      await flushMicrotasks();
      expect(mockOverlay.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('PORT_DISCONNECTED'),
        'error',
        20000
      );

      chrome.runtime.id = undefined;
      mockOverlay.showStatus.mockClear();
      messageListener({ type: 'YOUSUB_START_TRANSLATION', videoId: 's6' }, {}, jest.fn());
      await flushMicrotasks();
      expect(mockOverlay.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('CONTEXT_INVALIDATED'),
        'error',
        20000
      );
    });
  });

  describe('PageDetector lifecycle & auxiliary messages', () => {
    test('onEnter auto-starts when translation is enabled and cache exists', async () => {
      chrome.storage.local.store = { yousub_translation_enabled: true, targetLang: 'vi' };
      chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
        if (msg.type === 'YOUSUB_CHECK_CACHE') cb({ exists: true });
        else if (cb) cb({});
      });
      mockSubtitleExtractor.extract.mockImplementation((cb) => cb([], null, 'none', 'auto'));

      onEnterCb('vid-auto');
      await flushMicrotasks();

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'YOUSUB_CHECK_CACHE', videoId: 'vid-auto', targetLang: 'vi' },
        expect.any(Function)
      );
      expect(mockSubtitleExtractor.extract).toHaveBeenCalled();
    });

    test('onEnter handles cache miss, disabled state, storage error, and 10s cache check timeout', async () => {
      jest.useFakeTimers();

      // Disabled
      chrome.storage.local.store = { yousub_translation_enabled: false };
      onEnterCb('v-off');
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();

      // Cache check timeout
      chrome.storage.local.store = { yousub_translation_enabled: true };
      chrome.runtime.sendMessage.mockImplementation(() => {});
      onEnterCb('v-timeout');
      await jest.advanceTimersByTimeAsync(10000);
      expect(mockSubtitleExtractor.extract).not.toHaveBeenCalled();

      // Storage error
      chrome.runtime.lastError = { message: 'storage fail' };
      onEnterCb('v-err');
      expect(mockSubtitleExtractor.extract).not.toHaveBeenCalled();
      chrome.runtime.lastError = null;
    });

    test('onLeave, toggle off, dual mode, cache cleared, and YOUSUB_GET_STATE work as expected', () => {
      onLeaveCb();
      expect(mockSyncEngine.stop).toHaveBeenCalled();
      expect(mockOverlay.destroy).toHaveBeenCalled();

      jest.clearAllMocks();
      messageListener({ type: 'YOUSUB_TOGGLE_TRANSLATION', enabled: false }, {}, jest.fn());
      expect(mockSyncEngine.stop).toHaveBeenCalled();
      expect(mockOverlay.destroy).toHaveBeenCalled();

      messageListener({ type: 'YOUSUB_TOGGLE_DUAL_MODE', enabled: true }, {}, jest.fn());
      expect(mockSyncEngine.setDualMode).toHaveBeenCalledWith(true);

      jest.clearAllMocks();
      messageListener({ type: 'YOUSUB_CACHE_CLEARED' }, {}, jest.fn());
      expect(mockSyncEngine.stop).toHaveBeenCalled();

      mockSyncEngine.isActive.mockReturnValue(true);
      mockSyncEngine.isDualModeActive.mockReturnValue(true);
      const sendResponse = jest.fn();
      const ret = messageListener({ type: 'YOUSUB_GET_STATE' }, {}, sendResponse);
      expect(ret).toBe(false);
      expect(sendResponse).toHaveBeenCalledWith({
        isTranslationActive: true,
        isDualMode: true,
      });
    });

    test('reports active pipeline during extraction, clears status on fallback, and consumes autostart video flag', async () => {
      let capturedExtractCb = null;
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        capturedExtractCb = cb;
      });
      chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
        if (msg.type === 'YOUSUB_GET_GENERATED_CACHE') cb({ cached: null });
        else if (msg.type === 'YOUSUB_CHECK_GEMINI_AVAILABLE')
          cb({ available: false, enabled: true, hasKey: false });
        else if (cb) cb({});
      });

      // Start pipeline — extractor still pending
      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v-pending', targetLang: 'vi' },
        {},
        jest.fn()
      );
      expect(mockOverlay.showStatus).toHaveBeenCalledWith(
        'Checking video subtitles...',
        'info',
        0,
        { id: 'extracting-status' }
      );
      const stateRes = jest.fn();
      messageListener({ type: 'YOUSUB_GET_STATE' }, {}, stateRes);
      expect(stateRes).toHaveBeenCalledWith({ isTranslationActive: true, isDualMode: false });

      // Extractor finishes with no subtitles -> extracting toast cleared & state resets to false
      capturedExtractCb([], null, 'No transcript button and no caption tracks found.', 'auto');
      await flushMicrotasks();
      expect(mockOverlay.clearStatus).toHaveBeenCalledWith('extracting-status');
      const stateAfter = jest.fn();
      messageListener({ type: 'YOUSUB_GET_STATE' }, {}, stateAfter);
      expect(stateAfter).toHaveBeenCalledWith({ isTranslationActive: false, isDualMode: false });

      // Autostart flag in storage launches pipeline directly on enter and removes the flag
      jest.clearAllMocks();
      chrome.storage.local.store = {
        yousub_translation_enabled: true,
        targetLang: 'ja',
        yousub_autostart_video: 'v-recover',
      };
      onEnterCb('v-recover');
      expect(chrome.storage.local.store.yousub_autostart_video).toBeUndefined();
      expect(mockSubtitleExtractor.extract).toHaveBeenCalledTimes(1);
    });

    test('disconnects active stream port and ignores late CHUNK/COMPLETE messages after disable/navigation', async () => {
      let capturedExtractCb = null;
      mockSubtitleExtractor.extract.mockImplementation((cb) => {
        capturedExtractCb = cb;
      });

      messageListener(
        { type: 'YOUSUB_START_TRANSLATION', videoId: 'v-stale', targetLang: 'vi' },
        {},
        jest.fn()
      );
      capturedExtractCb(
        [{ languageCode: 'en', baseUrl: 'https://yt/en' }],
        [{ startMs: 0, endMs: 2000, text: 'Line 1.' }],
        null,
        'en'
      );
      await flushMicrotasks();

      expect(chrome.runtime.connect).toHaveBeenCalledWith({ name: 'yousub-stream' });

      jest.clearAllMocks();
      onLeaveCb();
      expect(activePort.disconnect).toHaveBeenCalledTimes(1);

      activePort.emitMessage({ type: 'CHUNK', startIndex: 0, translated: ['Stale chunk'] });
      activePort.emitMessage({
        type: 'COMPLETE',
        translated: ['Stale complete'],
        fromCache: false,
      });
      await flushMicrotasks();

      expect(mockSyncEngine.updatePartial).not.toHaveBeenCalled();
      expect(mockSyncEngine.updateSubtitles).not.toHaveBeenCalled();
    });

    test('wires PlaybackResume onEnter/onLeave and handles YOUSUB_RESUME_* messages (Phase 84)', async () => {
      onEnterCb('vid-resume-1');
      expect(mockPlaybackResume.onEnter).toHaveBeenCalledWith('vid-resume-1');

      onLeaveCb();
      expect(mockPlaybackResume.onLeave).toHaveBeenCalled();

      const resGet = jest.fn();
      expect(messageListener({ type: 'YOUSUB_RESUME_GET_STATE' }, {}, resGet)).toBe(true);
      await flushMicrotasks();
      expect(resGet).toHaveBeenCalledWith({ videoId: 'vid-default', currentTimeSec: 120 });

      const resSeek = jest.fn();
      expect(
        messageListener(
          { type: 'YOUSUB_RESUME_SEEK_TO', timeSec: 500, allowResetToZero: false },
          {},
          resSeek
        )
      ).toBe(true);
      await flushMicrotasks();
      expect(mockPlaybackResume.seekTo).toHaveBeenCalledWith(500, { allowResetToZero: false });
      expect(resSeek).toHaveBeenCalledWith({ ok: true });

      const resBm = jest.fn();
      expect(messageListener({ type: 'YOUSUB_RESUME_ADD_BOOKMARK', label: 'Ch1' }, {}, resBm)).toBe(
        true
      );
      await flushMicrotasks();
      expect(mockPlaybackResume.addCurrentBookmark).toHaveBeenCalledWith('Ch1');
      expect(resBm).toHaveBeenCalledWith({
        ok: true,
        record: { videoId: 'vid-default', bookmarks: [] },
      });
    });
  });
});
