import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockLogger = {
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

const mockOverlay = {
  init: jest.fn(),
  show: jest.fn(),
  hide: jest.fn(),
  showStatus: jest.fn(),
  clearStatus: jest.fn(),
  destroy: jest.fn(),
};

const mockStore = {
  getSettings: jest.fn(),
  getVideoRecord: jest.fn(),
  updateProgress: jest.fn(() => Promise.resolve({})),
  addBookmark: jest.fn(() => Promise.resolve({ bookmarks: [{ id: 'b1', timeSec: 120 }] })),
  savePlaybackSpeed: jest.fn(() => Promise.resolve({})),
  resolvePreferredSpeed: jest.fn(() => Promise.resolve(null)),
};

const mockResolveResumeTarget = jest.fn();

jest.unstable_mockModule('../../src/shared/logger.js', () => ({
  Logger: mockLogger,
}));
jest.unstable_mockModule('../../src/content/overlay.js', () => ({
  Overlay: mockOverlay,
}));
jest.unstable_mockModule('../../src/shared/playback-resume-store.js', () => ({
  PlaybackResumeStore: mockStore,
  resolveResumeTarget: mockResolveResumeTarget,
  formatTimestamp: (sec) => {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
      : `${m}:${String(r).padStart(2, '0')}`;
  },
  formatCountdown: (sec) => {
    const s = Math.max(0, Math.ceil(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  },
}));

const { PlaybackResume } = await import('../../src/content/playback-resume.js');

const flushAsync = async (turns = 12) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

function makeVisibleVideo({ currentTime = 0, duration = 7200, paused = false } = {}) {
  const video = document.createElement('video');
  video.className = 'html5-main-video';
  Object.defineProperty(video, 'offsetWidth', { configurable: true, value: 640 });
  Object.defineProperty(video, 'offsetHeight', { configurable: true, value: 360 });
  let cur = currentTime;
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => cur,
    set: (v) => {
      cur = v;
    },
  });
  Object.defineProperty(video, 'duration', { configurable: true, value: duration });
  Object.defineProperty(video, 'paused', { configurable: true, value: paused });
  document.body.appendChild(video);
  return video;
}

describe('PlaybackResume content controller (Phase 84)', () => {
  let postMessageCalls = [];
  let postSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    PlaybackResume.destroy();
    document.body.innerHTML = '';
    window.history.pushState({}, '', '/watch?v=audio1');
    postMessageCalls = [];

    mockStore.getSettings.mockResolvedValue({
      enabled: true,
      rewindSec: 3,
      minDurationSec: 60,
      syncEnabled: true,
      preventCompletionReset: true,
    });
    mockStore.getVideoRecord.mockResolvedValue({
      localRecord: null,
      syncRecord: null,
      mergedRecord: null,
    });
    mockResolveResumeTarget.mockReturnValue({
      shouldResume: false,
      targetSec: 0,
      rawTargetSec: 0,
      source: 'none',
      mergedRecord: null,
      alternatives: { furthestSec: null, lastInteractionSec: null, accountSec: null },
    });

    postSpy = jest.spyOn(window, 'postMessage').mockImplementation((msg) => {
      postMessageCalls.push(msg);
      if (msg && msg.type === 'YOUSUB_RESUME_PROBE_PLAYER') {
        const replyData = window.__testProbeOverride || {
          accountStartSec: 0,
          watchtimeBaseUrl: 'https://s.youtube.com/api/stats/watchtime?docid=' + msg.videoId,
          durationSec: 7200,
          isLive: false,
          title: 'Test Audiobook - YouTube',
        };
        Promise.resolve().then(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              source: window,
              data: {
                type: 'YOUSUB_RESUME_PLAYER_DATA',
                requestId: msg.requestId,
                videoId: msg.videoId,
                ...replyData,
              },
            })
          );
        });
      }
    });
  });

  afterEach(() => {
    PlaybackResume.destroy();
    delete window.__testProbeOverride;
    jest.useRealTimers();
    if (postSpy) postSpy.mockRestore();
  });

  test('skips Shorts URLs, disabled setting, live streams, and short videos < minDurationSec', async () => {
    // 1. Shorts
    window.history.pushState({}, '', '/shorts/sh123');
    makeVisibleVideo({ duration: 300 });
    await PlaybackResume.onEnter('sh123');
    expect(mockStore.getSettings).not.toHaveBeenCalled();

    // 2. Disabled
    window.history.pushState({}, '', '/watch?v=dis1');
    mockStore.getSettings.mockResolvedValueOnce({ enabled: false, minDurationSec: 60 });
    await PlaybackResume.onEnter('dis1');
    expect(mockStore.getVideoRecord).not.toHaveBeenCalled();

    // 3. Live stream
    window.__testProbeOverride = { isLive: true, durationSec: 0, accountStartSec: 0 };
    await PlaybackResume.onEnter('live1');
    expect(mockResolveResumeTarget).not.toHaveBeenCalled();

    // 4. Short video < minDurationSec
    document.body.innerHTML = '';
    makeVisibleVideo({ duration: 40 });
    window.__testProbeOverride = { isLive: false, durationSec: 40, accountStartSec: 20 };
    await PlaybackResume.onEnter('short1');
    expect(mockResolveResumeTarget).not.toHaveBeenCalled();
  });

  test('auto-seeks to targetSec, re-asserts on early 0:00 canplay reset, arms watchtime guard, and displays toast actions', async () => {
    const video = makeVisibleVideo({ currentTime: 0, duration: 36000 });
    mockStore.getVideoRecord.mockResolvedValueOnce({
      localRecord: { videoId: 'longBook1', lastTimeSec: 14250, updatedAt: 1000 },
      syncRecord: null,
      mergedRecord: { videoId: 'longBook1', lastTimeSec: 14250, durationSec: 36000 },
    });
    mockResolveResumeTarget.mockReturnValueOnce({
      shouldResume: true,
      targetSec: 14247,
      rawTargetSec: 14250,
      source: 'local',
      mergedRecord: { videoId: 'longBook1', lastTimeSec: 14250 },
      alternatives: { furthestSec: 18000, lastInteractionSec: 10000, accountSec: null },
    });

    await PlaybackResume.onEnter('longBook1');
    await flushAsync();

    // Early guard armed + updated guard armed
    const guardMsgs = postMessageCalls.filter((m) => m?.type === 'YOUSUB_RESUME_SET_GUARD');
    expect(guardMsgs.length).toBeGreaterThanOrEqual(2);
    expect(guardMsgs[0].protectedMinTimeSec).toBe(14250);

    // Seeked video to 14247
    expect(video.currentTime).toBe(14247);

    // Simulate YouTube resetting video.currentTime back to 0 during canplay -> re-asserts!
    video.currentTime = 0;
    video.dispatchEvent(new Event('canplay'));
    expect(video.currentTime).toBe(14247);

    // Toast shown with 0:00, Last Active, and Furthest quick-jump actions
    expect(mockOverlay.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('3:57:27'),
      'info',
      6500,
      expect.objectContaining({
        id: 'playback-resume',
        dismissible: true,
        actions: expect.arrayContaining([
          expect.objectContaining({ label: '0:00' }),
          expect.objectContaining({ label: 'Last Active 2:46:40' }),
          expect.objectContaining({ label: 'Furthest 5:00:00' }),
        ]),
      })
    );

    // Clicking "0:00" action resets with allowResetToZero=true
    const actions = mockOverlay.showStatus.mock.calls[0][3].actions;
    const closeSpy = jest.fn();
    actions[0].onClick(closeSpy);
    await flushAsync();
    expect(closeSpy).toHaveBeenCalled();
    expect(video.currentTime).toBe(0);
    expect(mockStore.updateProgress).toHaveBeenCalledWith(
      'longBook1',
      expect.objectContaining({ currentTimeSec: 0, allowResetToZero: true, forceSyncFlush: true })
    );

    // Clicking "Last Active" seeks to 10000
    actions[1].onClick(jest.fn());
    await flushAsync();
    expect(video.currentTime).toBe(10000);
  });

  test('throttles timeupdate saves to 3s, detects real user interaction vs sleep, and flushes + pushes on pause/visibilitychange/pagehide', async () => {
    let nowMs = 50000;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const video = makeVisibleVideo({ currentTime: 100, duration: 7200, paused: false });

    await PlaybackResume.onEnter('trackVid');
    await flushAsync();

    // First timeupdate (lastLocalSaveAt=0 -> passes throttle) WITHOUT user interaction -> isUserInteraction: false
    video.currentTime = 110;
    video.dispatchEvent(new Event('timeupdate'));
    expect(mockStore.updateProgress).toHaveBeenLastCalledWith(
      'trackVid',
      expect.objectContaining({
        currentTimeSec: 110,
        isUserInteraction: false,
        forceSyncFlush: false,
      })
    );

    // Immediate timeupdate 1s later -> throttled
    nowMs += 1000;
    mockStore.updateProgress.mockClear();
    video.currentTime = 111;
    video.dispatchEvent(new Event('timeupdate'));
    expect(mockStore.updateProgress).not.toHaveBeenCalled();

    // User taps screen (pointerdown) then timeupdate 3s later -> isUserInteraction: true
    nowMs += 3000;
    document.dispatchEvent(new Event('pointerdown'));
    video.currentTime = 114;
    video.dispatchEvent(new Event('timeupdate'));
    expect(mockStore.updateProgress).toHaveBeenLastCalledWith(
      'trackVid',
      expect.objectContaining({ currentTimeSec: 114, isUserInteraction: true })
    );

    // Pause -> immediate forceSyncFlush + YOUSUB_RESUME_PUSH_WATCHTIME
    postMessageCalls = [];
    video.currentTime = 120;
    video.dispatchEvent(new Event('pause'));
    expect(mockStore.updateProgress).toHaveBeenLastCalledWith(
      'trackVid',
      expect.objectContaining({ currentTimeSec: 120, forceSyncFlush: true })
    );
    expect(postMessageCalls.some((m) => m?.type === 'YOUSUB_RESUME_PUSH_WATCHTIME')).toBe(true);

    // pagehide -> flushes & pushes
    postMessageCalls = [];
    mockStore.updateProgress.mockClear();
    video.currentTime = 125;
    window.dispatchEvent(new Event('pagehide'));
    expect(mockStore.updateProgress).toHaveBeenCalledWith(
      'trackVid',
      expect.objectContaining({ currentTimeSec: 125, forceSyncFlush: true })
    );
    expect(postMessageCalls.some((m) => m?.type === 'YOUSUB_RESUME_PUSH_WATCHTIME')).toBe(true);

    // visibilitychange hidden -> flushes & pushes
    postMessageCalls = [];
    mockStore.updateProgress.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mockStore.updateProgress).toHaveBeenCalled();
    expect(postMessageCalls.some((m) => m?.type === 'YOUSUB_RESUME_PUSH_WATCHTIME')).toBe(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    dateSpy.mockRestore();
  });

  test('relays YOUSUB_RESUME_LOG messages from MAIN world into Logger, supports addCurrentBookmark/getCurrentState, and cancels cleanly on onLeave()', async () => {
    const video = makeVisibleVideo({ currentTime: 300, duration: 3600 });
    mockStore.getVideoRecord.mockResolvedValue({
      localRecord: {
        videoId: 'bmState1',
        lastTimeSec: 300,
        bookmarks: [{ id: 'b1', timeSec: 120 }],
      },
      syncRecord: null,
      mergedRecord: {
        videoId: 'bmState1',
        lastTimeSec: 300,
        bookmarks: [{ id: 'b1', timeSec: 120 }],
      },
    });

    await PlaybackResume.onEnter('bmState1');
    await flushAsync();

    // Forward MAIN world log event into Logger
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          type: 'YOUSUB_RESUME_LOG',
          level: 'INFO',
          tag: 'MainWorldResume',
          msg: '[GUARD_REWRITE]',
          data: { videoId: 'bmState1' },
        },
      })
    );
    expect(mockLogger.log).toHaveBeenCalledWith('INFO', 'MainWorldResume', '[GUARD_REWRITE]', {
      videoId: 'bmState1',
    });

    // Bookmark & getCurrentState
    await PlaybackResume.addCurrentBookmark('Scene 1');
    expect(mockStore.addBookmark).toHaveBeenCalledWith(
      'bmState1',
      expect.objectContaining({ timeSec: 300, label: 'Scene 1', durationSec: 7200 })
    );

    const state = await PlaybackResume.getCurrentState();
    expect(state.videoId).toBe('bmState1');
    expect(state.currentTimeSec).toBe(300);

    // onLeave detaches listeners & resets state
    PlaybackResume.onLeave();
    mockStore.updateProgress.mockClear();
    video.dispatchEvent(new Event('pause'));
    expect(mockStore.updateProgress).not.toHaveBeenCalled();
    expect(await PlaybackResume.seekTo(100)).toBe(false);
  });

  test('Sleep Timer counts down, fades volume over 5s, pauses, restores volume, and drops "Sleep stop" bookmark (Phase 87)', async () => {
    jest.useFakeTimers();
    const video = makeVisibleVideo({ currentTime: 1850, duration: 7200, paused: false });
    let vol = 0.8;
    Object.defineProperty(video, 'volume', {
      configurable: true,
      get: () => vol,
      set: (v) => {
        vol = v;
      },
    });
    video.pause = jest.fn();

    await PlaybackResume.onEnter('sleepVid1');
    // Flush initial async setup under fake timers cleanly
    for (let i = 0; i < 15; i++) await Promise.resolve();

    const changes = [];
    const unsub = PlaybackResume.onSleepTimerChange((st) => changes.push(st));

    const armed = PlaybackResume.setSleepTimer(1); // 60 seconds
    expect(armed.active).toBe(true);
    expect(armed.remainingSec).toBe(60);
    expect(armed.badgeText).toBe('01:00');

    // Advance 59s -> still active, not fading
    jest.advanceTimersByTime(59000);
    expect(PlaybackResume.getSleepTimerState().isFading).toBe(false);
    expect(vol).toBe(0.8);

    // Advance 1s -> hits 60s -> begins 5s fade
    jest.advanceTimersByTime(1000);
    expect(PlaybackResume.getSleepTimerState().isFading).toBe(true);

    // Mid-fade after 2.5s (5 steps of 500ms) -> volume halved smoothly
    jest.advanceTimersByTime(2500);
    expect(vol).toBeCloseTo(0.4, 2);
    expect(video.pause).not.toHaveBeenCalled();

    // Finish fade (remaining 2.5s) -> paused, volume restored, flushed & Sleep stop bookmark added
    jest.advanceTimersByTime(2500);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(vol).toBeCloseTo(0.8, 2);
    expect(mockStore.addBookmark).toHaveBeenCalledWith(
      'sleepVid1',
      expect.objectContaining({ timeSec: 1850, label: 'Sleep stop' })
    );
    expect(mockOverlay.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Sleep stop'),
      'info',
      7000,
      expect.objectContaining({ id: 'sleep-timer-stop' })
    );
    expect(PlaybackResume.getSleepTimerState().active).toBe(false);
    unsub();
    jest.useRealTimers();
  });

  test('Sleep Timer aborts fade and restores volume when user interacts or cancels (Phase 87)', async () => {
    jest.useFakeTimers();
    const video = makeVisibleVideo({ currentTime: 900, duration: 7200, paused: false });
    let vol = 0.7;
    Object.defineProperty(video, 'volume', {
      configurable: true,
      get: () => vol,
      set: (v) => {
        vol = v;
      },
    });
    video.pause = jest.fn();

    await PlaybackResume.onEnter('sleepAbort1');
    for (let i = 0; i < 15; i++) await Promise.resolve();

    PlaybackResume.setSleepTimer(1);
    jest.advanceTimersByTime(60000); // enter fade
    jest.advanceTimersByTime(1500); // 3 fade steps -> volume drops below 0.7
    expect(vol).toBeLessThan(0.7);

    // User taps screen during fade -> cancels fade immediately & restores original volume
    document.dispatchEvent(new Event('pointerdown'));
    expect(PlaybackResume.getSleepTimerState().active).toBe(false);
    expect(vol).toBeCloseTo(0.7, 2);
    jest.advanceTimersByTime(5000);
    expect(video.pause).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  test('restores saved playback speed, persists manual ratechange, and enforces A-B Repeat Loop (Phase 88)', async () => {
    window.__testProbeOverride = {
      accountStartSec: 0,
      watchtimeBaseUrl: 'https://www.youtube.com/api/stats/watchtime?docid=abVid1',
      durationSec: 3600,
      isLive: false,
      title: 'Shadowing Practice',
      channelName: 'Podcast Channel',
    };
    mockStore.resolvePreferredSpeed.mockResolvedValueOnce(1.25);

    const video = makeVisibleVideo({ currentTime: 50, duration: 3600, paused: false });
    let rate = 1.0;
    Object.defineProperty(video, 'playbackRate', {
      configurable: true,
      get: () => rate,
      set: (v) => {
        rate = v;
      },
    });

    await PlaybackResume.onEnter('abVid1');
    await flushAsync();

    // Restored channel speed without triggering savePlaybackSpeed
    expect(rate).toBe(1.25);
    expect(mockStore.savePlaybackSpeed).not.toHaveBeenCalled();

    // User manually changes speed -> saved
    rate = 1.5;
    video.dispatchEvent(new Event('ratechange'));
    expect(mockStore.savePlaybackSpeed).toHaveBeenCalledWith('abVid1', 1.5, {
      channelName: 'Podcast Channel',
      title: 'Shadowing Practice',
      durationSec: 3600,
    });

    // A-B Repeat Loop: set A=20s, B=30s -> timeupdate at 31s jumps back to 20s
    PlaybackResume.setLoopPointA(20);
    PlaybackResume.setLoopPointB(30);
    expect(PlaybackResume.getLoopState()).toEqual({ active: true, pointA: 20, pointB: 30 });

    video.currentTime = 31;
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.currentTime).toBe(20);

    PlaybackResume.clearLoop();
    expect(PlaybackResume.getLoopState()).toEqual({ active: false, pointA: null, pointB: null });
    delete window.__testProbeOverride;
  });
});
