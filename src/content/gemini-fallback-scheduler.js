import { devLog, devWarn } from '../shared/constants.js';

export const DEFAULT_GEMINI_WINDOW_SEC = 240;

const FATAL_REASONS = new Set([
  'VIDEO_UNAVAILABLE_OR_PRIVATE',
  'NO_GEMINI_KEY',
  'INVALID_API_KEY',
  'INVALID_VIDEO_ID',
]);

/**
 * Port-backed batch fetcher that communicates with the background service worker's
 * `yousub-gemini-video` port, keeping the SW alive during long multimodal calls
 * and supporting per-batch cancellation on seek jumps.
 */
export function createGeminiPortFetcher() {
  let port = null;
  let keepaliveTimer = null;
  let reqCounter = 0;
  const pending = new Map();

  function ensurePort() {
    if (port) return port;
    if (!chrome.runtime || !chrome.runtime.id) {
      throw new Error('CONTEXT_INVALIDATED');
    }

    port = chrome.runtime.connect({ name: 'yousub-gemini-video' });
    keepaliveTimer = setInterval(() => {
      try {
        if (port) port.postMessage({ type: 'PING' });
      } catch {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
    }, 25000);

    port.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'BATCH_RESULT') return;
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      pending.delete(msg.requestId);
      entry.finish({
        success: !!msg.success,
        batchIndex: msg.batchIndex,
        entries: msg.entries || [],
        model: msg.model,
        failureReason: msg.failureReason,
        error: msg.error,
      });
    });

    port.onDisconnect.addListener(() => {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      port = null;
      for (const [id, entry] of pending.entries()) {
        pending.delete(id);
        entry.finish({
          success: false,
          batchIndex: entry.batchIndex,
          failureReason: 'PORT_DISCONNECTED',
          error: 'Background port disconnected',
        });
      }
    });

    return port;
  }

  function fetchBatch({
    videoId,
    batchIndex,
    startSec,
    endSec,
    durationSec,
    targetLang,
    windowSec,
    signal,
  }) {
    if (signal?.aborted) {
      return Promise.resolve({ success: false, batchIndex, failureReason: 'ABORTED' });
    }

    let activePort;
    try {
      activePort = ensurePort();
    } catch (err) {
      return Promise.resolve({
        success: false,
        batchIndex,
        failureReason: err.message || 'INTERNAL_ERROR',
      });
    }

    const requestId = `gemini_batch_${++reqCounter}`;

    return new Promise((resolve) => {
      let settled = false;
      let timeoutId = null;
      let abortListener = null;

      function finish(result) {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (signal && abortListener) {
          signal.removeEventListener('abort', abortListener);
        }
        resolve(result);
      }

      pending.set(requestId, { batchIndex, finish });

      timeoutId = setTimeout(() => {
        pending.delete(requestId);
        try {
          activePort.postMessage({ type: 'CANCEL_BATCH', requestId });
        } catch {
          /* ignore */
        }
        finish({
          success: false,
          batchIndex,
          failureReason: 'TIMEOUT_BACKGROUND',
          error: 'Gemini video batch timed out',
        });
      }, 95000);

      if (signal) {
        abortListener = () => {
          pending.delete(requestId);
          try {
            activePort.postMessage({ type: 'CANCEL_BATCH', requestId });
          } catch {
            /* ignore */
          }
          finish({ success: false, batchIndex, failureReason: 'ABORTED' });
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }

      try {
        activePort.postMessage({
          type: 'TRANSCRIBE_WINDOW',
          requestId,
          videoId,
          batchIndex,
          startSec,
          endSec,
          durationSec,
          targetLang,
          windowSec,
        });
      } catch (err) {
        pending.delete(requestId);
        finish({
          success: false,
          batchIndex,
          failureReason: 'PORT_DISCONNECTED',
          error: err.message,
        });
      }
    });
  }

  function dispose() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    for (const [id, entry] of pending.entries()) {
      pending.delete(id);
      entry.finish({ success: false, batchIndex: entry.batchIndex, failureReason: 'ABORTED' });
    }
    if (port) {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      port = null;
    }
  }

  return { fetchBatch, dispose };
}

/**
 * Playback-driven 1-batch lookahead & seek-jump scheduler ("watch-to-fetch").
 *
 * Rules:
 * 1. Current batch priority: if playback is in batch k and k !== DONE, run k now.
 * 2. 1-batch lookahead: once k === DONE, prefetch k + 1 if PENDING, then STOP & WAIT
 *    until playback actually enters k + 1 before prefetching k + 2.
 * 3. Seek jump (e.g. batch 1 -> batch 6): abort stale in-flight prefetch, run batch 6
 *    first, immediately prefetch batch 7, then wait until playback enters batch 7.
 * 4. Backward/repeat seek to an already-DONE batch triggers zero network requests.
 */
export function createGeminiFallbackScheduler({
  videoId,
  videoElement,
  targetLang = 'vi',
  windowSec = DEFAULT_GEMINI_WINDOW_SEC,
  initialCompletedBatches = [],
  fetchBatch,
  onEntries,
  onBatchStart,
  onBatchComplete,
  onFatalError,
  onBatchError,
}) {
  const batchStates = new Map();
  if (Array.isArray(initialCompletedBatches)) {
    for (const idx of initialCompletedBatches) {
      if (Number.isInteger(idx) && idx >= 0) {
        batchStates.set(idx, 'DONE');
      }
    }
  }

  let active = false;
  let inFlight = null;
  let runToken = 0;

  function getKnownDuration() {
    if (!videoElement) return null;
    const d = videoElement.duration;
    return Number.isFinite(d) && d > 0 ? d : null;
  }

  function getTotalBatches() {
    const duration = getKnownDuration();
    if (duration === null) return null;
    return Math.max(1, Math.ceil(duration / windowSec));
  }

  function getCurrentBatchIndex() {
    const time = Math.max(0, Number(videoElement?.currentTime) || 0);
    const raw = Math.floor(time / windowSec);
    const total = getTotalBatches();
    return total !== null ? Math.min(raw, total - 1) : raw;
  }

  function getState(batchIndex) {
    return batchStates.get(batchIndex) || 'PENDING';
  }

  function cancelInFlight() {
    if (!inFlight) return;
    const prev = inFlight;
    inFlight = null;
    if (batchStates.get(prev.batchIndex) === 'IN_FLIGHT') {
      batchStates.set(prev.batchIndex, 'PENDING');
    }
    prev.controller.abort();
  }

  function launchBatch(batchIndex, isPrefetch) {
    const duration = getKnownDuration();
    const startSec = batchIndex * windowSec;
    if (duration !== null && startSec >= duration) {
      return;
    }
    const endSec =
      duration !== null
        ? Math.min((batchIndex + 1) * windowSec, duration)
        : (batchIndex + 1) * windowSec;
    if (endSec <= startSec) return;

    const controller = new AbortController();
    const token = ++runToken;
    batchStates.set(batchIndex, 'IN_FLIGHT');
    inFlight = { batchIndex, isPrefetch, controller, token };

    const totalBatches = getTotalBatches();
    devLog(
      `[YouSub] GeminiScheduler: Starting batch #${batchIndex + 1}` +
        (totalBatches ? `/${totalBatches}` : '') +
        ` (${startSec}s-${endSec}s, prefetch=${isPrefetch})`
    );

    if (onBatchStart) {
      onBatchStart({ batchIndex, isPrefetch, totalBatches });
    }

    let fetchPromise;
    try {
      fetchPromise = Promise.resolve(
        fetchBatch({
          videoId,
          batchIndex,
          startSec,
          endSec,
          durationSec: duration,
          targetLang,
          windowSec,
          signal: controller.signal,
        })
      );
    } catch (syncErr) {
      fetchPromise = Promise.reject(syncErr);
    }

    fetchPromise
      .then((res) => {
        if (!active || !inFlight || inFlight.token !== token) {
          return;
        }
        const wasPrefetch = inFlight.isPrefetch;
        inFlight = null;

        if (!res || res.failureReason === 'ABORTED') {
          if (batchStates.get(batchIndex) === 'IN_FLIGHT') {
            batchStates.set(batchIndex, 'PENDING');
          }
          evaluate();
          return;
        }

        if (res.success) {
          batchStates.set(batchIndex, 'DONE');
          const entries = Array.isArray(res.entries) ? res.entries : [];
          if (onEntries && entries.length > 0) {
            onEntries(entries, batchIndex);
          }
          if (onBatchComplete) {
            onBatchComplete({
              batchIndex,
              isPrefetch: wasPrefetch,
              entryCount: entries.length,
              totalBatches: getTotalBatches(),
            });
          }
          // Immediately evaluate so completing current batch triggers 1-batch lookahead.
          evaluate();
          return;
        }

        const reason = res.failureReason || 'GEMINI_ERROR';
        batchStates.set(batchIndex, 'FAILED');
        devWarn(
          `[YouSub] GeminiScheduler: Batch #${batchIndex + 1} failed (${reason}):`,
          res.error
        );

        if (FATAL_REASONS.has(reason)) {
          stop();
          if (onFatalError) {
            onFatalError({ failureReason: reason, error: res.error, batchIndex });
          }
          return;
        }

        if (onBatchError) {
          onBatchError({
            failureReason: reason,
            error: res.error,
            batchIndex,
            isPrefetch: wasPrefetch,
          });
        }
        evaluate();
      })
      .catch((err) => {
        if (!active || !inFlight || inFlight.token !== token) return;
        const wasPrefetch = inFlight.isPrefetch;
        inFlight = null;
        batchStates.set(batchIndex, 'FAILED');
        if (onBatchError) {
          onBatchError({
            failureReason: 'GEMINI_ERROR',
            error: err?.message || 'Unexpected error',
            batchIndex,
            isPrefetch: wasPrefetch,
          });
        }
      });
  }

  function evaluate() {
    if (!active || !videoElement) return;

    const current = getCurrentBatchIndex();
    const next = current + 1;
    const total = getTotalBatches();
    const hasNext = total === null || next < total;
    const currentState = getState(current);

    if (inFlight) {
      const runningIdx = inFlight.batchIndex;
      const isCurrent = runningIdx === current;
      const isValidLookahead = currentState === 'DONE' && hasNext && runningIdx === next;

      if (isCurrent) {
        if (inFlight.isPrefetch) {
          // User sought into the batch currently being prefetched — promote to foreground.
          inFlight.isPrefetch = false;
          if (onBatchStart) {
            onBatchStart({ batchIndex: current, isPrefetch: false, totalBatches: total });
          }
        }
        return;
      }

      if (isValidLookahead) {
        return;
      }

      // User jumped away from the active/prefetched region — cancel stale work immediately.
      cancelInFlight();
    }

    if (currentState === 'PENDING') {
      launchBatch(current, false);
      return;
    }

    if (currentState === 'DONE' && hasNext && getState(next) === 'PENDING') {
      launchBatch(next, true);
    }
  }

  const onPlaybackEvent = () => evaluate();

  function start() {
    if (active) return;
    if (!videoElement) return;
    active = true;
    videoElement.addEventListener('timeupdate', onPlaybackEvent);
    videoElement.addEventListener('seeked', onPlaybackEvent);
    videoElement.addEventListener('loadedmetadata', onPlaybackEvent);
    videoElement.addEventListener('durationchange', onPlaybackEvent);
    evaluate();
  }

  function retry() {
    if (!active) return;
    for (const [idx, state] of batchStates.entries()) {
      if (state === 'FAILED') {
        batchStates.set(idx, 'PENDING');
      }
    }
    evaluate();
  }

  function stop() {
    if (!active && !inFlight) return;
    active = false;
    cancelInFlight();
    if (videoElement) {
      videoElement.removeEventListener('timeupdate', onPlaybackEvent);
      videoElement.removeEventListener('seeked', onPlaybackEvent);
      videoElement.removeEventListener('loadedmetadata', onPlaybackEvent);
      videoElement.removeEventListener('durationchange', onPlaybackEvent);
    }
  }

  function getDebugState() {
    const states = {};
    for (const [k, v] of batchStates.entries()) {
      states[k] = v;
    }
    return {
      active,
      windowSec,
      currentBatch: getCurrentBatchIndex(),
      totalBatches: getTotalBatches(),
      inFlight: inFlight
        ? { batchIndex: inFlight.batchIndex, isPrefetch: inFlight.isPrefetch }
        : null,
      batchStates: states,
    };
  }

  return {
    start,
    stop,
    retry,
    evaluate,
    getDebugState,
  };
}
