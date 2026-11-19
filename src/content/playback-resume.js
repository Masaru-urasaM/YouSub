import { devLog } from '../shared/constants.js';
import { Logger } from '../shared/logger.js';
import { escapeHtml as esc } from '../shared/utils.js';
import {
  PlaybackResumeStore,
  resolveResumeTarget,
  formatTimestamp,
  formatCountdown,
} from '../shared/playback-resume-store.js';
import { Overlay } from './overlay.js';

const SAVE_THROTTLE_MS = 3000;
const WATCHTIME_PUSH_INTERVAL_MS = 30000;
const USER_INTERACTION_WINDOW_MS = 5000;
const GUARD_DURATION_MS = 15000;
const PROBE_TIMEOUT_MS = 4000;
const VIDEO_WAIT_TIMEOUT_MS = 10000;
const SLEEP_FADE_DURATION_MS = 5000;
const SLEEP_FADE_STEPS = 10;

const VIDEO_SELECTORS = [
  '#player-container-id video',
  'ytm-player video',
  'video.html5-main-video',
  '#movie_player video',
  'video',
];

let sessionGen = 0;
let probeCounter = 0;

let activeVideoId = null;
let activeVideoEl = null;
let activeTitle = '';
let activeChannelName = '';
let activeDurationSec = 0;
let currentSettings = null;

let lastLocalSaveAt = 0;
let lastWatchtimePushAt = 0;
let lastInteractionEventAt = 0;
let isAutoSeeking = false;
let isApplyingSavedSpeed = false;

let loopPointA = null;
let loopPointB = null;
let loopEnabled = false;

let activeObserver = null;
let activeVideoTimeout = null;
let autoSeekTimer = null;
let earlyResetCleanupTimer = null;
let cleanupProbe = null;
let cleanupVideoListeners = null;
let cleanupGlobalListeners = null;
let logBridgeRegistered = false;

let sleepEndAt = 0;
let sleepTotalSec = 0;
let sleepTickTimer = null;
let sleepFadeTimer = null;
let isSleepFading = false;
let preFadeVolume = null;
let isApplyingSleepFadeVolume = false;
const sleepListeners = new Set();

function getSleepRemainingSec(now = Date.now()) {
  if (!sleepEndAt || sleepEndAt <= now) return 0;
  return Math.max(0, Math.ceil((sleepEndAt - now) / 1000));
}

function buildSleepState(now = Date.now()) {
  const active = Boolean(sleepEndAt > 0 || isSleepFading);
  const remainingSec = isSleepFading ? 0 : getSleepRemainingSec(now);
  const badgeText = !active
    ? ''
    : isSleepFading
      ? '00:00'
      : remainingSec >= 3600
        ? `${Math.ceil(remainingSec / 60)}m`
        : formatCountdown(remainingSec);
  return {
    active,
    remainingSec,
    totalSec: sleepTotalSec,
    endAt: sleepEndAt,
    isFading: isSleepFading,
    badgeText,
  };
}

function notifySleepListeners() {
  const st = buildSleepState();
  for (const fn of sleepListeners) {
    try {
      fn(st);
    } catch {
      /* isolate subscriber errors */
    }
  }
  return st;
}

function setVolumeSafely(videoEl, vol) {
  if (!videoEl || typeof vol !== 'number' || !Number.isFinite(vol)) return;
  const clamped = Math.max(0, Math.min(1, vol));
  isApplyingSleepFadeVolume = true;
  try {
    videoEl.volume = clamped;
  } catch {
    /* some environments expose read-only volume */
  } finally {
    isApplyingSleepFadeVolume = false;
  }
}

function restorePreFadeVolume() {
  if (preFadeVolume !== null && activeVideoEl) {
    setVolumeSafely(activeVideoEl, preFadeVolume);
  }
  preFadeVolume = null;
}

function clearSleepTimers() {
  if (sleepTickTimer) {
    clearInterval(sleepTickTimer);
    sleepTickTimer = null;
  }
  if (sleepFadeTimer) {
    clearInterval(sleepFadeTimer);
    sleepFadeTimer = null;
  }
}

function cancelSleepTimerInternal({ silent = false } = {}) {
  clearSleepTimers();
  const wasFading = isSleepFading;
  isSleepFading = false;
  sleepEndAt = 0;
  sleepTotalSec = 0;
  restorePreFadeVolume();
  if (wasFading && activeVideoEl) {
    Logger.info('PlaybackResume', '[SLEEP_TIMER] Fade cancelled and volume restored');
  }
  return silent ? buildSleepState() : notifySleepListeners();
}

function buildAbLoopState() {
  return {
    active: Boolean(loopEnabled && loopPointA !== null && loopPointB !== null),
    pointA: loopPointA,
    pointB: loopPointB,
  };
}

function clearAbLoopState() {
  loopPointA = null;
  loopPointB = null;
  loopEnabled = false;
  return buildAbLoopState();
}

function persistCurrentProgressSnapshot({
  myGen = sessionGen,
  forceSyncFlush = false,
  pushWatchtime = false,
  state = 'paused',
} = {}) {
  if (myGen !== sessionGen || !activeVideoId || !activeVideoEl) return;

  const currentSec = Number(activeVideoEl.currentTime);
  if (!Number.isFinite(currentSec) || currentSec < 0) return;

  const measuredDur = Number(activeVideoEl.duration);
  if (Number.isFinite(measuredDur) && measuredDur > 0) {
    activeDurationSec = Math.max(activeDurationSec, measuredDur);
  }

  const minDur = currentSettings?.minDurationSec ?? 60;
  if (activeDurationSec > 0 && activeDurationSec < minDur) return;

  const now = Date.now();
  const syncEnabled = currentSettings?.syncEnabled !== false;

  lastLocalSaveAt = now;
  PlaybackResumeStore.updateProgress(activeVideoId, {
    currentTimeSec: currentSec,
    durationSec: activeDurationSec,
    title: activeTitle,
    channelName: activeChannelName,
    isUserInteraction: hasRecentUserInteraction(),
    forceSyncFlush,
    syncEnabled,
  }).catch(() => {});

  if (pushWatchtime && syncEnabled && currentSec >= 5) {
    lastWatchtimePushAt = now;
    postWatchtimePush({
      videoId: activeVideoId,
      currentTimeSec: currentSec,
      durationSec: activeDurationSec,
      state,
    });
  }
}

async function completeSleepTimer(myGen) {
  clearSleepTimers();
  isSleepFading = false;
  sleepEndAt = 0;
  sleepTotalSec = 0;

  if (myGen !== sessionGen || !activeVideoEl || !activeVideoId) {
    restorePreFadeVolume();
    notifySleepListeners();
    return;
  }

  const pauseTimeSec = Math.max(0, Math.floor(Number(activeVideoEl.currentTime) || 0));
  try {
    if (typeof activeVideoEl.pause === 'function') {
      activeVideoEl.pause();
    }
  } catch {
    /* ignore */
  }
  restorePreFadeVolume();
  lastInteractionEventAt = Date.now();
  persistCurrentProgressSnapshot({
    myGen,
    forceSyncFlush: true,
    pushWatchtime: true,
    state: 'paused',
  });

  try {
    await PlaybackResumeStore.addBookmark(activeVideoId, {
      timeSec: pauseTimeSec,
      label: 'Sleep stop',
      title: activeTitle,
      durationSec: Math.max(activeDurationSec, Number(activeVideoEl?.duration) || 0),
    });
  } catch {
    /* ignore */
  }

  Logger.info(
    'PlaybackResume',
    '[SLEEP_TIMER] Completed fade, paused & saved Sleep stop bookmark',
    {
      videoId: activeVideoId,
      pauseTimeSec,
    }
  );

  Overlay.showStatus(
    `🌙 Sleep timer paused at ${esc(formatTimestamp(pauseTimeSec))} ("Sleep stop" saved)`,
    'info',
    7000,
    { id: 'sleep-timer-stop', dismissible: true }
  );
  notifySleepListeners();
}

function beginSleepFadeOut(myGen) {
  clearSleepTimers();
  if (myGen !== sessionGen || !activeVideoEl || !activeVideoId) {
    cancelSleepTimerInternal();
    return;
  }

  isSleepFading = true;
  const rawVol = Number(activeVideoEl.volume);
  preFadeVolume = Number.isFinite(rawVol) ? Math.max(0, Math.min(1, rawVol)) : 1;
  notifySleepListeners();

  let step = 0;
  const stepMs = Math.round(SLEEP_FADE_DURATION_MS / SLEEP_FADE_STEPS);
  sleepFadeTimer = setInterval(() => {
    if (myGen !== sessionGen || !activeVideoEl) {
      cancelSleepTimerInternal();
      return;
    }
    step += 1;
    const ratio = Math.max(0, 1 - step / SLEEP_FADE_STEPS);
    setVolumeSafely(activeVideoEl, preFadeVolume * ratio);
    if (step >= SLEEP_FADE_STEPS) {
      completeSleepTimer(myGen).catch(() => {});
    }
  }, stepMs);
}

function isShortsPath() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/shorts/');
}

function isVideoVisible(el) {
  if (!el) return false;
  return !!(
    el.offsetWidth ||
    el.offsetHeight ||
    (typeof el.getClientRects === 'function' && el.getClientRects().length)
  );
}

function findActiveVideoElement() {
  for (let i = 0; i < VIDEO_SELECTORS.length; i++) {
    const el = document.querySelector(VIDEO_SELECTORS[i]);
    if (el && el.tagName === 'VIDEO' && isVideoVisible(el)) {
      return el;
    }
  }
  const allVideos = document.querySelectorAll('video');
  for (let j = 0; j < allVideos.length; j++) {
    if (isVideoVisible(allVideos[j])) return allVideos[j];
  }
  return null;
}

function waitForActiveVideo(myGen) {
  return new Promise((resolve) => {
    const existing = findActiveVideoElement();
    if (existing) {
      resolve(existing);
      return;
    }

    let settled = false;
    const finish = (video) => {
      if (settled) return;
      settled = true;
      if (activeObserver) {
        activeObserver.disconnect();
        activeObserver = null;
      }
      if (activeVideoTimeout) {
        clearTimeout(activeVideoTimeout);
        activeVideoTimeout = null;
      }
      resolve(video || null);
    };

    if (typeof MutationObserver !== 'undefined') {
      activeObserver = new MutationObserver(() => {
        if (myGen !== sessionGen) {
          finish(null);
          return;
        }
        const v = findActiveVideoElement();
        if (v) finish(v);
      });
      const target = document.body || document.documentElement;
      if (target) {
        activeObserver.observe(target, { childList: true, subtree: true });
      }
    }

    activeVideoTimeout = setTimeout(() => finish(null), VIDEO_WAIT_TIMEOUT_MS);
  });
}

function postGuardConfig({
  videoId,
  protectedMinTimeSec,
  guardDurationMs = GUARD_DURATION_MS,
  preventCompletionReset = true,
  durationSec = 0,
}) {
  if (!videoId || typeof window === 'undefined') return;
  try {
    window.postMessage(
      {
        type: 'YOUSUB_RESUME_SET_GUARD',
        videoId,
        protectedMinTimeSec,
        guardDurationMs,
        preventCompletionReset,
        durationSec,
      },
      '*'
    );
  } catch {}
}

function postWatchtimePush({ videoId, currentTimeSec, durationSec, state }) {
  if (!videoId || typeof window === 'undefined') return;
  try {
    window.postMessage(
      {
        type: 'YOUSUB_RESUME_PUSH_WATCHTIME',
        videoId,
        currentTimeSec,
        durationSec,
        state,
      },
      '*'
    );
  } catch {}
}

function probePlayerData(videoId, myGen) {
  return new Promise((resolve) => {
    const fallback = {
      accountStartSec: 0,
      watchtimeBaseUrl: '',
      durationSec: 0,
      isLive: false,
      title: typeof document !== 'undefined' ? document.title || '' : '',
    };

    if (!videoId || typeof window === 'undefined') {
      resolve(fallback);
      return;
    }

    const requestId = `yousub_resume_${++probeCounter}`;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      window.removeEventListener('message', onMsg);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (cleanupProbe === cleanup) cleanupProbe = null;
    };

    const finish = (data) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data || fallback);
    };

    function onMsg(event) {
      if (event.source !== window || !event.data) return;
      if (event.data.type !== 'YOUSUB_RESUME_PLAYER_DATA') return;
      if (event.data.requestId !== requestId) return;
      finish(event.data);
    }

    if (cleanupProbe) cleanupProbe();
    cleanupProbe = () => finish(fallback);

    window.addEventListener('message', onMsg);
    timer = setTimeout(() => {
      if (myGen === sessionGen) {
        Logger.warn('PlaybackResume', 'Player probe timed out', { videoId, requestId });
      }
      finish(fallback);
    }, PROBE_TIMEOUT_MS);

    try {
      window.postMessage({ type: 'YOUSUB_RESUME_PROBE_PLAYER', videoId, requestId }, '*');
    } catch {
      finish(fallback);
    }
  });
}

function ensureMainWorldLogBridge() {
  if (logBridgeRegistered || typeof window === 'undefined') return;
  logBridgeRegistered = true;
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== 'YOUSUB_RESUME_LOG') return;
    const { level, tag, msg, data } = event.data;
    const safeLevel = ['INFO', 'WARN', 'ERROR', 'DEBUG', 'TRACE'].includes(level) ? level : 'INFO';
    Logger.log(safeLevel, tag || 'MainWorldResume', String(msg || ''), data || {});
  });
}

function hasRecentUserInteraction() {
  return Date.now() - lastInteractionEventAt <= USER_INTERACTION_WINDOW_MS;
}

function performAutoSeek(videoEl, targetSec, myGen) {
  if (!videoEl || myGen !== sessionGen) return;

  isAutoSeeking = true;
  if (autoSeekTimer) clearTimeout(autoSeekTimer);
  autoSeekTimer = setTimeout(() => {
    autoSeekTimer = null;
    isAutoSeeking = false;
  }, 1200);

  try {
    videoEl.currentTime = targetSec;
  } catch (e) {
    Logger.warn('PlaybackResume', 'Failed setting video.currentTime on auto-seek', {
      error: e?.message,
    });
  }

  // Re-assert once if YouTube resets currentTime back to 0 during metadata/buffer settle
  let reasserted = false;
  const onEarlyResetCheck = () => {
    if (reasserted || myGen !== sessionGen) return;
    if ((videoEl.currentTime || 0) < 3 && targetSec >= 10) {
      reasserted = true;
      try {
        videoEl.currentTime = targetSec;
        Logger.info('PlaybackResume', '[EARLY_RESET_GUARD] Re-asserted targetSec after 0s reset', {
          videoId: activeVideoId,
          targetSec,
        });
      } catch {}
    }
    detachEarlyCheck();
  };

  const detachEarlyCheck = () => {
    if (typeof videoEl.removeEventListener === 'function') {
      videoEl.removeEventListener('loadedmetadata', onEarlyResetCheck);
      videoEl.removeEventListener('canplay', onEarlyResetCheck);
    }
    if (earlyResetCleanupTimer) {
      clearTimeout(earlyResetCleanupTimer);
      earlyResetCleanupTimer = null;
    }
  };

  if (typeof videoEl.addEventListener === 'function') {
    videoEl.addEventListener('loadedmetadata', onEarlyResetCheck);
    videoEl.addEventListener('canplay', onEarlyResetCheck);
    earlyResetCleanupTimer = setTimeout(detachEarlyCheck, 3500);
  }
}

function showResumeToast(res) {
  const actions = [
    {
      label: '0:00',
      onClick: (closeToast) => {
        if (closeToast) closeToast();
        PlaybackResume.seekTo(0, { allowResetToZero: true });
      },
    },
  ];

  if (res.alternatives && res.alternatives.lastInteractionSec !== null) {
    const activeSec = res.alternatives.lastInteractionSec;
    actions.push({
      label: `Last Active ${formatTimestamp(activeSec)}`,
      onClick: (closeToast) => {
        if (closeToast) closeToast();
        PlaybackResume.seekTo(activeSec);
      },
    });
  }

  if (res.alternatives && res.alternatives.furthestSec !== null) {
    const farSec = res.alternatives.furthestSec;
    actions.push({
      label: `Furthest ${formatTimestamp(farSec)}`,
      onClick: (closeToast) => {
        if (closeToast) closeToast();
        PlaybackResume.seekTo(farSec);
      },
    });
  }

  const label = `⏱ Resumed at ${esc(formatTimestamp(res.targetSec))}`;
  Overlay.showStatus(label, 'info', 6500, {
    id: 'playback-resume',
    dismissible: true,
    actions,
  });
}

function attachSessionListeners(videoEl, myGen) {
  if (!videoEl || typeof videoEl.addEventListener !== 'function') return;

  const markUserInteraction = () => {
    lastInteractionEventAt = Date.now();
    if (isSleepFading && !isApplyingSleepFadeVolume) {
      cancelSleepTimerInternal();
    }
  };

  const persistSnapshot = (opts) => persistCurrentProgressSnapshot({ myGen, ...opts });

  const onTimeUpdate = () => {
    if (myGen !== sessionGen || isAutoSeeking) return;
    if (
      loopEnabled &&
      loopPointA !== null &&
      loopPointB !== null &&
      Number(activeVideoEl?.currentTime) >= loopPointB
    ) {
      isAutoSeeking = true;
      if (autoSeekTimer) clearTimeout(autoSeekTimer);
      autoSeekTimer = setTimeout(() => {
        autoSeekTimer = null;
        isAutoSeeking = false;
      }, 250);
      try {
        activeVideoEl.currentTime = loopPointA;
      } catch {
        /* ignore */
      }
      return;
    }

    const now = Date.now();
    if (now - lastLocalSaveAt < SAVE_THROTTLE_MS) return;

    const shouldPush = now - lastWatchtimePushAt >= WATCHTIME_PUSH_INTERVAL_MS;
    persistSnapshot({
      forceSyncFlush: false,
      pushWatchtime: shouldPush,
      state: activeVideoEl?.paused ? 'paused' : 'playing',
    });
  };

  const onPause = () => {
    if (!isAutoSeeking) markUserInteraction();
    persistSnapshot({ forceSyncFlush: true, pushWatchtime: true, state: 'paused' });
  };

  const onSeeked = () => {
    if (!isAutoSeeking) markUserInteraction();
    persistSnapshot({
      forceSyncFlush: true,
      pushWatchtime: true,
      state: activeVideoEl?.paused ? 'paused' : 'playing',
    });
  };

  const onPlayOrVolume = () => {
    if (!isAutoSeeking && !isApplyingSleepFadeVolume) markUserInteraction();
  };

  const onRateChange = () => {
    if (isApplyingSavedSpeed || myGen !== sessionGen || !activeVideoId || !activeVideoEl) return;
    if (currentSettings?.rememberPlaybackSpeed === false) return;
    if (typeof PlaybackResumeStore?.savePlaybackSpeed !== 'function') return;
    const rate = Number(activeVideoEl.playbackRate);
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 4.0) return;
    markUserInteraction();
    PlaybackResumeStore.savePlaybackSpeed(activeVideoId, rate, {
      channelName: activeChannelName,
      title: activeTitle,
      durationSec: activeDurationSec,
    }).catch(() => {});
  };

  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      persistSnapshot({ forceSyncFlush: true, pushWatchtime: true, state: 'paused' });
    }
  };

  const onPageHide = () => {
    persistSnapshot({ forceSyncFlush: true, pushWatchtime: true, state: 'paused' });
  };

  videoEl.addEventListener('timeupdate', onTimeUpdate);
  videoEl.addEventListener('pause', onPause);
  videoEl.addEventListener('seeked', onSeeked);
  videoEl.addEventListener('play', onPlayOrVolume);
  videoEl.addEventListener('volumechange', onPlayOrVolume);
  videoEl.addEventListener('ratechange', onRateChange);

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('pointerdown', markUserInteraction, { passive: true });
    document.addEventListener('keydown', markUserInteraction, { passive: true });
    document.addEventListener('touchstart', markUserInteraction, { passive: true });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
  }

  cleanupVideoListeners = () => {
    videoEl.removeEventListener('timeupdate', onTimeUpdate);
    videoEl.removeEventListener('pause', onPause);
    videoEl.removeEventListener('seeked', onSeeked);
    videoEl.removeEventListener('play', onPlayOrVolume);
    videoEl.removeEventListener('volumechange', onPlayOrVolume);
    videoEl.removeEventListener('ratechange', onRateChange);
  };

  cleanupGlobalListeners = () => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('pointerdown', markUserInteraction);
      document.removeEventListener('keydown', markUserInteraction);
      document.removeEventListener('touchstart', markUserInteraction);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onPageHide);
    }
  };
}

export const PlaybackResume = {
  init: function () {
    ensureMainWorldLogBridge();
  },

  onEnter: async function (videoId) {
    this.onLeave();
    ensureMainWorldLogBridge();

    if (!videoId || isShortsPath()) return;

    const myGen = sessionGen;
    activeVideoId = videoId;
    devLog('[YouSub] PlaybackResume: Entering watch page:', videoId);

    try {
      const settings = await PlaybackResumeStore.getSettings();
      if (myGen !== sessionGen) return;
      currentSettings = settings;
      if (!settings.enabled) return;

      const stored = await PlaybackResumeStore.getVideoRecord(videoId);
      if (myGen !== sessionGen) return;

      // Arm premature 0:00 watchtime guard immediately before player sends initial ping
      if (stored.mergedRecord && stored.mergedRecord.lastTimeSec >= 15) {
        postGuardConfig({
          videoId,
          protectedMinTimeSec: stored.mergedRecord.lastTimeSec,
          guardDurationMs: GUARD_DURATION_MS,
          preventCompletionReset: settings.preventCompletionReset,
          durationSec: stored.mergedRecord.durationSec,
        });
      }

      const [playerData, videoEl] = await Promise.all([
        probePlayerData(videoId, myGen),
        waitForActiveVideo(myGen),
      ]);

      if (myGen !== sessionGen || !videoEl) return;
      if (playerData && playerData.isLive) {
        Logger.debug('PlaybackResume', 'Skipping live stream', { videoId });
        return;
      }

      activeVideoEl = videoEl;
      activeDurationSec = Math.max(
        Number(videoEl.duration) || 0,
        Number(playerData?.durationSec) || 0
      );
      activeTitle = String(
        playerData?.title || (typeof document !== 'undefined' ? document.title : '') || ''
      )
        .replace(/\s*-\s*YouTube$/, '')
        .trim();
      activeChannelName = String(playerData?.channelName || '')
        .trim()
        .slice(0, 100);

      if (activeDurationSec > 0 && activeDurationSec < settings.minDurationSec) {
        Logger.debug('PlaybackResume', 'Skipping short video below minDurationSec', {
          videoId,
          durationSec: activeDurationSec,
          minDurationSec: settings.minDurationSec,
        });
        return;
      }

      if (
        settings.rememberPlaybackSpeed !== false &&
        typeof PlaybackResumeStore?.resolvePreferredSpeed === 'function'
      ) {
        const savedSpeed = await PlaybackResumeStore.resolvePreferredSpeed(
          videoId,
          activeChannelName
        ).catch(() => null);
        if (myGen !== sessionGen) return;
        if (savedSpeed && Math.abs((Number(videoEl.playbackRate) || 1) - savedSpeed) >= 0.01) {
          isApplyingSavedSpeed = true;
          try {
            videoEl.playbackRate = savedSpeed;
            Logger.info('PlaybackResume', '[SPEED_RESTORED] Applied saved playback speed', {
              videoId,
              channelName: activeChannelName,
              playbackRate: savedSpeed,
            });
          } catch {
            /* ignore read-only playbackRate */
          } finally {
            isApplyingSavedSpeed = false;
          }
        }
      }

      const resolution = resolveWithSettings(stored, playerData, activeDurationSec, settings);
      if (resolution.shouldResume) {
        postGuardConfig({
          videoId,
          protectedMinTimeSec: resolution.rawTargetSec,
          guardDurationMs: GUARD_DURATION_MS,
          preventCompletionReset: settings.preventCompletionReset,
          durationSec: activeDurationSec,
        });

        if (Math.abs((videoEl.currentTime || 0) - resolution.targetSec) > 5) {
          performAutoSeek(videoEl, resolution.targetSec, myGen);
          showResumeToast(resolution);
          Logger.info('PlaybackResume', '[AUTO_RESUMED] Restored playback position', {
            videoId,
            targetSec: resolution.targetSec,
            rawTargetSec: resolution.rawTargetSec,
            source: resolution.source,
            accountStartSec: playerData?.accountStartSec || 0,
          });
        }
      } else if (settings.preventCompletionReset && activeDurationSec >= 600) {
        postGuardConfig({
          videoId,
          protectedMinTimeSec: 0,
          guardDurationMs: 0,
          preventCompletionReset: true,
          durationSec: activeDurationSec,
        });
      }

      attachSessionListeners(videoEl, myGen);
    } catch (err) {
      Logger.error('PlaybackResume', 'onEnter initialization failed', {
        videoId,
        error: err?.message,
      });
    }
  },

  onLeave: function () {
    sessionGen++;
    cancelSleepTimerInternal({ silent: false });
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }
    if (activeVideoTimeout) {
      clearTimeout(activeVideoTimeout);
      activeVideoTimeout = null;
    }
    if (autoSeekTimer) {
      clearTimeout(autoSeekTimer);
      autoSeekTimer = null;
    }
    if (earlyResetCleanupTimer) {
      clearTimeout(earlyResetCleanupTimer);
      earlyResetCleanupTimer = null;
    }
    if (cleanupProbe) {
      cleanupProbe();
      cleanupProbe = null;
    }
    if (cleanupVideoListeners) {
      cleanupVideoListeners();
      cleanupVideoListeners = null;
    }
    if (cleanupGlobalListeners) {
      cleanupGlobalListeners();
      cleanupGlobalListeners = null;
    }

    activeVideoId = null;
    activeVideoEl = null;
    activeTitle = '';
    activeChannelName = '';
    activeDurationSec = 0;
    currentSettings = null;
    lastLocalSaveAt = 0;
    lastWatchtimePushAt = 0;
    lastInteractionEventAt = 0;
    isAutoSeeking = false;
    isApplyingSavedSpeed = false;
    clearAbLoopState();
  },

  destroy: function () {
    this.onLeave();
  },

  seekTo: async function (timeSec, { allowResetToZero = false } = {}) {
    if (!activeVideoId || !activeVideoEl) return false;
    const safeSec = Math.max(0, Number(timeSec) || 0);
    isAutoSeeking = true;
    if (autoSeekTimer) clearTimeout(autoSeekTimer);
    autoSeekTimer = setTimeout(() => {
      autoSeekTimer = null;
      isAutoSeeking = false;
    }, 800);

    try {
      activeVideoEl.currentTime = safeSec;
    } catch {
      return false;
    }

    lastInteractionEventAt = Date.now();
    const syncEnabled = currentSettings?.syncEnabled !== false;
    await PlaybackResumeStore.updateProgress(activeVideoId, {
      currentTimeSec: safeSec,
      durationSec: activeDurationSec,
      title: activeTitle,
      isUserInteraction: true,
      allowResetToZero,
      forceSyncFlush: true,
      syncEnabled,
    });

    if (syncEnabled) {
      postWatchtimePush({
        videoId: activeVideoId,
        currentTimeSec: safeSec,
        durationSec: activeDurationSec,
        state: activeVideoEl.paused ? 'paused' : 'playing',
      });
    }
    return true;
  },

  addCurrentBookmark: async function (label = '') {
    if (!activeVideoId) return null;
    const timeSec = activeVideoEl ? Number(activeVideoEl.currentTime) || 0 : 0;
    const dur = Math.max(activeDurationSec, Number(activeVideoEl?.duration) || 0);
    return PlaybackResumeStore.addBookmark(activeVideoId, {
      timeSec,
      label,
      title: activeTitle,
      channelName: activeChannelName,
      durationSec: dur,
    });
  },

  setLoopPointA: function (timeSec) {
    if (!activeVideoId || !activeVideoEl || isShortsPath()) return buildAbLoopState();
    const raw = timeSec !== undefined ? Number(timeSec) : Number(activeVideoEl.currentTime) || 0;
    loopPointA = Math.max(0, Math.floor(Number.isFinite(raw) ? raw : 0));
    if (loopPointB !== null && loopPointB <= loopPointA + 0.5) {
      loopPointB = null;
      loopEnabled = false;
    } else if (loopPointB !== null) {
      loopEnabled = true;
    }
    return buildAbLoopState();
  },

  setLoopPointB: function (timeSec) {
    if (!activeVideoId || !activeVideoEl || isShortsPath()) return buildAbLoopState();
    const raw = timeSec !== undefined ? Number(timeSec) : Number(activeVideoEl.currentTime) || 0;
    let b = Math.max(0, Math.floor(Number.isFinite(raw) ? raw : 0));
    if (loopPointA === null) {
      loopPointA = 0;
    }
    if (b < loopPointA) {
      const tmp = loopPointA;
      loopPointA = b;
      b = tmp;
    }
    if (b - loopPointA < 1) {
      b = loopPointA + 1;
    }
    loopPointB = b;
    loopEnabled = true;
    return buildAbLoopState();
  },

  clearLoop: function () {
    return clearAbLoopState();
  },

  getLoopState: function () {
    return buildAbLoopState();
  },

  getCurrentState: async function () {
    const settings = await PlaybackResumeStore.getSettings();
    const stored = activeVideoId ? await PlaybackResumeStore.getVideoRecord(activeVideoId) : null;
    return {
      videoId: activeVideoId,
      title: activeTitle,
      channelName: activeChannelName,
      currentTimeSec: activeVideoEl ? Math.floor(Number(activeVideoEl.currentTime) || 0) : 0,
      durationSec: Math.max(activeDurationSec, Number(activeVideoEl?.duration) || 0),
      playbackRate: activeVideoEl ? Number(activeVideoEl.playbackRate) || 1 : 1,
      record: stored ? stored.mergedRecord : null,
      settings,
      sleepTimer: buildSleepState(),
      abLoop: buildAbLoopState(),
    };
  },

  setSleepTimer: function (minutes) {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      return cancelSleepTimerInternal();
    }
    if (!activeVideoId || !activeVideoEl || isShortsPath()) {
      return cancelSleepTimerInternal();
    }

    cancelSleepTimerInternal({ silent: true });
    const myGen = sessionGen;
    const clampedMins = Math.min(360, Math.max(0.05, mins));
    const totalMs = Math.round(clampedMins * 60 * 1000);
    sleepTotalSec = Math.max(1, Math.round(totalMs / 1000));
    sleepEndAt = Date.now() + totalMs;

    Logger.info('PlaybackResume', '[SLEEP_TIMER] Armed', {
      videoId: activeVideoId,
      minutes: clampedMins,
    });

    sleepTickTimer = setInterval(() => {
      if (myGen !== sessionGen || !activeVideoEl) {
        cancelSleepTimerInternal();
        return;
      }
      if (Date.now() >= sleepEndAt) {
        beginSleepFadeOut(myGen);
      } else {
        notifySleepListeners();
      }
    }, 1000);

    return notifySleepListeners();
  },

  cancelSleepTimer: function () {
    return cancelSleepTimerInternal();
  },

  getSleepTimerState: function () {
    return buildSleepState();
  },

  onSleepTimerChange: function (listener) {
    if (typeof listener !== 'function') return () => {};
    sleepListeners.add(listener);
    return () => {
      sleepListeners.delete(listener);
    };
  },
};

function resolveWithSettings(stored, playerData, durationSec, settings) {
  return resolveResumeTarget({
    localRecord: stored.localRecord,
    syncRecord: stored.syncRecord,
    accountStartSec: playerData?.accountStartSec || 0,
    durationSec,
    rewindSec: settings.rewindSec,
    minDurationSec: settings.minDurationSec,
  });
}

if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.PlaybackResume = PlaybackResume;
}
