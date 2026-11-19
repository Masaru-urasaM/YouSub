import {
  Constants,
  TRANSLATION_ACTIVATION_KEY,
  SKIP_MUSIC_VIDEOS_KEY,
  devLog,
  devWarn,
} from '../shared/constants.js';
import { evaluateSmartAutoEnable } from '../shared/video-context.js';
import { PageDetector } from './page-detector.js';
import { VideoBinder } from './video-binder.js';
import { SubtitleExtractor } from './subtitle-extractor.js';
import { SubtitleParser } from './subtitle-parser.js';
import { SubtitleCoalescer } from './subtitle-coalescer.js';
import { RoughTranslateBridge } from './rough-translate-bridge.js';
import { Overlay } from './overlay.js';
import { SyncEngine } from './sync-engine.js';
import {
  createGeminiFallbackScheduler,
  createGeminiPortFetcher,
  DEFAULT_GEMINI_WINDOW_SEC,
} from './gemini-fallback-scheduler.js';
import { TrustedTypes } from '../shared/trusted-types.js';
import { escapeHtml as esc } from '../shared/utils.js';
import { PipelineTelemetry, PIPELINE_KEY_PREFIX } from '../shared/pipeline-telemetry.js';
import { SLEEP_TIMER_PRESETS } from '../shared/playback-resume-store.js';
import { PlaybackResume } from './playback-resume.js';
import { MobileDrawer } from './mobile-drawer.js';

// Init Security Policy
TrustedTypes.init();
// Expose for other modules that might not have direct import access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.TrustedTypes = TrustedTypes;
}

devLog('[YouSub] Main: Module loaded and executing...');

let activeGeminiFallback = null;
let geminiSessionGen = 0;
let pipelineSessionGen = 0;
let activeStreamPort = null;
let isPipelineActive = false;
let pipelineStorageListener = null;
let pipelineRunCounter = 0;
let metaProbeSeq = 0;
const manuallyStoppedVideos = new Set();
let activeVideoMeta = { videoId: null, videoTitle: '', channelName: '' };

function readDomVideoMetadata() {
  if (typeof document === 'undefined') return { title: '', channelName: '' };
  const rawTitle = String(document.title || '')
    .replace(/\s*-\s*YouTube$/, '')
    .trim();
  const chanEl =
    document.querySelector('#owner #channel-name a, #upload-info #channel-name a') ||
    document.querySelector(
      'ytm-slim-owner-renderer .slim-owner-channel-name, ytm-slim-owner-renderer a'
    );
  const channelName = String(chanEl?.textContent || '').trim();
  return { title: rawTitle, channelName };
}

function probePageVideoMetadata(videoId, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const domFallback = readDomVideoMetadata();
    const fallback = {
      title: domFallback.title,
      channelName: domFallback.channelName,
      category: '',
      captionLanguages: [],
      defaultCaptionLang: '',
    };
    if (!videoId || typeof window === 'undefined') {
      resolve(fallback);
      return;
    }

    const requestId = `yousub_meta_${++metaProbeSeq}`;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      window.removeEventListener('message', onMsg);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const finish = (data) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data || fallback);
    };

    function onMsg(event) {
      if (event.source !== window || !event.data) return;
      if (event.data.type !== 'YOUSUB_RESUME_PLAYER_DATA' || event.data.requestId !== requestId) {
        return;
      }
      finish({
        title: String(event.data.title || domFallback.title || '').replace(/\s*-\s*YouTube$/, ''),
        channelName: String(event.data.channelName || domFallback.channelName || ''),
        category: String(event.data.category || ''),
        captionLanguages: Array.isArray(event.data.captionLanguages)
          ? event.data.captionLanguages
          : [],
        defaultCaptionLang: String(event.data.defaultCaptionLang || ''),
      });
    }

    window.addEventListener('message', onMsg);
    timer = setTimeout(() => finish(fallback), timeoutMs);
    try {
      window.postMessage({ type: 'YOUSUB_RESUME_PROBE_PLAYER', videoId, requestId }, '*');
    } catch {
      finish(fallback);
    }
  });
}

async function trySmartAutoEnable(videoId, settingsRes) {
  const activationMode = settingsRes?.[TRANSLATION_ACTIVATION_KEY] || 'manual';
  if (activationMode !== 'smart_auto' && activationMode !== 'always_auto') return false;

  const keys = Array.isArray(settingsRes?.yousub_api_keys) ? settingsRes.yousub_api_keys : [];
  const hasApiKeys = keys.some((k) => k && k.apiKey && k.apiKey.trim() !== '' && !k.disabled);
  const targetLang = settingsRes?.targetLang || 'vi';
  const skipMusicVideos = settingsRes?.[SKIP_MUSIC_VIDEOS_KEY] !== false;

  const meta = await probePageVideoMetadata(videoId);
  if (PageDetector.getCurrentVideoId() !== videoId) return false;
  if (getTranslationRuntimeState().isTranslationActive) return false;

  activeVideoMeta = {
    videoId,
    videoTitle: meta.title || '',
    channelName: meta.channelName || '',
  };

  const decision = evaluateSmartAutoEnable({
    activationMode,
    skipMusicVideos,
    targetLang,
    defaultCaptionLang: meta.defaultCaptionLang,
    captionLanguages: meta.captionLanguages,
    category: meta.category,
    title: meta.title,
    videoId,
    manuallyStoppedVideos,
    hasApiKeys,
  });

  if (decision.shouldStart) {
    devLog('[YouSub] Main: Smart Auto-Enable triggered pipeline:', decision);
    startSubtitlePipeline(videoId, targetLang);
    return true;
  }
  devLog('[YouSub] Main: Smart Auto-Enable skipped:', decision.reason);
  return false;
}

function getTranslationRuntimeState() {
  return {
    isTranslationActive: isPipelineActive || SyncEngine.isActive() || Boolean(activeGeminiFallback),
    isDualMode: SyncEngine.isDualModeActive(),
  };
}

function syncMobileDrawerState() {
  const state = getTranslationRuntimeState();
  if (typeof MobileDrawer?.setTranslationActive === 'function') {
    MobileDrawer.setTranslationActive(state.isTranslationActive);
  }
  if (typeof MobileDrawer?.setDualMode === 'function') {
    MobileDrawer.setDualMode(state.isDualMode);
  }
}

function stopTranslationSession() {
  pipelineSessionGen++;
  isPipelineActive = false;
  stopActiveStreamPort();
  stopPipelineTelemetryListener();
  stopActiveGeminiFallback();
  SyncEngine.stop();
  Overlay.destroy();
  syncMobileDrawerState();
}

function stopActiveStreamPort() {
  if (!activeStreamPort) return;
  const p = activeStreamPort;
  activeStreamPort = null;
  try {
    p.disconnect();
  } catch {
    /* already disconnected */
  }
}

function createPipelineRunId(videoId) {
  pipelineRunCounter++;
  return `${videoId || 'novideo'}:${Date.now().toString(36)}:${pipelineRunCounter}`;
}

function stopPipelineTelemetryListener() {
  if (pipelineStorageListener && chrome.storage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.removeListener(pipelineStorageListener);
    } catch {
      /* ignore */
    }
  }
  pipelineStorageListener = null;
  if (typeof Overlay.clearStagePill === 'function') {
    Overlay.clearStagePill();
  }
}

function subscribePipelineTelemetry(videoId) {
  stopPipelineTelemetryListener();
  if (!videoId || !chrome.storage || !chrome.storage.onChanged) return;
  const targetKey = `${PIPELINE_KEY_PREFIX}${videoId}`;

  pipelineStorageListener = (changes, area) => {
    if ((area === 'local' || area === 'session') && changes[targetKey]?.newValue) {
      if (typeof Overlay.updateStagePill === 'function') {
        Overlay.updateStagePill(changes[targetKey].newValue);
      }
    }
  };
  try {
    chrome.storage.onChanged.addListener(pipelineStorageListener);
  } catch {
    pipelineStorageListener = null;
  }
}

function stopActiveGeminiFallback() {
  geminiSessionGen++;
  if (!activeGeminiFallback) return;
  try {
    activeGeminiFallback.scheduler.stop();
  } catch {
    /* already stopped */
  }
  try {
    activeGeminiFallback.fetcher.dispose();
  } catch {
    /* already disposed */
  }
  activeGeminiFallback = null;
}

function sendRuntimeMessage(payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        finish(null);
        return;
      }
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          finish(null);
          return;
        }
        finish(response || null);
      });
    } catch {
      finish(null);
    }
  });
}

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
  onUpdate,
  streamOptions = {}
) {
  return new Promise(function (resolve) {
    let hasResolved = false;
    let keepaliveInterval = null;
    let port = null;
    let attachedVideo = null;
    let lastSentSeekMs = -1;

    const STREAM_IDLE_TIMEOUT_MS = 150000;
    let watchdog = null;

    const handleVideoSeek = () => {
      if (hasResolved || !port || !attachedVideo) return;
      const ms = Math.max(0, Math.round((attachedVideo.currentTime || 0) * 1000));
      if (lastSentSeekMs >= 0 && Math.abs(ms - lastSentSeekMs) < 1000) return;
      lastSentSeekMs = ms;
      try {
        port.postMessage({ type: 'SEEK_PRIORITY', playheadMs: ms });
      } catch {
        /* port already disconnected */
      }
    };

    const detachSeekListeners = () => {
      if (!attachedVideo || typeof attachedVideo.removeEventListener !== 'function') return;
      attachedVideo.removeEventListener('seeking', handleVideoSeek);
      attachedVideo.removeEventListener('seeked', handleVideoSeek);
      attachedVideo = null;
    };

    const attachSeekListeners = (videoEl) => {
      if (!videoEl || typeof videoEl.addEventListener !== 'function' || attachedVideo === videoEl) {
        return;
      }
      detachSeekListeners();
      attachedVideo = videoEl;
      attachedVideo.addEventListener('seeking', handleVideoSeek);
      attachedVideo.addEventListener('seeked', handleVideoSeek);
    };

    function finish(result) {
      if (hasResolved) return;
      hasResolved = true;
      if (activeStreamPort === port) {
        activeStreamPort = null;
      }
      detachSeekListeners();
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

      stopActiveStreamPort();
      port = chrome.runtime.connect({ name: 'yousub-stream' });
      activeStreamPort = port;
      armWatchdog();

      if (streamOptions.videoElement) {
        attachSeekListeners(streamOptions.videoElement);
      }
      if (typeof streamOptions.registerVideoBinder === 'function') {
        streamOptions.registerVideoBinder(attachSeekListeners);
      }

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
      const segments = parsedEntries.map((e) => ({
        text: e.text,
        startMs: e.startMs,
      }));
      const initialPlayheadMs =
        streamOptions.videoElement && typeof streamOptions.videoElement.currentTime === 'number'
          ? Math.max(0, Math.round(streamOptions.videoElement.currentTime * 1000))
          : 0;
      lastSentSeekMs = initialPlayheadMs;

      const domMeta = readDomVideoMetadata();
      const videoTitle =
        activeVideoMeta.videoId === videoId && activeVideoMeta.videoTitle
          ? activeVideoMeta.videoTitle
          : domMeta.title;
      const channelName =
        activeVideoMeta.videoId === videoId && activeVideoMeta.channelName
          ? activeVideoMeta.channelName
          : domMeta.channelName;

      port.postMessage({
        type: 'YOUSUB_TRANSLATE_STREAM',
        videoId: videoId,
        segments: segments,
        sourceLang: sourceLang || 'auto',
        targetLang: targetLang,
        playheadMs: initialPlayheadMs,
        videoTitle,
        channelName,
        coalesceStats: streamOptions.coalesceStats || null,
        extractionSource: streamOptions.extractionSource || 'dom-transcript',
        mode: streamOptions.mode || 'transcript',
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

async function processEntries(entries, videoId, targetLang, sourceLang = 'auto', options = {}) {
  try {
    devLog('[YouSub] Main: processEntries started. Count:', entries.length);
    if (!entries || entries.length === 0) return;
    isPipelineActive = true;

    const { entries: coalescedEntries, stats: coalesceStats } = options.skipCoalesce
      ? {
          entries,
          stats: { rawCount: entries.length, coalescedCount: entries.length, mergedCues: 0 },
        }
      : SubtitleCoalescer.coalesce(entries, { bridgedDom: !!options.bridgedDom });
    const effectiveEntries = coalescedEntries.length > 0 ? coalescedEntries : entries;

    if (typeof Overlay.clearStatus === 'function') {
      Overlay.clearStatus('no-subtitles');
      Overlay.clearStatus('gemini-fallback');
    }

    SyncEngine.stop();
    Overlay.destroy();
    Overlay.setLoading(true);
    Overlay.show();

    if (videoId) {
      subscribePipelineTelemetry(videoId);
      // Await so this content-script write is persisted BEFORE the streaming port opens;
      // otherwise a fast service-worker COMPLETE (e.g. cache hit) can land first and get
      // overwritten by this COALESCE snapshot, leaving the stage pill stuck forever.
      try {
        await PipelineTelemetry.reset(videoId, {
          runId: options.runId || createPipelineRunId(videoId),
          mode: options.mode || 'transcript',
          stage: 'COALESCE',
          extraction: {
            source: options.extractionSource || 'dom-transcript',
            sourceLang: sourceLang || 'auto',
            targetLang: targetLang || 'vi',
            steps: [
              {
                id: 'extract',
                label: options.extractionSource || 'dom-transcript',
                status: 'done',
                detail: `${coalesceStats.rawCount} raw`,
              },
              {
                id: 'coalesce',
                label: 'Coalesce',
                status: 'done',
                detail: `${coalesceStats.rawCount}→${coalesceStats.coalescedCount}`,
              },
            ],
          },
          coalescer: coalesceStats,
          sink: { totalCues: effectiveEntries.length },
        });
      } catch {
        /* telemetry is best-effort; never block translation */
      }
    }

    const subtitles = effectiveEntries.map(function (e) {
      return {
        startMs: e.startMs,
        endMs: e.endMs,
        original: e.text,
        text: e.text,
      };
    });

    let boundVideo = null;
    let deferredVideoAttach = null;
    devLog('[YouSub] Main: Starting SyncEngine with original text...');
    VideoBinder.bind(function (video) {
      devLog('[YouSub] Main: Video element available to SyncEngine');
      boundVideo = video;
      if (deferredVideoAttach) deferredVideoAttach(video);
      SyncEngine.start(subtitles, video);
    });

    devLog('[YouSub] Main: Requesting translation from worker...');

    const runGen = options.pipelineGen !== undefined ? options.pipelineGen : pipelineSessionGen;
    let response;
    response = await requestTranslationStreaming(
      effectiveEntries,
      videoId,
      sourceLang,
      targetLang,
      (partialBatch, startIndex) => {
        if (runGen !== pipelineSessionGen) return;
        SyncEngine.updatePartial(partialBatch, startIndex);
      },
      {
        videoElement: boundVideo,
        registerVideoBinder: (attachFn) => {
          deferredVideoAttach = attachFn;
        },
        coalesceStats,
        extractionSource: options.extractionSource || 'dom-transcript',
        mode: options.mode || 'transcript',
      }
    );

    if (runGen !== pipelineSessionGen) return;

    if (response.success === false) {
      isPipelineActive = false;
      devWarn('[YouSub] Main: Halting pipeline due to error');

      // Phase 64 (b): Preserve already-rendered partial translations on failure.
      // If any line was translated and streamed in via updatePartial, keep those
      // subtitles on screen instead of destroying the overlay; show a soft notice.
      const partialCount = SyncEngine.getTranslatedCount();
      if (partialCount > 0) {
        devWarn('[YouSub] Main: Preserving', partialCount, 'partial translations despite error');
        Overlay.setLoading(false);
        syncMobileDrawerState();
        const reason = response.failureReason || 'Error';
        const notice = `<strong>Translation incomplete:</strong> ${partialCount}/${effectiveEntries.length} lines translated. (${reason})`;
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
      syncMobileDrawerState();
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

      if (options.saveGeneratedCache && videoId) {
        sendRuntimeMessage({
          type: 'YOUSUB_SAVE_GENERATED_CACHE',
          videoId,
          targetLang,
          payload: {
            entries: response.translated,
            completedBatches: ['all'],
          },
        });
      }
    }
    Overlay.setLoading(false);
    isPipelineActive = false;
    syncMobileDrawerState();
  } catch (err) {
    isPipelineActive = false;
    if (typeof Overlay.clearStagePill === 'function') {
      Overlay.clearStagePill();
    }
    console.error('[YouSub] Main: processEntries CRITICAL ERROR:', err);
    Overlay.setLoading(false);
    syncMobileDrawerState();
  }
}

async function handleImportedSubtitleFile(text, fileName, videoId, targetLang, removeToast) {
  const entries = SubtitleParser.parseSubtitleFile(text, fileName);
  if (!entries || entries.length === 0) {
    Overlay.showStatus('No valid subtitle entries found in file', 'warning', 4000);
    return;
  }

  stopActiveGeminiFallback();
  if (typeof removeToast === 'function') removeToast();
  if (typeof Overlay.clearStatus === 'function') {
    Overlay.clearStatus('gemini-fallback');
    Overlay.clearStatus('no-subtitles');
  }
  Overlay.showStatus(`Loaded ${entries.length} lines from ${esc(fileName)}`, 'info', 2500);
  await processEntries(entries, videoId, targetLang, 'auto', {
    saveGeneratedCache: true,
    bridgedDom: false,
    extractionSource: 'srt-import',
    mode: 'srt-import',
  });
}

function showNoSubtitlesPrompt({
  videoId,
  targetLang,
  detailMessage = '',
  showSettingsLink = false,
  retryAction = null,
  failureReason = 'NO_SUBTITLES',
}) {
  isPipelineActive = false;
  syncMobileDrawerState();
  if (videoId) {
    PipelineTelemetry.update(videoId, {
      stage: 'ERROR',
      error: {
        failureReason,
        message: detailMessage || 'Could not find subtitles',
      },
    });
  }

  let msg = 'Could not find subtitles';
  if (detailMessage) {
    msg += `<br><small>${esc(detailMessage)}</small>`;
  }
  if (showSettingsLink) {
    msg +=
      '<br><small><a data-action="open-settings">Configure a Gemini key in Settings</a> for automatic AI fallback</small>';
  }

  const actions = retryAction ? [retryAction] : undefined;
  Overlay.showStatus(TrustedTypes.toSafeHTML(msg), 'warning', 0, {
    id: 'no-subtitles',
    dismissible: true,
    importLabel: 'Import .srt / .vtt',
    onImportSubtitleFile: (text, fileName, removeToast) => {
      handleImportedSubtitleFile(text, fileName, videoId, targetLang, removeToast);
    },
    ...(actions ? { actions } : {}),
  });
}

function startGeminiVideoFallback(videoId, targetLang, cachedPartial = null, runId = null) {
  stopActiveGeminiFallback();
  isPipelineActive = true;
  subscribePipelineTelemetry(videoId);
  if (videoId) {
    PipelineTelemetry.reset(videoId, {
      runId: runId || createPipelineRunId(videoId),
      mode: 'gemini-video',
      stage: 'EXTRACT',
      extraction: {
        source: 'gemini-url',
        sourceLang: 'auto',
        targetLang: targetLang || 'vi',
        steps: [
          { id: 'dom', label: 'DOM Transcript', status: 'skipped', detail: 'none' },
          { id: 'gemini', label: 'Gemini Video URL', status: 'active', detail: '240s windows' },
        ],
      },
    });
  }
  const myGen = geminiSessionGen;

  VideoBinder.bind((videoElement) => {
    if (myGen !== geminiSessionGen || !videoElement) return;

    const seedEntries = Array.isArray(cachedPartial?.entries) ? cachedPartial.entries : [];
    SyncEngine.start(seedEntries, videoElement, { allowEmpty: true });

    const fetcher = createGeminiPortFetcher();
    const scheduler = createGeminiFallbackScheduler({
      videoId,
      videoElement,
      targetLang,
      windowSec: cachedPartial?.windowSec || DEFAULT_GEMINI_WINDOW_SEC,
      initialCompletedBatches: Array.isArray(cachedPartial?.completedBatches)
        ? cachedPartial.completedBatches
        : [],
      fetchBatch: fetcher.fetchBatch,
      onEntries: (entries) => {
        SyncEngine.mergeBatchEntries(entries);
      },
      onBatchStart: ({ batchIndex, isPrefetch, totalBatches }) => {
        if (isPrefetch) return;
        Overlay.setLoading(true);
        const totalLabel = totalBatches ? `/${totalBatches}` : '';
        const statusMsg = `No captions — transcribing segment ${batchIndex + 1}${totalLabel} via Gemini AI...`;
        Overlay.showStatus(TrustedTypes.toSafeHTML(statusMsg), 'info', 0, {
          id: 'gemini-fallback',
          dismissible: true,
          importLabel: 'Import .srt / .vtt',
          onImportSubtitleFile: (text, fileName, removeToast) => {
            handleImportedSubtitleFile(text, fileName, videoId, targetLang, removeToast);
          },
        });
      },
      onBatchComplete: ({ isPrefetch, entryCount }) => {
        if (isPrefetch) return;
        Overlay.setLoading(false);
        if (typeof Overlay.clearStatus === 'function') {
          Overlay.clearStatus('gemini-fallback');
        }
        if (entryCount === 0 && SyncEngine.getTranslatedCount() === 0) {
          Overlay.showStatus('No spoken dialogue detected in this segment', 'info', 3000);
        }
      },
      onFatalError: ({ failureReason, error }) => {
        Overlay.setLoading(false);
        if (typeof Overlay.clearStatus === 'function') {
          Overlay.clearStatus('gemini-fallback');
        }
        stopActiveGeminiFallback();
        if (SyncEngine.getTranslatedCount() === 0) {
          SyncEngine.stop();
        }

        let detailMessage = error || failureReason;
        let showSettingsLink = false;
        if (failureReason === 'VIDEO_UNAVAILABLE_OR_PRIVATE') {
          detailMessage = 'Gemini cannot access private, unlisted, or restricted videos.';
        } else if (failureReason === 'NO_GEMINI_KEY' || failureReason === 'INVALID_API_KEY') {
          detailMessage = 'Invalid or missing Google Gemini API key.';
          showSettingsLink = true;
        }
        showNoSubtitlesPrompt({
          videoId,
          targetLang,
          detailMessage,
          showSettingsLink,
          failureReason: failureReason || 'GEMINI_ERROR',
        });
      },
      onBatchError: ({ failureReason, batchIndex, isPrefetch }) => {
        if (isPrefetch) return;
        Overlay.setLoading(false);
        if (typeof Overlay.clearStatus === 'function') {
          Overlay.clearStatus('gemini-fallback');
        }
        const detailMessage =
          failureReason === 'GEMINI_RATE_LIMITED'
            ? `Gemini rate limit reached (429) on segment ${batchIndex + 1}.`
            : `Gemini request failed on segment ${batchIndex + 1}.`;
        showNoSubtitlesPrompt({
          videoId,
          targetLang,
          detailMessage,
          failureReason: failureReason || 'GEMINI_ERROR',
          retryAction: {
            label: 'Retry AI',
            onClick: (closeToast) => {
              if (closeToast) closeToast();
              isPipelineActive = true;
              scheduler.retry();
            },
          },
        });
      },
    });

    activeGeminiFallback = { scheduler, fetcher };
    scheduler.start();
  });
}

async function startSubtitlePipeline(videoId, targetLang) {
  const myPipelineGen = ++pipelineSessionGen;
  const runId = createPipelineRunId(videoId);
  try {
    devLog('[YouSub] Main: startSubtitlePipeline triggered for:', videoId);
    isPipelineActive = true;
    syncMobileDrawerState();
    stopActiveGeminiFallback();
    Overlay.setLoading(true);
    Overlay.show();
    if (videoId) {
      subscribePipelineTelemetry(videoId);
      PipelineTelemetry.reset(videoId, {
        runId,
        mode: 'transcript',
        stage: 'EXTRACT',
        extraction: {
          source: 'probing',
          sourceLang: 'auto',
          targetLang: targetLang || 'vi',
          steps: [
            {
              id: 'extract',
              label: 'Scan Captions',
              status: 'active',
              detail: 'DOM & Innertube',
            },
          ],
        },
      });
    }
    if (typeof Overlay.showStatus === 'function') {
      Overlay.showStatus('Checking video subtitles...', 'info', 0, { id: 'extracting-status' });
    }

    SubtitleExtractor.extract(async function (tracks, parsedEntries, error, sourceLang) {
      if (myPipelineGen !== pipelineSessionGen) return;
      if (typeof Overlay.clearStatus === 'function') {
        Overlay.clearStatus('extracting-status');
      }
      try {
        devLog(
          '[YouSub] Main: Extractor results received. Entries:',
          parsedEntries ? parsedEntries.length : 0,
          'Tracks:',
          tracks ? tracks.length : 0,
          'Error:',
          error,
          'SourceLang:',
          sourceLang
        );

        if (parsedEntries && parsedEntries.length > 0) {
          await processEntries(parsedEntries, videoId, targetLang, sourceLang, {
            bridgedDom: true,
            extractionSource: 'dom-transcript',
            runId,
            pipelineGen: myPipelineGen,
          });
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
                // The fallback path fetched a specific track, so its languageCode is
                // the authoritative source language (main.js:114 coerces '' → 'auto').
                await processEntries(entries, videoId, targetLang, selectedTrack.languageCode, {
                  bridgedDom: false,
                  extractionSource: 'timedtext',
                  runId,
                  pipelineGen: myPipelineGen,
                });
                return;
              }
            } catch (fetchErr) {
              console.error('[YouSub] Main: Fallback fetch FAILED:', fetchErr);
            }
          }
        }

        if (!parsedEntries) {
          const genCacheRes = await sendRuntimeMessage({
            type: 'YOUSUB_GET_GENERATED_CACHE',
            videoId,
            targetLang,
          });
          const cachedGen = genCacheRes && genCacheRes.cached;

          if (
            cachedGen &&
            Array.isArray(cachedGen.entries) &&
            cachedGen.entries.length > 0 &&
            Array.isArray(cachedGen.completedBatches) &&
            cachedGen.completedBatches.includes('all')
          ) {
            isPipelineActive = false;
            if (videoId) {
              PipelineTelemetry.update(videoId, {
                mode: 'cache',
                stage: 'COMPLETE',
                sink: {
                  syncedCues: cachedGen.entries.length,
                  totalCues: cachedGen.entries.length,
                  cached: true,
                  cacheType: 'generated',
                },
              });
            }
            VideoBinder.bind((videoElement) => {
              SyncEngine.start(cachedGen.entries, videoElement);
              Overlay.showStatus('Loaded from cache', 'info', 2000);
              Overlay.setLoading(false);
            });
            return;
          }

          if (error === 'LIVE_STREAM_DETECTED') {
            Overlay.setLoading(false);
            showNoSubtitlesPrompt({
              videoId,
              targetLang,
              detailMessage: 'Live streams do not support transcript fallback.',
              failureReason: 'LIVE_STREAM_DETECTED',
            });
            return;
          }

          const geminiCheck = await sendRuntimeMessage({
            type: 'YOUSUB_CHECK_GEMINI_AVAILABLE',
          });
          if (geminiCheck && geminiCheck.available) {
            startGeminiVideoFallback(videoId, targetLang, cachedGen || null, runId);
            return;
          }

          if (cachedGen && Array.isArray(cachedGen.entries) && cachedGen.entries.length > 0) {
            isPipelineActive = false;
            VideoBinder.bind((videoElement) => {
              SyncEngine.start(cachedGen.entries, videoElement);
              Overlay.showStatus('Loaded partial subtitles from cache', 'info', 2500);
              Overlay.setLoading(false);
            });
            return;
          }

          Overlay.setLoading(false);
          const disabledInSettings = geminiCheck && geminiCheck.enabled === false;
          const detailMessage = disabledInSettings
            ? 'Gemini video fallback is disabled in Settings.'
            : '';
          showNoSubtitlesPrompt({
            videoId,
            targetLang,
            detailMessage,
            showSettingsLink: !disabledInSettings,
          });
        }
      } catch (innerErr) {
        isPipelineActive = false;
        if (typeof Overlay.clearStatus === 'function') {
          Overlay.clearStatus('extracting-status');
        }
        console.error('[YouSub] Main: startSubtitlePipeline callback error:', innerErr);
        Overlay.setLoading(false);
        syncMobileDrawerState();
      }
    });
  } catch (outerErr) {
    isPipelineActive = false;
    if (typeof Overlay.clearStatus === 'function') {
      Overlay.clearStatus('extracting-status');
    }
    console.error('[YouSub] Main: startSubtitlePipeline critical error:', outerErr);
    Overlay.setLoading(false);
    syncMobileDrawerState();
  }
}

// Init Mobile In-Page Drawer + PageDetector
MobileDrawer.init({
  getTranslationState: getTranslationRuntimeState,
  onToggleTranslation: (enabled, lang, videoId) => {
    const targetId = videoId || PageDetector.getCurrentVideoId();
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      Promise.resolve(
        chrome.storage.local.set({ yousub_translation_enabled: Boolean(enabled) })
      ).catch(() => {});
    }
    if (!enabled) {
      if (targetId) manuallyStoppedVideos.add(targetId);
      stopTranslationSession();
    } else if (targetId) {
      manuallyStoppedVideos.delete(targetId);
      startSubtitlePipeline(targetId, lang || 'vi');
    }
  },
  onToggleDualMode: (enabled) => {
    SyncEngine.setDualMode(Boolean(enabled));
    syncMobileDrawerState();
  },
  onChangeTargetLang: (newLang) => {
    if (getTranslationRuntimeState().isTranslationActive) {
      const targetId = PageDetector.getCurrentVideoId();
      if (targetId) startSubtitlePipeline(targetId, newLang || 'vi');
    }
  },
  onOpenSettings: () => {
    sendRuntimeMessage({ type: 'YOUSUB_OPEN_SETTINGS' });
  },
});

if (typeof PlaybackResume?.onSleepTimerChange === 'function') {
  PlaybackResume.onSleepTimerChange((sleepState) => {
    if (typeof MobileDrawer?.setBadgeText === 'function') {
      MobileDrawer.setBadgeText(sleepState?.badgeText || '');
    }
    if (typeof MobileDrawer?.refresh === 'function') {
      MobileDrawer.refresh();
    }
  });
}

if (typeof MobileDrawer?.registerAddon === 'function') {
  MobileDrawer.registerAddon('sleep-timer', (host, ctx) => {
    if (!ctx?.videoId || window.location.pathname.startsWith('/shorts/')) return;
    const sleep =
      typeof PlaybackResume?.getSleepTimerState === 'function'
        ? PlaybackResume.getSleepTimerState()
        : { active: false };
    const wrap = document.createElement('div');
    wrap.id = 'ys-drawer-sleep-addon';
    wrap.className = 'yousub-drawer-chips';

    const label = document.createElement('span');
    label.textContent = sleep.active ? `Sleep: ${sleep.badgeText || 'ON'}` : 'Sleep Timer:';
    wrap.appendChild(label);

    for (const mins of SLEEP_TIMER_PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `yousub-drawer-btn${
        sleep.active && Math.round((sleep.totalSec || 0) / 60) === mins ? ' yousub-btn-on' : ''
      }`;
      btn.textContent = `${mins}m`;
      btn.addEventListener('click', () => {
        PlaybackResume.setSleepTimer(mins);
        ctx.refresh();
      });
      wrap.appendChild(btn);
    }

    if (sleep.active) {
      const offBtn = document.createElement('button');
      offBtn.type = 'button';
      offBtn.className = 'yousub-drawer-btn';
      offBtn.textContent = 'Off';
      offBtn.addEventListener('click', () => {
        PlaybackResume.cancelSleepTimer();
        ctx.refresh();
      });
      wrap.appendChild(offBtn);
    }

    host.appendChild(wrap);
  });

  MobileDrawer.registerAddon('ab-loop', (host, ctx) => {
    if (!ctx?.videoId || window.location.pathname.startsWith('/shorts/')) return;
    const loop =
      typeof PlaybackResume?.getLoopState === 'function'
        ? PlaybackResume.getLoopState()
        : { active: false, pointA: null, pointB: null };
    const wrap = document.createElement('div');
    wrap.id = 'ys-drawer-ab-addon';
    wrap.className = 'yousub-drawer-chips';

    const label = document.createElement('span');
    if (loop.active) {
      label.textContent = `A-B: ${Math.floor(loop.pointA)}s-${Math.floor(loop.pointB)}s`;
    } else if (loop.pointA !== null) {
      label.textContent = `A: ${Math.floor(loop.pointA)}s`;
    } else {
      label.textContent = 'A-B Loop:';
    }
    wrap.appendChild(label);

    const setABtn = document.createElement('button');
    setABtn.type = 'button';
    setABtn.className = 'yousub-drawer-btn';
    setABtn.textContent = 'Set A';
    setABtn.addEventListener('click', () => {
      PlaybackResume.setLoopPointA();
      ctx.refresh();
    });
    wrap.appendChild(setABtn);

    const setBBtn = document.createElement('button');
    setBBtn.type = 'button';
    setBBtn.className = `yousub-drawer-btn${loop.active ? ' yousub-btn-on' : ''}`;
    setBBtn.textContent = 'Set B';
    setBBtn.addEventListener('click', () => {
      PlaybackResume.setLoopPointB();
      ctx.refresh();
    });
    wrap.appendChild(setBBtn);

    if (loop.active || loop.pointA !== null) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'yousub-drawer-btn';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => {
        PlaybackResume.clearLoop();
        ctx.refresh();
      });
      wrap.appendChild(clearBtn);
    }

    host.appendChild(wrap);
  });
}

devLog('[YouSub] Main: Registering PageDetector callbacks...');
PageDetector.init(
  function onEnter(videoId) {
    devLog('[YouSub] Main: ON_ENTER fired for video:', videoId);

    stopActiveGeminiFallback();
    Overlay.destroy();
    PlaybackResume.onEnter(videoId);
    MobileDrawer.onEnter(videoId);

    VideoBinder.bind(function (_videoEl) {
      devLog('[YouSub] Main: Video element bound properly. Checking storage...');

      chrome.storage.local.get(
        [
          'yousub_translation_enabled',
          'targetLang',
          'yousub_autostart_video',
          TRANSLATION_ACTIVATION_KEY,
          SKIP_MUSIC_VIDEOS_KEY,
          'yousub_api_keys',
        ],
        function (res) {
          if (chrome.runtime.lastError) {
            console.error('[YouSub] Main: Storage error:', chrome.runtime.lastError);
            return;
          }

          const enabled = res.yousub_translation_enabled;
          const targetLang = res.targetLang || 'vi';
          const autostartVideo = res.yousub_autostart_video;
          devLog('[YouSub] Main: Settings result:', { enabled, targetLang, autostartVideo });

          if (autostartVideo && autostartVideo === videoId) {
            devLog('[YouSub] Main: Consuming autostart flag and starting pipeline:', videoId);
            chrome.storage.local.remove(['yousub_autostart_video']);
            startSubtitlePipeline(videoId, targetLang);
            return;
          }

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
                    trySmartAutoEnable(videoId, res).catch(() => {});
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
            trySmartAutoEnable(videoId, res).catch(() => {});
          }
        }
      );
    });
  },
  function onLeave() {
    devLog('[YouSub] Main: ON_LEAVE fired.');
    activeVideoMeta = { videoId: null, videoTitle: '', channelName: '' };
    stopTranslationSession();
    PlaybackResume.onLeave();
    MobileDrawer.onLeave();
  }
);

// Phase 53.1: Guard against duplicate listener registration on content script reload
let _messageListenerRegistered = false;
if (!_messageListenerRegistered) {
  _messageListenerRegistered = true;
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    const currentVideoId = PageDetector.getCurrentVideoId();

    // Rough back-translation delegated from the service worker (MergeFixer
    // verification). Runs the on-device Translator in the page main world and
    // replies with { translations } (Array<string|null>, length === texts.length).
    if (request.type === 'YOUSUB_ROUGH_TRANSLATE') {
      RoughTranslateBridge.translateBatch(request.texts, request.src, request.tgt)
        .then((translations) => sendResponse({ translations }))
        .catch(() => sendResponse({ translations: (request.texts || []).map(() => null) }));
      return true; // async sendResponse — keep the message channel open
    }

    if (
      request.type === 'YOUSUB_START_TRANSLATION' ||
      request.type === 'YOUSUB_TOGGLE_TRANSLATION'
    ) {
      devLog('[YouSub] Main: Translation toggle/start received:', request);

      if (request.enabled === false) {
        devLog('[YouSub] Main: Disabling translation.');
        if (currentVideoId) manuallyStoppedVideos.add(currentVideoId);
        stopTranslationSession();
      } else {
        const videoId = request.videoId || currentVideoId;
        if (videoId) {
          manuallyStoppedVideos.delete(videoId);
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
      syncMobileDrawerState();
    }

    if (request.type === 'YOUSUB_CACHE_CLEARED' || request.type === 'YOUSUB_CLEAR_VIDEO_CACHE') {
      devLog('[YouSub] Main: Cache cleared message received.');
      stopTranslationSession();
    }

    if (request.type === 'YOUSUB_GET_STATE') {
      const state = getTranslationRuntimeState();
      devLog('[YouSub] Main: Reporting state to popup:', state);
      sendResponse(state);
      return false; // Sync response
    }

    if (request.type === 'YOUSUB_RESUME_GET_STATE') {
      PlaybackResume.getCurrentState()
        .then((res) => sendResponse(res))
        .catch(() => sendResponse(null));
      return true;
    }

    if (request.type === 'YOUSUB_RESUME_SEEK_TO') {
      PlaybackResume.seekTo(request.timeSec, {
        allowResetToZero: !!request.allowResetToZero,
      })
        .then((ok) => sendResponse({ ok }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (request.type === 'YOUSUB_RESUME_ADD_BOOKMARK') {
      PlaybackResume.addCurrentBookmark(request.label)
        .then((record) => sendResponse({ ok: !!record, record }))
        .catch(() => sendResponse({ ok: false, record: null }));
      return true;
    }

    if (request.type === 'YOUSUB_RESUME_SET_SLEEP_TIMER') {
      const sleepTimer =
        typeof PlaybackResume?.setSleepTimer === 'function'
          ? PlaybackResume.setSleepTimer(request.minutes)
          : { active: false };
      sendResponse({ ok: true, sleepTimer });
      return false;
    }

    if (request.type === 'YOUSUB_RESUME_SET_AB_LOOP') {
      let abLoop = { active: false, pointA: null, pointB: null };
      if (request.action === 'setA' && typeof PlaybackResume?.setLoopPointA === 'function') {
        abLoop = PlaybackResume.setLoopPointA(request.timeSec);
      } else if (request.action === 'setB' && typeof PlaybackResume?.setLoopPointB === 'function') {
        abLoop = PlaybackResume.setLoopPointB(request.timeSec);
      } else if (request.action === 'clear' && typeof PlaybackResume?.clearLoop === 'function') {
        abLoop = PlaybackResume.clearLoop();
      }
      sendResponse({ ok: true, abLoop });
      return false;
    }

    // Return true if we want to send a response asynchronously (though not needed here)
    return false;
  });
} // Phase 53.1: end duplicate listener guard
