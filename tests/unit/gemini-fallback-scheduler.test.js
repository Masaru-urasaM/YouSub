import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const { createGeminiFallbackScheduler, createGeminiPortFetcher, DEFAULT_GEMINI_WINDOW_SEC } =
  await import('../../src/content/gemini-fallback-scheduler.js');

const flushMicrotasks = async (turns = 6) => {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
};

function makeVideoElement(duration = 3600, initialTime = 0) {
  const listeners = new Map();
  return {
    duration,
    currentTime: initialTime,
    addEventListener: jest.fn((evt, fn) => {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
    }),
    removeEventListener: jest.fn((evt, fn) => {
      listeners.get(evt)?.delete(fn);
    }),
    emit: (evt) => {
      for (const fn of listeners.get(evt) || []) fn();
    },
    listenerCount: (evt) => listeners.get(evt)?.size || 0,
  };
}

function makeDeferredFetch() {
  const calls = [];
  const fetchBatch = jest.fn((params) => {
    let resolveFn;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });
    const record = {
      ...params,
      aborted: false,
      resolve: resolveFn,
      promise,
    };
    if (params.signal) {
      params.signal.addEventListener('abort', () => {
        record.aborted = true;
        resolveFn({ success: false, batchIndex: params.batchIndex, failureReason: 'ABORTED' });
      });
    }
    calls.push(record);
    return promise;
  });
  return { fetchBatch, calls };
}

describe('gemini-fallback-scheduler.js (Phase 78)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('runs batch 0, immediately prefetches batch 1, and STOPS until playback enters batch 1', async () => {
    const video = makeVideoElement(3600, 0);
    const { fetchBatch, calls } = makeDeferredFetch();
    const onEntries = jest.fn();

    const scheduler = createGeminiFallbackScheduler({
      videoId: 'vid-long',
      videoElement: video,
      targetLang: 'vi',
      windowSec: DEFAULT_GEMINI_WINDOW_SEC, // 240s
      fetchBatch,
      onEntries,
    });

    scheduler.start();
    // Rule 1: starts batch 0 immediately while playback is at t=0
    expect(calls.map((c) => c.batchIndex)).toEqual([0]);

    // Finish batch 0 -> entries delivered, batch 1 prefetch starts immediately
    calls[0].resolve({
      success: true,
      batchIndex: 0,
      entries: [{ startMs: 1000, endMs: 3000, original: 'One', text: 'Mot' }],
    });
    await flushMicrotasks();

    expect(onEntries).toHaveBeenCalledWith(
      [{ startMs: 1000, endMs: 3000, original: 'One', text: 'Mot' }],
      0
    );
    expect(calls.map((c) => c.batchIndex)).toEqual([0, 1]);

    // Finish batch 1 while user is still watching inside batch 0 (t=120s)
    video.currentTime = 120;
    calls[1].resolve({
      success: true,
      batchIndex: 1,
      entries: [{ startMs: 245000, endMs: 248000, original: 'Two', text: 'Hai' }],
    });
    await flushMicrotasks();

    // Even with multiple timeupdates inside batch 0, batch 2 MUST NOT start yet
    video.currentTime = 200;
    video.emit('timeupdate');
    await flushMicrotasks();
    expect(calls.map((c) => c.batchIndex)).toEqual([0, 1]);

    // Playback enters batch 1 (t=241s) -> immediately prefetches batch 2
    video.currentTime = 241;
    video.emit('timeupdate');
    await flushMicrotasks();
    expect(calls.map((c) => c.batchIndex)).toEqual([0, 1, 2]);

    scheduler.stop();
  });

  test('seek jump (batch 1 -> batch 6) aborts stale prefetch, runs batch 6 first, then prefetches batch 7', async () => {
    const video = makeVideoElement(3600, 10);
    const { fetchBatch, calls } = makeDeferredFetch();
    const onEntries = jest.fn();

    const scheduler = createGeminiFallbackScheduler({
      videoId: 'vid-jump',
      videoElement: video,
      targetLang: 'vi',
      windowSec: 240,
      fetchBatch,
      onEntries,
    });

    scheduler.start();
    calls[0].resolve({
      success: true,
      batchIndex: 0,
      entries: [{ startMs: 1000, endMs: 2000, original: 'A', text: 'B' }],
    });
    await flushMicrotasks();

    // Now batch 1 (0-indexed 1, i.e., "2nd batch") is prefetching in flight
    expect(calls[1].batchIndex).toBe(1);
    expect(calls[1].aborted).toBe(false);

    // User jumps to batch index 5 ("6th batch", t = 1250s)
    video.currentTime = 1250;
    video.emit('seeked');
    await flushMicrotasks();

    // Old prefetch (index 1) must be aborted, index 5 must launch immediately
    expect(calls[1].aborted).toBe(true);
    expect(calls[2].batchIndex).toBe(5);

    // Finish index 5 -> delivers entries immediately and prefetches index 6 ("7th batch")
    calls[2].resolve({
      success: true,
      batchIndex: 5,
      entries: [{ startMs: 1252000, endMs: 1255000, original: 'Six', text: 'Sau' }],
    });
    await flushMicrotasks();
    expect(calls[3].batchIndex).toBe(6);

    // Finish index 6 while still in batch 5 -> waits before starting index 7
    calls[3].resolve({
      success: true,
      batchIndex: 6,
      entries: [{ startMs: 1450000, endMs: 1452000, original: 'Seven', text: 'Bay' }],
    });
    await flushMicrotasks();
    expect(calls).toHaveLength(4);

    // Backward seek within already-DONE batch 5 (when 5 and 6 are DONE) triggers ZERO fetches
    video.currentTime = 1220;
    video.emit('seeked');
    await flushMicrotasks();
    expect(calls).toHaveLength(4);

    // Seeking back to DONE batch 0 (whose batch 1 prefetch was previously aborted) never
    // re-fetches batch 0, and cleanly resumes lookahead prefetch for batch 1
    video.currentTime = 50;
    video.emit('seeked');
    await flushMicrotasks();
    expect(calls).toHaveLength(5);
    expect(calls[4].batchIndex).toBe(1);

    scheduler.stop();
  });

  test('promotes in-flight prefetch to foreground when user seeks directly into it', async () => {
    const video = makeVideoElement(1200, 10);
    const { fetchBatch, calls } = makeDeferredFetch();
    const onBatchStart = jest.fn();

    const scheduler = createGeminiFallbackScheduler({
      videoId: 'vid-promote',
      videoElement: video,
      windowSec: 240,
      fetchBatch,
      onBatchStart,
    });

    scheduler.start();
    calls[0].resolve({ success: true, batchIndex: 0, entries: [] });
    await flushMicrotasks();
    expect(calls[1].batchIndex).toBe(1);

    // Seek directly into batch 1 while batch 1 prefetch is still running
    video.currentTime = 260;
    video.emit('seeked');
    await flushMicrotasks();

    // Must NOT abort batch 1; promotes it to foreground notification
    expect(calls[1].aborted).toBe(false);
    expect(calls).toHaveLength(2);
    expect(onBatchStart).toHaveBeenLastCalledWith({
      batchIndex: 1,
      isPrefetch: false,
      totalBatches: 5,
    });

    scheduler.stop();
  });

  test('handles fatal errors vs retryable batch errors and cleans up all listeners on stop', async () => {
    const video = makeVideoElement(600, 0);
    const { fetchBatch, calls } = makeDeferredFetch();
    const onFatalError = jest.fn();
    const onBatchError = jest.fn();

    const scheduler = createGeminiFallbackScheduler({
      videoId: 'vid-err',
      videoElement: video,
      windowSec: 240,
      fetchBatch,
      onFatalError,
      onBatchError,
    });

    scheduler.start();
    expect(video.listenerCount('timeupdate')).toBe(1);

    // Transient 429 marks batch FAILED (does not spin on timeupdate) and allows retry()
    calls[0].resolve({
      success: false,
      batchIndex: 0,
      failureReason: 'GEMINI_RATE_LIMITED',
      error: '429',
    });
    await flushMicrotasks();
    expect(onBatchError).toHaveBeenCalledTimes(1);
    video.emit('timeupdate');
    await flushMicrotasks();
    expect(calls).toHaveLength(1);

    scheduler.retry();
    await flushMicrotasks();
    expect(calls).toHaveLength(2);

    // Fatal private-video error tears down listeners
    calls[1].resolve({
      success: false,
      batchIndex: 0,
      failureReason: 'VIDEO_UNAVAILABLE_OR_PRIVATE',
      error: 'private',
    });
    await flushMicrotasks();
    expect(onFatalError).toHaveBeenCalledWith({
      failureReason: 'VIDEO_UNAVAILABLE_OR_PRIVATE',
      error: 'private',
      batchIndex: 0,
    });
    expect(video.listenerCount('timeupdate')).toBe(0);
    expect(scheduler.getDebugState().active).toBe(false);
  });

  test('createGeminiPortFetcher handles TRANSCRIBE_WINDOW, CANCEL_BATCH, PING, timeout, and dispose', async () => {
    jest.useFakeTimers();
    const msgListeners = [];
    const discListeners = [];
    const mockPort = {
      name: 'yousub-gemini-video',
      postMessage: jest.fn(),
      disconnect: jest.fn(),
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
      onDisconnect: { addListener: (fn) => discListeners.push(fn) },
    };
    chrome.runtime.connect.mockReturnValueOnce(mockPort);

    const fetcher = createGeminiPortFetcher();
    const controller = new AbortController();

    const p1 = fetcher.fetchBatch({
      videoId: 'v1',
      batchIndex: 0,
      startSec: 0,
      endSec: 240,
      durationSec: 600,
      targetLang: 'vi',
      windowSec: 240,
      signal: controller.signal,
    });

    const sent = mockPort.postMessage.mock.calls[0][0];
    expect(sent.type).toBe('TRANSCRIBE_WINDOW');

    // Keepalive PING at 25s
    jest.advanceTimersByTime(25000);
    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'PING' });

    // Deliver result
    msgListeners.forEach((fn) =>
      fn({
        type: 'BATCH_RESULT',
        requestId: sent.requestId,
        success: true,
        batchIndex: 0,
        entries: [],
      })
    );
    expect(await p1).toMatchObject({ success: true, batchIndex: 0 });

    // Abort sends CANCEL_BATCH
    const p2 = fetcher.fetchBatch({
      videoId: 'v1',
      batchIndex: 1,
      startSec: 240,
      endSec: 480,
      durationSec: 600,
      targetLang: 'vi',
      windowSec: 240,
      signal: controller.signal,
    });
    controller.abort();
    expect(await p2).toMatchObject({ success: false, failureReason: 'ABORTED' });
    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CANCEL_BATCH' })
    );

    fetcher.dispose();
    expect(mockPort.disconnect).toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('createGeminiPortFetcher handles timeout and unexpected port disconnect', async () => {
    jest.useFakeTimers();
    const msgListeners = [];
    const discListeners = [];
    const mockPort = {
      name: 'yousub-gemini-video',
      postMessage: jest.fn(),
      disconnect: jest.fn(),
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
      onDisconnect: { addListener: (fn) => discListeners.push(fn) },
    };
    chrome.runtime.connect.mockReturnValueOnce(mockPort);

    const fetcher = createGeminiPortFetcher();
    const pTimeout = fetcher.fetchBatch({
      videoId: 'v-t',
      batchIndex: 0,
      startSec: 0,
      endSec: 240,
      durationSec: 600,
      targetLang: 'vi',
      windowSec: 240,
    });
    jest.advanceTimersByTime(95000);
    expect(await pTimeout).toMatchObject({ failureReason: 'TIMEOUT_BACKGROUND' });

    const pDisc = fetcher.fetchBatch({
      videoId: 'v-d',
      batchIndex: 1,
      startSec: 240,
      endSec: 480,
      durationSec: 600,
      targetLang: 'vi',
      windowSec: 240,
    });
    discListeners.forEach((fn) => fn());
    expect(await pDisc).toMatchObject({ failureReason: 'PORT_DISCONNECTED' });

    fetcher.dispose();
    jest.useRealTimers();
  });
});
