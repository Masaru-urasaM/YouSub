import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { TextEncoder } from 'util';

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}

const mockOverlay = {
  applyStyles: jest.fn(),
  resetLayout: jest.fn(),
  setTouchHandlesVisible: jest.fn((v) => Boolean(v)),
  areTouchHandlesVisible: jest.fn(() => false),
};

const mockPlaybackResume = {
  getCurrentState: jest.fn(),
  seekTo: jest.fn(() => Promise.resolve(true)),
  addCurrentBookmark: jest.fn(() => Promise.resolve({ videoId: 'vid-mob-1', bookmarks: [] })),
};

jest.unstable_mockModule('../../src/content/overlay.js', () => ({
  Overlay: mockOverlay,
}));
jest.unstable_mockModule('../../src/content/playback-resume.js', () => ({
  PlaybackResume: mockPlaybackResume,
}));

const { RESUME_STORAGE_KEY } = await import('../../src/shared/constants.js');
const { PlaybackResumeStore } = await import('../../src/shared/playback-resume-store.js');
const { MobileDrawer, shouldShowMobileFab, MOBILE_FAB_POS_KEY } =
  await import('../../src/content/mobile-drawer.js');

async function flushMicrotasks(turns = 10) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

describe('MobileDrawer & In-Page Control Pill (Phase 86)', () => {
  beforeEach(() => {
    jest.useRealTimers();
    chrome.storage.local.store = {};
    chrome.storage.sync.store = {};
    chrome.storage.onChanged._listeners = [];
    PlaybackResumeStore._resetInternalForTests();
    document.body.innerHTML = '';
    jest.clearAllMocks();

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      writable: true,
      value: null,
    });
    window.history.replaceState({}, '', '/watch?v=vid-mob-1');
    mockOverlay.areTouchHandlesVisible.mockReturnValue(false);
    mockPlaybackResume.getCurrentState.mockResolvedValue({
      videoId: 'vid-mob-1',
      title: 'Long Audiobook Ch.1',
      currentTimeSec: 1200,
      durationSec: 7200,
      settings: { enabled: true },
      record: {
        videoId: 'vid-mob-1',
        title: 'Long Audiobook Ch.1',
        durationSec: 7200,
        lastTimeSec: 1200,
        lastInteractionTimeSec: 900,
        furthestTimeSec: 1500,
        bookmarks: [{ id: 'bm-1', timeSec: 600, label: 'Intro', createdAt: 1000 }],
        checkpoints: [{ timeSec: 1800, savedAt: 2000 }],
      },
    });
  });

  afterEach(() => {
    MobileDrawer.destroy();
    PlaybackResumeStore._resetInternalForTests();
    jest.useRealTimers();
  });

  test('shouldShowMobileFab detects m.youtube.com, touch viewports, and Desktop opt-in toggle', () => {
    expect(
      shouldShowMobileFab({
        hostname: 'm.youtube.com',
        matchMedia: () => ({ matches: false }),
        maxTouchPoints: 0,
        innerWidth: 400,
        showDesktopFab: false,
      })
    ).toBe(true);

    expect(
      shouldShowMobileFab({
        hostname: 'www.youtube.com',
        matchMedia: (q) => ({ matches: q.includes('pointer: coarse') }),
        maxTouchPoints: 5,
        innerWidth: 412,
        showDesktopFab: false,
      })
    ).toBe(true);

    expect(
      shouldShowMobileFab({
        hostname: 'www.youtube.com',
        matchMedia: () => ({ matches: false }),
        maxTouchPoints: 0,
        innerWidth: 1440,
        showDesktopFab: false,
      })
    ).toBe(false);

    expect(
      shouldShowMobileFab({
        hostname: 'www.youtube.com',
        matchMedia: () => ({ matches: false }),
        maxTouchPoints: 0,
        innerWidth: 1440,
        showDesktopFab: true,
      })
    ).toBe(true);
  });

  test('auto-dims pill after 3.5s, toggles bottom sheet on tap, and executes subtitle + appearance controls', async () => {
    jest.useFakeTimers();
    const onToggleTranslation = jest.fn();
    const onToggleDualMode = jest.fn();
    const onChangeTargetLang = jest.fn();
    const onOpenSettings = jest.fn();

    chrome.storage.local.store = {
      yousub_appearance: {
        fontSize: 1.5,
        fontColor: '#ffffff',
        bgOpacity: 0.25,
        posBottom: 40,
        showDesktopFab: true,
      },
      targetLang: 'vi',
      yousub_dual_mode: false,
    };

    MobileDrawer.init({
      onToggleTranslation,
      onToggleDualMode,
      onChangeTargetLang,
      onOpenSettings,
    });
    await MobileDrawer.onEnter('vid-mob-1');

    const fab = document.getElementById('yousub-mobile-fab');
    expect(fab).not.toBeNull();
    expect(fab.classList.contains('yousub-fab-dimmed')).toBe(false);

    jest.advanceTimersByTime(3600);
    expect(fab.classList.contains('yousub-fab-dimmed')).toBe(true);
    jest.useRealTimers();

    // Open drawer
    fab.click();
    await flushMicrotasks();
    const drawer = document.getElementById('yousub-mobile-drawer');
    expect(MobileDrawer.isOpen()).toBe(true);
    expect(drawer.classList.contains('hidden')).toBe(false);

    // Toggle translation ON
    document.getElementById('ys-drawer-translate-btn').click();
    expect(onToggleTranslation).toHaveBeenCalledWith(true, 'vi', 'vid-mob-1');
    expect(fab.classList.contains('yousub-fab-active')).toBe(true);
    await flushMicrotasks();

    // Toggle Dual Subtitles
    document.getElementById('ys-drawer-dual-btn').click();
    await flushMicrotasks();
    expect(onToggleDualMode).toHaveBeenCalledWith(true);
    expect(chrome.storage.local.store.yousub_dual_mode).toBe(true);

    // Change Target Language
    const langSel = document.getElementById('ys-drawer-lang-select');
    langSel.value = 'ja';
    langSel.dispatchEvent(new Event('change'));
    await flushMicrotasks();
    expect(onChangeTargetLang).toHaveBeenCalledWith('ja');
    expect(chrome.storage.local.store.targetLang).toBe('ja');

    // Increase font size (1.5 -> 1.6)
    document.getElementById('ys-drawer-font-inc').click();
    await flushMicrotasks();
    expect(chrome.storage.local.store.yousub_appearance.fontSize).toBe(1.6);
    expect(mockOverlay.applyStyles).toHaveBeenCalledWith(
      expect.objectContaining({ fontSize: 1.6 })
    );

    // Touch handles toggle & Reset Position
    document.getElementById('ys-drawer-touch-handles-btn').click();
    expect(mockOverlay.setTouchHandlesVisible).toHaveBeenCalledWith(true);

    document.getElementById('ys-drawer-reset-layout-btn').click();
    await flushMicrotasks();
    expect(mockOverlay.resetLayout).toHaveBeenCalled();

    // Open settings button
    document.getElementById('ys-drawer-settings-btn').click();
    expect(onOpenSettings).toHaveBeenCalled();
  });

  test('executes Resume pills, + Bookmark, remove bookmark, recent list, and hides active panel on Shorts', async () => {
    chrome.storage.local.store = {
      yousub_appearance: { showDesktopFab: true },
      [RESUME_STORAGE_KEY]: {
        'vid-mob-1': {
          videoId: 'vid-mob-1',
          title: 'Audiobook 1',
          durationSec: 3600,
          lastTimeSec: 1200,
          updatedAt: 5000,
          bookmarks: [{ id: 'bm-1', timeSec: 600, label: 'Intro', createdAt: 1000 }],
        },
        'vid-other-2': {
          videoId: 'vid-other-2',
          title: 'Audiobook 2',
          durationSec: 1800,
          lastTimeSec: 400,
          updatedAt: 4000,
        },
      },
    };

    await MobileDrawer.onEnter('vid-mob-1');
    MobileDrawer.open();
    await flushMicrotasks();

    // Quick pills & Bookmarks render on /watch
    const quickPills = document.querySelectorAll('#ys-drawer-quick-pills button');
    expect(quickPills.length).toBeGreaterThanOrEqual(2);
    quickPills[0].click();
    await flushMicrotasks();
    expect(mockPlaybackResume.seekTo).toHaveBeenCalledWith(1200, { allowResetToZero: false });

    document.getElementById('ys-drawer-bookmark-btn').click();
    await flushMicrotasks();
    expect(mockPlaybackResume.addCurrentBookmark).toHaveBeenCalledWith('');

    // Delete bookmark bm-1
    const delBmBtn = document.querySelector('.yousub-drawer-bookmark-del');
    delBmBtn.click();
    await flushMicrotasks();
    const storedAfterDel = chrome.storage.local.store[RESUME_STORAGE_KEY]['vid-mob-1'];
    expect(storedAfterDel.bookmarks).toEqual([]);

    // Navigate to Shorts: hides + Bookmark & quick pills while keeping Recent list
    window.history.replaceState({}, '', '/shorts/short123');
    await MobileDrawer.onEnter('short123');
    MobileDrawer.open();
    await flushMicrotasks();
    expect(document.getElementById('ys-drawer-bookmark-btn')).toBeNull();
    expect(document.querySelectorAll('.yousub-drawer-recent-row').length).toBeGreaterThanOrEqual(1);
  });

  test('supports edge vertical drag persistence and reparents into fullscreenElement', async () => {
    chrome.storage.local.store = { yousub_appearance: { showDesktopFab: true } };
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    await MobileDrawer.onEnter('vid-drag-1');
    const fab = document.getElementById('yousub-mobile-fab');

    const pointerEvt = (type, y) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      ev.clientY = y;
      ev.pointerId = 1;
      return ev;
    };

    fab.dispatchEvent(pointerEvt('pointerdown', 400));
    fab.dispatchEvent(pointerEvt('pointermove', 240)); // -160px = -20% (62% -> 42%)
    fab.dispatchEvent(pointerEvt('pointerup', 240));
    await flushMicrotasks();

    expect(MobileDrawer.isOpen()).toBe(false);
    expect(chrome.storage.local.store[MOBILE_FAB_POS_KEY].topPct).toBe(42);

    // Fullscreen reparenting
    const fsHost = document.createElement('div');
    document.body.appendChild(fsHost);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: fsHost });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(fsHost.contains(document.getElementById('yousub-mobile-fab-root'))).toBe(true);

    // Desktop opt-in toggle via storage.onChanged removes/adds pill cleanly
    chrome.storage.onChanged._listeners.forEach((fn) =>
      fn({ yousub_appearance: { newValue: { showDesktopFab: false } } }, 'local')
    );
    expect(MobileDrawer.isVisible()).toBe(false);

    MobileDrawer.onLeave();
    expect(document.getElementById('yousub-mobile-fab-root')).toBeNull();
  });
});
