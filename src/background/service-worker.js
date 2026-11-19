/**
 * service-worker.js — YouSub Background Service Worker
 *
 * Central router for all background operations:
 * 1. Translation requests (with caching)
 * 2. Proxy fetching for subtitle tracks
 * 3. Cache management (clear, check, remove)
 * 4. API Key testing
 */

import '../shared/libs/browser-polyfill.js';
import { translate } from './translator.js';
import { Logger } from '../shared/logger.js';
import { Providers } from './providers.js';
import { Cache } from './cache.js';
import { HealthManager } from './health.js';
import { hasActiveGeminiKey, transcribeVideoWindow } from './video-transcriber.js';
import { PipelineTelemetry } from '../shared/pipeline-telemetry.js';

function getGeminiWindowBounds(batchIndex, durationSec, windowSec = 240) {
  const safeIdx = Number.isInteger(batchIndex) && batchIndex >= 0 ? batchIndex : 0;
  const startSec = safeIdx * windowSec;
  const endSec =
    Number.isFinite(durationSec) && durationSec > 0
      ? Math.min((safeIdx + 1) * windowSec, durationSec)
      : (safeIdx + 1) * windowSec;
  return {
    startMs: Math.round(startSec * 1000),
    endMs: Math.round(Math.max(startSec, endSec) * 1000),
  };
}

Logger.info('ServiceWorker', 'Background Service Worker loaded.');

async function writeVideoStats(videoId, statsPayload) {
  if (!videoId) return;
  try {
    await browser.storage.local.set({ [`yousub_stats_${videoId}`]: statsPayload });
  } catch (e) {
    Logger.warn('ServiceWorker', 'Failed to persist video stats', { videoId, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// Port-based Streaming Router (Phase 50.2)
// ---------------------------------------------------------------------------

// Phase 54.2: Track active ports for debugging and cleanup
const activePorts = new Map();
let portIdCounter = 0;

browser.runtime.onConnect.addListener(function (port) {
  if (port.name === 'yousub-stream') {
    // Phase 52.1: Per-port abort controller for cleanup on disconnect
    const portAbort = new AbortController();
    const portId = ++portIdCounter;
    const tabId = port.sender && port.sender.tab ? port.sender.tab.id : 'unknown';
    let latestPlayheadMs = 0;
    let activeVideoId = null;

    activePorts.set(portId, { tabId, connectedAt: Date.now() });
    Logger.debug(
      'ServiceWorker',
      `Port #${portId} connected (tab ${tabId}). Active ports: ${activePorts.size}`
    );

    port.onMessage.addListener(async function (request) {
      // Phase 52.1: Keepalive — respond to PING with PONG
      if (request.type === 'PING') {
        try {
          port.postMessage({ type: 'PONG' });
        } catch {
          /* port disconnected */
        }
        return;
      }

      if (request.type === 'SEEK_PRIORITY') {
        if (typeof request.playheadMs === 'number' && Number.isFinite(request.playheadMs)) {
          latestPlayheadMs = Math.max(0, request.playheadMs);
          Logger.info(
            'ServiceWorker',
            `[SEEK_PRIORITY] Updating priority playhead to ${latestPlayheadMs}ms`,
            {
              videoId: activeVideoId,
              playheadMs: latestPlayheadMs,
              tabId,
            }
          );
          if (activeVideoId) {
            Promise.resolve(PipelineTelemetry.recordSeek(activeVideoId, latestPlayheadMs)).catch(
              () => {}
            );
          }
        }
        return;
      }

      if (request.type === 'YOUSUB_TRANSLATE_STREAM') {
        const {
          segments,
          videoId,
          sourceLang,
          targetLang,
          playheadMs,
          coalesceStats,
          extractionSource,
          mode,
        } = request;
        const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
        activeVideoId = videoId || null;
        latestPlayheadMs =
          typeof playheadMs === 'number' && Number.isFinite(playheadMs)
            ? Math.max(0, playheadMs)
            : 0;

        try {
          // 1. Check Cache First (verify cue count matches coalesced segments)
          const cached = await Cache.get(videoId, sourceLang || 'auto', targetLang);
          const cacheCompatible =
            !Array.isArray(segments) ||
            segments.length === 0 ||
            (Array.isArray(cached) && cached.length === segments.length);

          if (cached && cacheCompatible) {
            if (videoId) {
              await writeVideoStats(videoId, {
                source: 'cache',
                cueCount: cached.length,
                coalescer: coalesceStats || null,
                timestamp: Date.now(),
              });
              await PipelineTelemetry.update(videoId, {
                mode: 'cache',
                stage: 'COMPLETE',
                extraction: {
                  source: extractionSource || 'cache',
                  sourceLang: sourceLang || 'auto',
                  targetLang: targetLang || 'vi',
                },
                ...(coalesceStats ? { coalescer: coalesceStats } : {}),
                sink: {
                  syncedCues: cached.length,
                  totalCues: cached.length,
                  cached: true,
                  cacheType: 'memory',
                },
              });
            }
            try {
              port.postMessage({ type: 'COMPLETE', translated: cached, fromCache: true });
            } catch {
              /* disconnected */
            }
            return;
          } else if (cached && !cacheCompatible) {
            Logger.warn('ServiceWorker', 'Skipping length-mismatched cached entry', {
              videoId,
              cachedLength: cached.length,
              segmentCount: segments.length,
            });
          }

          if (videoId) {
            await browser.storage.local.remove([`yousub_stats_${videoId}`]);
            await PipelineTelemetry.update(videoId, {
              mode: mode || 'transcript',
              stage: 'ROUTE',
              playheadMs: latestPlayheadMs,
              extraction: {
                source: extractionSource || 'transcript',
                sourceLang: sourceLang || 'auto',
                targetLang: targetLang || 'vi',
              },
              ...(coalesceStats ? { coalescer: coalesceStats } : {}),
            });
          }

          // 2. Start Streaming Pipeline — pass portAbort.signal & seek-aware playhead options
          const result = await translate(
            segments,
            sourceLang,
            targetLang,
            tabId,
            (startIndex, batchTranslated, chunk) => {
              try {
                port.postMessage({
                  type: 'CHUNK',
                  startIndex,
                  translated: batchTranslated,
                  chunk: chunk,
                });
              } catch {
                Logger.debug('ServiceWorker', 'Port disconnected, chunk dropped.');
              }
            },
            portAbort.signal,
            () => {
              // Phase 64 (a): per-batch heartbeat so the content idle watchdog can
              // tell a stalled background from a slow-but-advancing one.
              try {
                port.postMessage({ type: 'PROGRESS' });
              } catch {
                /* disconnected */
              }
            },
            {
              videoId,
              initialPlayheadMs: latestPlayheadMs,
              getPlayheadMs: () => latestPlayheadMs,
              coalesceStats,
              onStatsUpdate: (liveStats) => {
                if (videoId) {
                  writeVideoStats(videoId, {
                    source: 'api',
                    model: liveStats?.model || 'unknown',
                    provider: liveStats?.provider || '',
                    totalTokens: liveStats?.totalTokens || 0,
                    promptTokens: liveStats?.promptTokens || 0,
                    completionTokens: liveStats?.completionTokens || 0,
                    durationMs: liveStats?.durationMs || 0,
                    batchCount: liveStats?.batchCount || 0,
                    coalescer: coalesceStats || null,
                    timestamp: Date.now(),
                  });
                }
              },
            }
          );

          if (result.success) {
            if (!result.hadFallback) {
              await Cache.set(videoId, sourceLang || 'auto', targetLang, result.translated);
            }
            if (videoId) {
              await writeVideoStats(videoId, {
                source: 'api',
                model: result.stats?.model || 'unknown',
                provider: result.stats?.provider || '',
                totalTokens: result.stats?.totalTokens || 0,
                promptTokens: result.stats?.promptTokens || 0,
                completionTokens: result.stats?.completionTokens || 0,
                durationMs: result.stats?.durationMs || 0,
                batchCount: result.stats?.batchCount || 0,
                coalescer: coalesceStats || null,
                timestamp: Date.now(),
              });
              await PipelineTelemetry.update(videoId, {
                stage: 'COMPLETE',
                sink: {
                  syncedCues: result.translated?.length || segments?.length || 0,
                  totalCues: segments?.length || 0,
                  cached: !result.hadFallback,
                  cacheType: result.hadFallback ? 'none' : 'memory',
                },
              });
            }
            try {
              port.postMessage({ type: 'COMPLETE', ...result });
            } catch {
              /* disconnected */
            }
          } else {
            try {
              port.postMessage({ type: 'ERROR', ...result });
            } catch {
              /* disconnected */
            }
          }
        } catch (err) {
          Logger.error('ServiceWorker', `Stream Port Error: ${err.message}`);
          if (videoId) {
            Promise.resolve(
              PipelineTelemetry.update(videoId, {
                stage: 'ERROR',
                error: { failureReason: 'STREAM_CRASH', message: err.message },
              })
            ).catch(() => {});
          }
          try {
            port.postMessage({ type: 'ERROR', error: err.message, failureReason: 'STREAM_CRASH' });
          } catch {
            /* disconnected */
          }
        }
      }
    });

    port.onDisconnect.addListener(() => {
      activePorts.delete(portId);
      Logger.debug(
        'ServiceWorker',
        `Port #${portId} disconnected. Aborting in-flight translation. Active ports: ${activePorts.size}`
      );
      portAbort.abort();
    });
  } else if (port.name === 'yousub-gemini-video') {
    const portId = ++portIdCounter;
    const tabId = port.sender && port.sender.tab ? port.sender.tab.id : 'unknown';
    const inFlightBatches = new Map();
    const geminiSessionStats = {
      batchCount: 0,
      durationMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    activePorts.set(portId, { tabId, connectedAt: Date.now() });
    Logger.debug('ServiceWorker', `Gemini video port #${portId} connected (tab ${tabId}).`);

    port.onMessage.addListener(async function (request) {
      if (request.type === 'PING') {
        try {
          port.postMessage({ type: 'PONG' });
        } catch {
          /* port disconnected */
        }
        return;
      }

      if (request.type === 'CANCEL_BATCH') {
        const controller = inFlightBatches.get(request.requestId);
        if (controller) {
          inFlightBatches.delete(request.requestId);
          controller.abort();
        }
        return;
      }

      if (request.type === 'TRANSCRIBE_WINDOW') {
        const { requestId, ...params } = request;
        const controller = new AbortController();
        inFlightBatches.set(requestId, controller);

        if (params.videoId) {
          const wSec = params.windowSec || 240;
          const totalWindows =
            Number.isFinite(params.durationSec) && params.durationSec > 0
              ? Math.ceil(params.durationSec / wSec)
              : null;
          const range = getGeminiWindowBounds(params.batchIndex, params.durationSec, wSec);
          PipelineTelemetry.update(params.videoId, (snap) => {
            const batches = Array.isArray(snap.batches) ? [...snap.batches] : [];
            const targetLen =
              totalWindows || Math.max(batches.length, (params.batchIndex || 0) + 1);
            while (batches.length < targetLen) {
              const idx = batches.length;
              const r = getGeminiWindowBounds(idx, params.durationSec, wSec);
              batches.push({
                batchIndex: idx,
                startLine: idx + 1,
                endLine: idx + 1,
                startMs: r.startMs,
                endMs: r.endMs,
                status: 'PENDING',
              });
            }
            if (batches[params.batchIndex]) {
              batches[params.batchIndex] = {
                ...batches[params.batchIndex],
                startMs: range.startMs,
                endMs: range.endMs,
                status: params.isPrefetch ? 'PREFETCH' : 'IN_FLIGHT',
                isSeekTarget: !!params.isSeekTarget,
              };
            }
            return {
              ...snap,
              mode: 'gemini-video',
              stage: 'ROUTE',
              extraction: {
                ...snap.extraction,
                source: 'gemini-url',
                targetLang: params.targetLang || 'vi',
              },
              router: {
                ...snap.router,
                activeProvider: 'google',
                activeModel: snap.router?.activeModel || 'gemini-2.5-flash',
              },
              batches,
            };
          });
        }

        try {
          const result = await transcribeVideoWindow({
            ...params,
            signal: controller.signal,
          });
          inFlightBatches.delete(requestId);

          if (params.videoId && result.success) {
            geminiSessionStats.batchCount++;
            geminiSessionStats.durationMs += result.durationMs || 0;
            geminiSessionStats.promptTokens += result.usage?.promptTokens || 0;
            geminiSessionStats.completionTokens += result.usage?.completionTokens || 0;
            geminiSessionStats.totalTokens += result.usage?.totalTokens || 0;

            await writeVideoStats(params.videoId, {
              source: 'gemini-video',
              model: result.model || 'gemini-2.5-flash',
              provider: 'google',
              ...geminiSessionStats,
              timestamp: Date.now(),
            });

            PipelineTelemetry.update(params.videoId, (snap) => {
              const batches = Array.isArray(snap.batches) ? [...snap.batches] : [];
              if (batches[params.batchIndex]) {
                batches[params.batchIndex] = {
                  ...batches[params.batchIndex],
                  status: 'DONE',
                  provider: 'google',
                  model: result.model || 'gemini-2.5-flash',
                  keyMask: result.keyMask || '',
                  durationMs: result.durationMs || 0,
                  isSeekTarget: false,
                };
              }
              const anyWorking = batches.some((b) => b.status === 'IN_FLIGHT');
              const doneCount = batches.filter((b) => b.status === 'DONE').length;
              const synced = (snap.sink?.syncedCues || 0) + (result.entries?.length || 0);
              return {
                ...snap,
                mode: 'gemini-video',
                stage: anyWorking ? 'ROUTE' : 'COMPLETE',
                router: {
                  ...snap.router,
                  activeProvider: 'google',
                  activeModel: result.model || 'gemini-2.5-flash',
                  keyMask: result.keyMask || '',
                  latencyMs: result.durationMs || 0,
                },
                batches,
                sink: {
                  syncedCues: synced,
                  totalCues: synced,
                  cached: true,
                  cacheType: 'generated',
                },
                metrics: {
                  ...geminiSessionStats,
                  completedBatches: doneCount,
                },
              };
            });
          } else if (params.videoId && !result.success && result.failureReason !== 'ABORTED') {
            PipelineTelemetry.update(params.videoId, (snap) => {
              const batches = Array.isArray(snap.batches) ? [...snap.batches] : [];
              if (batches[params.batchIndex]) {
                batches[params.batchIndex] = { ...batches[params.batchIndex], status: 'FAILED' };
              }
              return {
                ...snap,
                stage: 'ERROR',
                batches,
                error: { failureReason: result.failureReason, message: result.error },
              };
            });
          }

          try {
            port.postMessage({ type: 'BATCH_RESULT', requestId, ...result });
          } catch {
            /* port disconnected */
          }
        } catch (err) {
          inFlightBatches.delete(requestId);
          try {
            port.postMessage({
              type: 'BATCH_RESULT',
              requestId,
              batchIndex: params.batchIndex,
              success: false,
              failureReason: controller.signal.aborted ? 'ABORTED' : 'GEMINI_ERROR',
              error: err.message,
            });
          } catch {
            /* port disconnected */
          }
        }
      }
    });

    port.onDisconnect.addListener(() => {
      activePorts.delete(portId);
      for (const controller of inFlightBatches.values()) {
        controller.abort();
      }
      inFlightBatches.clear();
      Logger.debug('ServiceWorker', `Gemini video port #${portId} disconnected; aborted batches.`);
    });
  }
});

// ---------------------------------------------------------------------------
// Message Router
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.type !== 'YOUSUB_LOG_BATCH') {
    Logger.debug('ServiceWorker', `Received message: ${request.type}`);
  }

  // Route to specific handlers
  handleRequest(request, sender)
    .then((response) => {
      sendResponse(response);
    })
    .catch((err) => {
      Logger.error('ServiceWorker', `Router Error: ${err.message}`);
      sendResponse({ success: false, failureReason: 'BACKGROUND_CRASH', error: err.message });
    });

  return true; // Keep channel open for async response
});

/**
 * Central handler for all requests to ensure async consistency
 */
async function handleRequest(request, sender) {
  // 1. YOUSUB_TRANSLATE_REQUEST
  if (request.type === 'YOUSUB_TRANSLATE_REQUEST') {
    const { segments, videoId, sourceLang, targetLang } = request;
    const tabId = sender.tab ? sender.tab.id : null;

    Logger.info(
      'ServiceWorker',
      `Incoming translation request for ${videoId} (${segments.length} segments)`
    );

    const cached = await Cache.get(videoId, sourceLang || 'auto', targetLang);
    if (cached) {
      Logger.info('ServiceWorker', `Cache HIT for ${videoId}`);
      const cacheStats = { source: 'cache', timestamp: Date.now() };
      await browser.storage.local.set({ [`yousub_stats_${videoId}`]: cacheStats });
      return { success: true, translated: cached, fromCache: true };
    }

    Logger.info('ServiceWorker', `Cache MISS for ${videoId}. Starting translation pipeline...`);
    await browser.storage.local.remove([`yousub_stats_${videoId}`]);

    const result = await translate(segments, sourceLang, targetLang, tabId);
    if (result.success && !result.hadFallback) {
      await Cache.set(videoId, sourceLang || 'auto', targetLang, result.translated);
    }

    if (result.success) {
      const stats = {
        source: 'api',
        model: result.stats?.model || 'unknown',
        totalTokens: result.stats?.totalTokens || 0,
        promptTokens: result.stats?.promptTokens || 0,
        completionTokens: result.stats?.completionTokens || 0,
        durationMs: result.stats?.durationMs || 0,
        batchCount: result.stats?.batchCount || 0,
        timestamp: Date.now(),
      };
      await browser.storage.local.set({ [`yousub_stats_${videoId}`]: stats });
    }
    return result;
  }

  // 2. YOUSUB_FETCH_TEXT
  if (request.type === 'YOUSUB_FETCH_TEXT') {
    const res = await fetch(request.url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return { success: true, text };
  }

  // 3. YOUSUB_CHECK_CACHE
  if (request.type === 'YOUSUB_CHECK_CACHE') {
    // Source-language-agnostic: this probe fires before extraction, so the concrete
    // source language is unknown. Match any cached translation for (videoId,
    // targetLang) so auto-start still fires after source languages entered the cache
    // key (Decision 16 / Phase B-c). The subsequent stream serve uses the exact
    // (videoId, sl, tl) key once extraction derives the concrete source language.
    const exists = await Cache.hasAnyForVideoTarget(request.videoId, request.targetLang);
    return { exists };
  }

  // 4. YOUSUB_CLEAR_VIDEO_CACHE
  if (request.type === 'YOUSUB_CLEAR_VIDEO_CACHE') {
    await Cache.removeByVideoId(request.videoId);
    await PipelineTelemetry.clear(request.videoId);
    broadcastToTabs({ type: 'YOUSUB_CACHE_CLEARED', videoId: request.videoId });
    return { success: true };
  }

  // 5. YOUSUB_CLEAR_CACHE
  if (request.type === 'YOUSUB_CLEAR_CACHE') {
    const count = await Cache.clearAll();
    await PipelineTelemetry.clear();
    broadcastToTabs({ type: 'YOUSUB_CACHE_CLEARED' });
    return { success: true, count };
  }

  // 6. YOUSUB_TEST_API_KEY
  if (request.type === 'YOUSUB_TEST_API_KEY') {
    return await Providers.testApiKey(request.provider, request.model, request.apiKey);
  }

  // 7. YOUSUB_OPEN_SETTINGS
  if (request.type === 'YOUSUB_OPEN_SETTINGS') {
    Promise.resolve(browser.runtime.openOptionsPage()).catch(() => {});
    return { success: true };
  }

  // 8. YOUSUB_GET_HEALTH_SUMMARY
  if (request.type === 'YOUSUB_GET_HEALTH_SUMMARY') {
    const resSet = await browser.storage.local.get(['yousub_api_keys']);
    const summary = await HealthManager.getSummary(resSet.yousub_api_keys || []);
    return { success: true, summary };
  }

  // 9. YOUSUB_FETCH_OLLAMA_MODELS (Phase 50.3)
  if (request.type === 'YOUSUB_FETCH_OLLAMA_MODELS') {
    const { endpoint } = request; // e.g. http://localhost:11434/api/tags
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return { success: true, models: data.models || [] };
  }

  // 10. YOUSUB_CHECK_GEMINI_AVAILABLE (Phase 78)
  if (request.type === 'YOUSUB_CHECK_GEMINI_AVAILABLE') {
    const resSet = await browser.storage.local.get(['yousub_gemini_fallback_enabled']);
    const enabled = resSet.yousub_gemini_fallback_enabled !== false;
    const hasKey = enabled ? await hasActiveGeminiKey() : false;
    return { available: enabled && hasKey, enabled, hasKey };
  }

  // 11. YOUSUB_GET_GENERATED_CACHE (Phase 78)
  if (request.type === 'YOUSUB_GET_GENERATED_CACHE') {
    const cached = await Cache.getGenerated(request.videoId, request.targetLang);
    return { cached };
  }

  // 12. YOUSUB_SAVE_GENERATED_CACHE (Phase 78)
  if (request.type === 'YOUSUB_SAVE_GENERATED_CACHE') {
    await Cache.setGenerated(request.videoId, request.targetLang, request.payload || {});
    return { success: true };
  }

  // 13. YOUSUB_LOG_BATCH (Phase 84 — content-script JSONL log ingestion)
  if (request.type === 'YOUSUB_LOG_BATCH') {
    if (typeof Logger.appendExternalEntries === 'function') {
      Logger.appendExternalEntries(request.entries || []);
    }
    return { success: true };
  }

  return { success: false, failureReason: 'INVALID_REQUEST_TYPE' };
}

/**
 * Helper: Send message to all tabs
 */
function broadcastToTabs(msg) {
  Promise.resolve(browser.tabs.query({}))
    .then((tabs) => {
      (tabs || []).forEach((tab) => {
        Promise.resolve(browser.tabs.sendMessage(tab.id, msg)).catch(() => {});
      });
    })
    .catch(() => {});
}
