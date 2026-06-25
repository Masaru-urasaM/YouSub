import { Constants, devLog, devWarn } from '../shared/constants.js';
import { PageDetector } from './page-detector.js';
import { VideoBinder } from './video-binder.js';
import { SubtitleExtractor } from './subtitle-extractor.js';
import { SubtitleParser } from './subtitle-parser.js';
import { Overlay } from './overlay.js';
import { SyncEngine } from './sync-engine.js';
import { TrustedTypes } from '../shared/trusted-types.js';
import { escapeHtml as esc } from '../shared/utils.js';

// Init Security Policy
TrustedTypes.init();
// Expose for other modules that might not have direct import access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.TrustedTypes = TrustedTypes;
}

devLog('[YouSub] Main: Module loaded and executing...');

// ---------------------------------------------------------------------------
// Translation helper
// ---------------------------------------------------------------------------

/**
 * Streaming Translation Helper (Phase 50.2)
 */
function requestTranslationStreaming(
  parsedEntries,
  videoId,
  sourceLang,
  providedTargetLang,
  onUpdate
) {
  return new Promise(function (resolve) {
    let hasResolved = false;
    let keepaliveInterval = null;
    let port = null;

    // Phase 64 (a): Idle watchdog — replaces the old fixed 60s deadline.
    // Re-armed on every CHUNK and on every PROGRESS heartbeat (one per batch
    // boundary, success OR failure), so it measures *silence* (the background
    // making no progress through the work list), not total job time. The window
    // sits above the per-batch cap (90s) + a sweep cooldown wait (15s) + margin,
    // so a slow-but-advancing job (even one with consecutive failing batches)
    // never trips it — only a genuinely stalled background does. We deliberately
    // do NOT reset on PONG: that would reduce the watchdog to an "is the SW
    // alive" check, and SW death already surfaces as PORT_DISCONNECTED.
    const STREAM_IDLE_TIMEOUT_MS = 150000;
    let watchdog = null;

    function finish(result) {
      if (hasResolved) return;
      hasResolved = true;
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
      }
      resolve(result);
    }

    function armWatchdog() {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (hasResolved) return;
        console.error(
          '[YouSub] Main: Streaming translation stalled — no progress for ' +
            STREAM_IDLE_TIMEOUT_MS / 1000 +
            's'
        );
        // Phase 64 (c): disconnect so the background aborts in-flight work
        // (portAbort.abort) instead of running orphaned to its own cap.
        try {
          if (port) port.disconnect();
        } catch {
          /* already gone */
        }
        finish({ success: false, failureReason: 'TIMEOUT_BACKGROUND' });
      }, STREAM_IDLE_TIMEOUT_MS);
    }

    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        finish({ success: false, failureReason: 'CONTEXT_INVALIDATED' });
        return;
      }

      port = chrome.runtime.connect({ name: 'yousub-stream' });
      armWatchdog();

      // Phase 52.1: Keepalive — ping every 25s to keep the SW/event page alive.
      keepaliveInterval = setInterval(() => {
        try {
          port.postMessage({ type: 'PING' });
        } catch {
          clearInterval(keepaliveInterval);
        }
      }, 25000);

      const targetLang =
        providedTargetLang ||
        (typeof Constants !== 'undefined' ? Constants.DEFAULT_TARGET_LANG : 'vi');
      const segments = parsedEntries.map((e) => ({ text: e.text, startMs: e.startMs }));

      port.postMessage({
        type: 'YOUSUB_TRANSLATE_STREAM',
        videoId: videoId,
        segments: segments,
        sourceLang: sourceLang || 'auto',
        targetLang: targetLang,
      });

      port.onMessage.addListener((response) => {
        if (hasResolved) return;

        if (response.type === 'CHUNK') {
          armWatchdog(); // Phase 64 (a): streaming progress resets the idle timer
          const startIndex = response.startIndex;
          const translatedBatch = response.translated.map((text, i) => {
            const entry = parsedEntries[startIndex + i];
            return {
              startMs: entry.startMs,
              endMs: entry.endMs,
              original: entry.text,
              text: text || entry.text,
            };
          });
          if (onUpdate) onUpdate(translatedBatch, startIndex);
          return;
        }

        if (response.type === 'PROGRESS') {
          armWatchdog(); // Phase 64 (a): a completed batch attempt (success or fail) is progress
          return;
        }

        if (response.type === 'PONG') {
          // Keepalive ack — intentionally does NOT reset the watchdog (see above).
          return;
        }

        if (response.type === 'COMPLETE') {
          const fullTranslated = parsedEntries.map((entry, i) => ({
            startMs: entry.startMs,
            endMs: entry.endMs,
            original: entry.text,
            text: response.translated[i] || entry.text,
          }));
          finish({ success: true, translated: fullTranslated, fromCache: !!response.fromCache });
          try {
            port.disconnect();
          } catch {
            /* already gone */
          }
          return;
        }

        if (response.type === 'ERROR') {
          finish({
            success: false,
            failureReason: response.failureReason,
            error: response.error,
            failures: response.failures,
          });
          try {
            port.disconnect();
          } catch {
            /* already gone */
          }
          return;
        }
      });

      port.onDisconnect.addListener(() => {
        finish({ success: false, failureReason: 'PORT_DISCONNECTED' });
      });
    } catch (e) {
      finish({ success: false, failureReason: 'INTERNAL_ERROR', error: e.toString() });
    }
  });
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function processEntries(entries, videoId, targetLang) {
  try {
    devLog('[YouSub] Main: processEntries started. Count:', entries.length);
    if (!entries || entries.length === 0) return;

    SyncEngine.stop();
    Overlay.destroy();
    Overlay.setLoading(true);
    Overlay.show();

    const subtitles = entries.map(function (e) {
      return {
        startMs: e.startMs,
        endMs: e.endMs,
        original: e.text,
        text: e.text,
      };
    });

    devLog('[YouSub] Main: Starting SyncEngine with original text...');
    VideoBinder.bind(function (video) {
      devLog('[YouSub] Main: Video element available to SyncEngine');
      SyncEngine.start(subtitles, video);
    });

    devLog('[YouSub] Main: Requesting translation from worker...');

    let response;
    response = await requestTranslationStreaming(
      entries,
      videoId,
      'auto',
      targetLang,
      (partialBatch, startIndex) => {
        SyncEngine.updatePartial(partialBatch, startIndex);
      }
    );

    if (response.success === false) {
      devWarn('[YouSub] Main: Halting pipeline due to error');

      // Phase 64 (b): Preserve already-rendered partial translations on failure.
      // If any line was translated and streamed in via updatePartial, keep those
      // subtitles on screen instead of destroying the overlay; show a soft notice.
      const partialCount = SyncEngine.getTranslatedCount();
      if (partialCount > 0) {
        devWarn('[YouSub] Main: Preserving', partialCount, 'partial translations despite error');
        Overlay.setLoading(false);
        const reason = response.failureReason || 'Error';
        const notice = `<strong>Translation incomplete:</strong> ${partialCount}/${entries.length} lines translated. (${reason})`;
        Overlay.showStatus(TrustedTypes.toSafeHTML(notice), 'warning', 8000);
        return;
      }

      // Nothing translated yet — tear down and show the full error.
      SyncEngine.stop();
      Overlay.destroy();

      // Phase 66 (B1) / DEFERRED D1: esc is the imported escapeHtml(); it escapes any
      // value derived from API error text before it reaches innerHTML (the Overlay uses
      // a TrustedTypes passthrough policy). failureReason is an internal constant, but
      // escape it too for consistency.
      let msg = `<strong>Translation failed:</strong> ${esc(response.failureReason) || 'Error'}`;
      if (response.failures && response.failures.length > 0) {
        const unique = [];
        const seen = new Set();
        for (const f of response.failures) {
          const key = `${f.provider}_${f.model}_${f.status}`;
          if (!seen.has(key)) {
            seen.add(key);
            unique.push(f);
          }
        }
        const lines = unique.slice(0, 5).map((f) => {
          let detail = '';
          if (f.message) {
            const retryMatch = f.message.match(/try again in\s+([^\s.]+(?:\.\d+s?)?)/i);
            const limitMatch = f.message.match(/Limit\s+(\d+),\s*Used\s+(\d+)/);
            if (limitMatch) detail = `${esc(limitMatch[2])}/${esc(limitMatch[1])} used`;
            if (retryMatch) detail += (detail ? ', ' : '') + `retry ${esc(retryMatch[1])}`;
            if (!detail) detail = esc(f.message.substring(0, 80));
          }
          const status = f.status ? ` [${f.status}]` : '';
          return `${esc(f.provider)}/${esc(f.model)}${status}${detail ? ': ' + detail : ''}`;
        });
        msg += '<br><small>' + lines.join('<br>') + '</small>';
        if (unique.length > 5) msg += `<br><small>+ ${unique.length - 5} more</small>`;
        // Phase 64 (d): actionable hint when failures are rate-limit related.
        if (response.failures.some((f) => f.status === 429)) {
          msg += `<br><small>⚠ Rate limited — add more API keys or wait a minute.</small>`;
        }
      } else if (response.error) {
        msg += `<br><small>${response.error}</small>`;
      }

      Overlay.showStatus(TrustedTypes.toSafeHTML(msg), 'error', 20000);
      Overlay.setLoading(false);
      return;
    }

    if (response.translated && response.translated.length > 0) {
      devLog('[YouSub] Main: Final translated results merging...');
      const statusTitle = response.fromCache ? 'Loaded from cache' : 'Translation complete!';
      const statusType = response.fromCache ? 'info' : 'success';

      // Phase 36: Use TrustedTypes for security compliance on YouTube
      if (typeof window !== 'undefined' && window.YouSub && window.YouSub.TrustedTypes) {
        Overlay.showStatus(window.YouSub.TrustedTypes.toSafeHTML(statusTitle), statusType, 2000);
      } else {
        Overlay.showStatus(statusTitle, statusType, 2000);
      }

      SyncEngine.updateSubtitles(response.translated);
    }
    Overlay.setLoading(false);
  } catch (err) {
    console.error('[YouSub] Main: processEntries CRITICAL ERROR:', err);
    Overlay.setLoading(false);
  }
}

async function startSubtitlePipeline(videoId, targetLang) {
  try {
    devLog('[YouSub] Main: startSubtitlePipeline triggered for:', videoId);
    Overlay.setLoading(true);
    Overlay.show();

    SubtitleExtractor.extract(async function (tracks, parsedEntries, error) {
      try {
        devLog(
          '[YouSub] Main: Extractor results received. Entries:',
          parsedEntries ? parsedEntries.length : 0,
          'Tracks:',
          tracks ? tracks.length : 0,
          'Error:',
          error
        );

        if (parsedEntries && parsedEntries.length > 0) {
          await processEntries(parsedEntries, videoId, targetLang);
          return;
        }

        // Fallback: Use tracks directly (Phase 50.1.3)
        if (tracks && tracks.length > 0) {
          devLog('[YouSub] Main: Falling back to direct track fetch...');
          Overlay.showStatus('Fetching transcript data...', 'info', 2000);

          // Simple heuristic: Prefer English manual over English auto over first available
          let selectedTrack = tracks.find((t) => t.languageCode === 'en' && !t.isAutoGenerated);
          if (!selectedTrack) selectedTrack = tracks.find((t) => t.languageCode === 'en');
          if (!selectedTrack) selectedTrack = tracks[0];

          if (selectedTrack && selectedTrack.baseUrl) {
            try {
              const entries = await SubtitleParser.fetch(selectedTrack.baseUrl);
              if (entries && entries.length > 0) {
                devLog('[YouSub] Main: Fallback fetch SUCCESS. Entries:', entries.length);
                await processEntries(entries, videoId, targetLang);
                return;
              }
            } catch (fetchErr) {
              console.error('[YouSub] Main: Fallback fetch FAILED:', fetchErr);
            }
          }
        }

        if (!parsedEntries) {
          Overlay.showStatus('Could not find subtitles', 'warning', 4000);
          Overlay.setLoading(false);
        }
      } catch (innerErr) {
        console.error('[YouSub] Main: startSubtitlePipeline callback error:', innerErr);
        Overlay.setLoading(false);
      }
    });
  } catch (outerErr) {
    console.error('[YouSub] Main: startSubtitlePipeline critical error:', outerErr);
    Overlay.setLoading(false);
  }
}

// Init PageDetector
devLog('[YouSub] Main: Registering PageDetector callbacks...');
PageDetector.init(
  function onEnter(videoId) {
    devLog('[YouSub] Main: ON_ENTER fired for video:', videoId);

    Overlay.destroy();

    VideoBinder.bind(function (_videoEl) {
      devLog('[YouSub] Main: Video element bound properly. Checking storage...');

      chrome.storage.local.get(['yousub_translation_enabled', 'targetLang'], function (res) {
        if (chrome.runtime.lastError) {
          console.error('[YouSub] Main: Storage error:', chrome.runtime.lastError);
          return;
        }

        const enabled = res.yousub_translation_enabled;
        const targetLang = res.targetLang || 'vi';
        devLog('[YouSub] Main: Settings result:', { enabled, targetLang });

        if (enabled) {
          devLog('[YouSub] Main: Auto-translation is ENABLED. Checking cache...');
          // Phase 52.1: Guard cache check with timeout
          let cacheCheckDone = false;
          const cacheTimeout = setTimeout(() => {
            if (!cacheCheckDone) {
              cacheCheckDone = true;
              devWarn('[YouSub] Main: Cache check timed out after 10s. Skipping auto-start.');
            }
          }, 10000);

          try {
            chrome.runtime.sendMessage(
              {
                type: 'YOUSUB_CHECK_CACHE',
                videoId: videoId,
                targetLang: targetLang,
              },
              function (checkRes) {
                if (cacheCheckDone) return;
                cacheCheckDone = true;
                clearTimeout(cacheTimeout);

                if (chrome.runtime.lastError) {
                  console.error(
                    '[YouSub] Main: Cache check message error:',
                    chrome.runtime.lastError
                  );
                  return;
                }
                if (checkRes && checkRes.exists) {
                  devLog('[YouSub] Main: Cache hit. Auto-starting pipeline.');
                  startSubtitlePipeline(videoId, targetLang);
                } else {
                  devLog('[YouSub] Main: Cache miss or no cache found.');
                }
              }
            );
          } catch (e) {
            if (!cacheCheckDone) {
              cacheCheckDone = true;
              clearTimeout(cacheTimeout);
              console.error('[YouSub] Main: Cache check sendMessage threw:', e);
            }
          }
        } else {
          devLog('[YouSub] Main: Auto-translation is DISABLED.');
        }
      });
    });
  },
  function onLeave() {
    devLog('[YouSub] Main: ON_LEAVE fired.');
    SyncEngine.stop();
    Overlay.destroy();
  }
);

// Phase 53.1: Guard against duplicate listener registration on content script reload
let _messageListenerRegistered = false;
if (!_messageListenerRegistered) {
  _messageListenerRegistered = true;
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    const currentVideoId = PageDetector.getCurrentVideoId();

    if (
      request.type === 'YOUSUB_START_TRANSLATION' ||
      request.type === 'YOUSUB_TOGGLE_TRANSLATION'
    ) {
      devLog('[YouSub] Main: Translation toggle/start received:', request);

      if (request.enabled === false) {
        devLog('[YouSub] Main: Disabling translation.');
        SyncEngine.stop();
        Overlay.destroy();
      } else {
        const videoId = request.videoId || currentVideoId;
        if (videoId) {
          devLog('[YouSub] Main: Starting pipeline for', videoId);
          startSubtitlePipeline(videoId, request.targetLang || 'vi');
        } else {
          devWarn('[YouSub] Main: Cannot start translation, no video ID found.');
        }
      }
    }

    if (request.type === 'YOUSUB_TOGGLE_DUAL_MODE') {
      devLog('[YouSub] Main: Dual mode toggle received:', request.enabled);
      SyncEngine.setDualMode(request.enabled);
    }

    if (request.type === 'YOUSUB_CACHE_CLEARED' || request.type === 'YOUSUB_CLEAR_VIDEO_CACHE') {
      devLog('[YouSub] Main: Cache cleared message received.');
      SyncEngine.stop();
      Overlay.destroy();
    }

    if (request.type === 'YOUSUB_GET_STATE') {
      const state = {
        isTranslationActive: SyncEngine.isActive(),
        isDualMode: SyncEngine.isDualModeActive(),
      };
      devLog('[YouSub] Main: Reporting state to popup:', state);
      sendResponse(state);
      return false; // Sync response
    }

    // Return true if we want to send a response asynchronously (though not needed here)
    return false;
  });
} // Phase 53.1: end duplicate listener guard
