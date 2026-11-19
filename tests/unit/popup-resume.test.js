import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TextEncoder } from 'util';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POPUP_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/popup/popup.html'), 'utf8');

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

jest.unstable_mockModule('../../src/shared/logger.js', () => ({
  Logger: mockLogger,
}));

const { RESUME_STORAGE_KEY, RESUME_SYNC_KEY, RESUME_SETTINGS_KEY } =
  await import('../../src/shared/constants.js');
const { PlaybackResumeStore } = await import('../../src/shared/playback-resume-store.js');
const { PopupResumeView, parseWatchUrl, buildQuickJumpPills } =
  await import('../../src/popup/popup-resume-view.js');

function mountPopupDom() {
  const parsed = new DOMParser().parseFromString(POPUP_HTML, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('PopupResumeView (Phase 85)', () => {
  let controller = null;

  beforeEach(() => {
    chrome.storage.local.store = {};
    chrome.storage.sync.store = {};
    chrome.storage.onChanged._listeners = [];
    PlaybackResumeStore._resetInternalForTests();
    jest.clearAllMocks();
    mountPopupDom();
  });

  afterEach(() => {
    if (controller && typeof controller.destroy === 'function') {
      controller.destroy();
      controller = null;
    }
    PlaybackResumeStore._resetInternalForTests();
  });

  test('parseWatchUrl handles www, m.youtube.com, Shorts, non-YouTube, and invalid URLs', () => {
    expect(parseWatchUrl('https://www.youtube.com/watch?v=story123&t=45s')).toEqual({
      videoId: 'story123',
      isWatch: true,
      isShorts: false,
    });
    expect(parseWatchUrl('https://m.youtube.com/watch?v=mob456')).toEqual({
      videoId: 'mob456',
      isWatch: true,
      isShorts: false,
    });
    expect(parseWatchUrl('https://www.youtube.com/shorts/short789')).toEqual({
      videoId: 'short789',
      isWatch: false,
      isShorts: true,
    });
    expect(parseWatchUrl('https://example.com/watch?v=abc')).toEqual({
      videoId: null,
      isWatch: false,
      isShorts: false,
    });
    expect(parseWatchUrl('not-a-url')).toEqual({
      videoId: null,
      isWatch: false,
      isShorts: false,
    });
  });

  test('buildQuickJumpPills returns deduplicated Last, Last Active, and Furthest pills', () => {
    expect(buildQuickJumpPills(null)).toEqual([]);

    const nearlySame = buildQuickJumpPills({
      lastTimeSec: 600,
      lastInteractionTimeSec: 599,
      furthestTimeSec: 601,
    });
    expect(nearlySame.map((p) => p.id)).toEqual(['last']);

    const diverged = buildQuickJumpPills({
      lastTimeSec: 500,
      lastInteractionTimeSec: 1200,
      furthestTimeSec: 3600,
    });
    expect(diverged.map((p) => ({ id: p.id, timeSec: p.timeSec }))).toEqual([
      { id: 'last', timeSec: 500 },
      { id: 'active', timeSec: 1200 },
      { id: 'furthest', timeSec: 3600 },
    ]);
  });

  test('initializes auto-resume toggle and persists changes', async () => {
    await PlaybackResumeStore.saveSettings({ enabled: false });
    chrome.tabs.query.mockResolvedValue([{ id: 1, url: 'https://example.com' }]);

    controller = await PopupResumeView.init();
    const toggle = document.getElementById('resume-auto-toggle');
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    const saved = await PlaybackResumeStore.getSettings();
    expect(saved.enabled).toBe(true);
  });

  test('hides active video panel and bookmark button on YouTube Shorts while keeping recent list', async () => {
    await PlaybackResumeStore.updateProgress('audiobook_1', {
      title: 'Long Audiobook Ch.1',
      currentTimeSec: 1800,
      durationSec: 7200,
      forceSyncFlush: true,
    });
    chrome.tabs.query.mockResolvedValue([
      { id: 10, url: 'https://www.youtube.com/shorts/shortVid1' },
    ]);

    controller = await PopupResumeView.init();

    expect(document.getElementById('resume-add-bookmark-btn').classList.contains('hidden')).toBe(
      true
    );
    expect(document.getElementById('resume-active-panel').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('resume-recent-count').textContent).toBe('1');
  });

  test('renders quick-jump pills, checkpoints, bookmarks and dispatches seek on /watch', async () => {
    const activeUrl = 'https://m.youtube.com/watch?v=story_42';
    chrome.tabs.query.mockResolvedValue([{ id: 42, url: activeUrl }]);
    chrome.tabs.sendMessage.mockImplementation(async (_tabId, msg) => {
      if (msg.type === 'YOUSUB_RESUME_GET_STATE') {
        return {
          videoId: 'story_42',
          title: 'Chapter 10 <script>alert(1)</script>',
          currentTimeSec: 900,
          durationSec: 7200,
          record: {
            videoId: 'story_42',
            title: 'Chapter 10',
            durationSec: 7200,
            lastTimeSec: 900,
            lastInteractionTimeSec: 2100,
            furthestTimeSec: 4500,
            checkpoints: [{ timeSec: 1800, createdAt: 1000 }],
            bookmarks: [{ id: 'bm_1', timeSec: 1500, label: 'Plot twist', createdAt: 1200 }],
            updatedAt: 2000,
          },
        };
      }
      if (msg.type === 'YOUSUB_RESUME_SEEK_TO') {
        return { ok: true };
      }
      if (msg.type === 'YOUSUB_RESUME_ADD_BOOKMARK') {
        await PlaybackResumeStore.addBookmark('story_42', {
          timeSec: 2400,
          label: 'Live mark',
          title: 'Chapter 10',
          durationSec: 7200,
        });
        return { ok: true };
      }
      return null;
    });

    await PlaybackResumeStore.updateProgress('story_42', {
      title: 'Chapter 10',
      currentTimeSec: 900,
      durationSec: 7200,
      forceSyncFlush: true,
    });

    controller = await PopupResumeView.init();

    expect(document.getElementById('resume-add-bookmark-btn').classList.contains('hidden')).toBe(
      false
    );
    expect(document.getElementById('resume-active-panel').classList.contains('hidden')).toBe(false);

    const pills = Array.from(document.querySelectorAll('#resume-quick-pills .resume-pill'));
    expect(pills.map((el) => el.textContent)).toEqual([
      'Last 15:00',
      'Last Active 35:00',
      'Furthest 1:15:00',
    ]);

    pills[2].click();
    await flushMicrotasks();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
      type: 'YOUSUB_RESUME_SEEK_TO',
      timeSec: 4500,
      allowResetToZero: false,
    });

    const cpBtn = document.querySelector('#resume-checkpoints-list .resume-pill');
    expect(cpBtn.textContent).toBe('30:00');
    cpBtn.click();
    await flushMicrotasks();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
      type: 'YOUSUB_RESUME_SEEK_TO',
      timeSec: 1800,
      allowResetToZero: false,
    });

    const bmJump = document.querySelector('.resume-bookmark-jump');
    expect(bmJump.textContent).toBe('25:00 Plot twist');
    bmJump.click();
    await flushMicrotasks();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
      type: 'YOUSUB_RESUME_SEEK_TO',
      timeSec: 1500,
      allowResetToZero: false,
    });

    document.getElementById('resume-add-bookmark-btn').click();
    await flushMicrotasks();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
      type: 'YOUSUB_RESUME_ADD_BOOKMARK',
      label: '',
    });
  });

  test('falls back to PlaybackResumeStore bookmark & removal when tab message fails', async () => {
    chrome.tabs.query.mockResolvedValue([
      { id: 77, url: 'https://www.youtube.com/watch?v=story_fb' },
    ]);
    chrome.tabs.sendMessage.mockRejectedValue(new Error('No content script'));

    controller = await PopupResumeView.init();

    document.getElementById('resume-add-bookmark-btn').click();
    await flushMicrotasks();

    let bmChips = document.querySelectorAll('#resume-bookmarks-list .resume-bookmark-chip');
    expect(bmChips.length).toBe(1);

    document.querySelector('#resume-bookmarks-list .resume-bookmark-del').click();
    await flushMicrotasks();

    bmChips = document.querySelectorAll('#resume-bookmarks-list .resume-bookmark-chip');
    expect(bmChips.length).toBe(0);
  });

  test('expands recent list, escapes titles, opens video tab, deletes item, and refreshes on storage change', async () => {
    await PlaybackResumeStore.updateProgress('rec_1', {
      title: '<img src=x onerror=alert(1)> Tale',
      currentTimeSec: 3600,
      durationSec: 7200,
      forceSyncFlush: true,
    });
    chrome.tabs.query.mockResolvedValue([{ id: 5, url: 'https://example.com' }]);

    controller = await PopupResumeView.init();
    const recentToggle = document.getElementById('resume-recent-toggle');
    const recentList = document.getElementById('resume-recent-list');

    expect(recentList.classList.contains('hidden')).toBe(true);
    recentToggle.click();
    expect(recentList.classList.contains('hidden')).toBe(false);
    expect(recentToggle.getAttribute('aria-expanded')).toBe('true');

    const titleEl = recentList.querySelector('.resume-recent-title');
    expect(titleEl.textContent).toBe('<img src=x onerror=alert(1)> Tale');
    expect(recentList.querySelector('img')).toBeNull();
    expect(recentList.querySelector('.resume-recent-meta').textContent).toBe('1:00:00 / 2:00:00');
    expect(recentList.querySelector('.resume-progress-fill').style.width).toBe('50%');

    recentList.querySelector('.resume-recent-main').click();
    await flushMicrotasks();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://www.youtube.com/watch?v=rec_1&t=3600s',
    });

    // External storage change arrives for another video + settings
    await PlaybackResumeStore.saveSettings({ enabled: false });
    await PlaybackResumeStore.updateProgress('rec_2', {
      title: 'Second Story',
      currentTimeSec: 120,
      durationSec: 600,
      forceSyncFlush: true,
    });
    for (const listener of chrome.storage.onChanged._listeners) {
      listener(
        {
          [RESUME_SETTINGS_KEY]: { newValue: { enabled: false } },
          [RESUME_STORAGE_KEY]: { newValue: {} },
          [RESUME_SYNC_KEY]: { newValue: {} },
        },
        'local'
      );
    }
    await flushMicrotasks();

    expect(document.getElementById('resume-auto-toggle').checked).toBe(false);
    expect(document.getElementById('resume-recent-count').textContent).toBe('2');

    // Delete first recent row
    recentList.querySelector('.resume-recent-del').click();
    await flushMicrotasks();
    expect(document.getElementById('resume-recent-count').textContent).toBe('1');

    // Delete remaining row -> empty state message shown
    recentList.querySelector('.resume-recent-del').click();
    await flushMicrotasks();
    expect(document.getElementById('resume-recent-count').textContent).toBe('0');
    expect(recentList.querySelector('.resume-empty').textContent).toBe(
      'No saved playback positions yet.'
    );
  });

  test('renders Sleep Timer presets, custom minutes, and Off controls on /watch (Phase 87)', async () => {
    chrome.tabs.query.mockResolvedValue([
      { id: 99, url: 'https://www.youtube.com/watch?v=sleepVid' },
    ]);
    chrome.tabs.sendMessage.mockImplementation(async (_tabId, msg) => {
      if (msg.type === 'YOUSUB_RESUME_GET_STATE') {
        return {
          videoId: 'sleepVid',
          title: 'Bedtime Audiobook',
          currentTimeSec: 120,
          durationSec: 7200,
          record: null,
          sleepTimer: { active: false, remainingSec: 0, totalSec: 0 },
        };
      }
      if (msg.type === 'YOUSUB_RESUME_SET_SLEEP_TIMER') {
        const mins = Number(msg.minutes);
        return {
          ok: true,
          sleepTimer:
            mins > 0
              ? {
                  active: true,
                  remainingSec: mins * 60,
                  totalSec: mins * 60,
                  endAt: Date.now() + mins * 60000,
                  isFading: false,
                }
              : { active: false, remainingSec: 0, totalSec: 0, endAt: 0, isFading: false },
        };
      }
      return null;
    });

    controller = await PopupResumeView.init();
    expect(document.getElementById('resume-active-panel').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('resume-sleep-badge').textContent).toBe('Off');

    // Click 15m preset
    const preset15 = document.querySelector('#resume-sleep-presets button[data-minutes="15"]');
    preset15.click();
    await flushMicrotasks();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(99, {
      type: 'YOUSUB_RESUME_SET_SLEEP_TIMER',
      minutes: 15,
    });
    expect(document.getElementById('resume-sleep-badge').textContent).toBe('15:00');
    expect(document.getElementById('resume-sleep-off-btn').classList.contains('hidden')).toBe(
      false
    );

    // Custom 42m
    const customInput = document.getElementById('resume-sleep-custom-min');
    customInput.value = '42';
    document.getElementById('resume-sleep-custom-btn').click();
    await flushMicrotasks();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(99, {
      type: 'YOUSUB_RESUME_SET_SLEEP_TIMER',
      minutes: 42,
    });
    expect(document.getElementById('resume-sleep-badge').textContent).toBe('42:00');

    // Off button cancels timer
    document.getElementById('resume-sleep-off-btn').click();
    await flushMicrotasks();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(99, {
      type: 'YOUSUB_RESUME_SET_SLEEP_TIMER',
      minutes: 0,
    });
    expect(document.getElementById('resume-sleep-badge').textContent).toBe('Off');
  });

  test('supports bookmark note input, inline bookmark rename, speed badge, and A-B Loop buttons (Phase 88)', async () => {
    chrome.tabs.query.mockResolvedValue([
      { id: 101, url: 'https://www.youtube.com/watch?v=abPop' },
    ]);
    await PlaybackResumeStore.addBookmark('abPop', {
      timeSec: 120,
      label: 'Old Note',
      durationSec: 1800,
    });

    chrome.tabs.sendMessage.mockImplementation(async (_tabId, msg) => {
      if (msg.type === 'YOUSUB_RESUME_GET_STATE') {
        const stored = await PlaybackResumeStore.getVideoRecord('abPop');
        return {
          videoId: 'abPop',
          title: 'Lecture',
          currentTimeSec: 180,
          durationSec: 1800,
          playbackRate: 1.5,
          record: stored.mergedRecord,
          abLoop: { active: false, pointA: null, pointB: null },
        };
      }
      if (msg.type === 'YOUSUB_RESUME_ADD_BOOKMARK') {
        await PlaybackResumeStore.addBookmark('abPop', { timeSec: 180, label: msg.label });
        return { ok: true };
      }
      if (msg.type === 'YOUSUB_RESUME_SET_AB_LOOP') {
        if (msg.action === 'setA')
          return { ok: true, abLoop: { active: false, pointA: 60, pointB: null } };
        if (msg.action === 'setB')
          return { ok: true, abLoop: { active: true, pointA: 60, pointB: 90 } };
        return { ok: true, abLoop: { active: false, pointA: null, pointB: null } };
      }
      return null;
    });

    controller = await PopupResumeView.init();
    expect(document.getElementById('resume-speed-badge').textContent).toBe('1.5x');
    expect(document.getElementById('resume-speed-badge').classList.contains('hidden')).toBe(false);

    // Inline edit existing bookmark label
    const editBtn = document.querySelector(
      '#resume-bookmarks-list button[aria-label*="Edit bookmark"]'
    );
    editBtn.click();
    const editInput = document.querySelector('.resume-bookmark-edit-input');
    editInput.value = 'Key Takeaway';
    editInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(document.querySelector('.resume-bookmark-jump').textContent).toBe('2:00 Key Takeaway');

    // Add bookmark with note input
    document.getElementById('resume-bookmark-note').value = 'Chapter 3';
    document.getElementById('resume-add-bookmark-btn').click();
    await flushMicrotasks();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(101, {
      type: 'YOUSUB_RESUME_ADD_BOOKMARK',
      label: 'Chapter 3',
    });

    // A-B Loop
    document.getElementById('resume-ab-set-a-btn').click();
    await flushMicrotasks();
    expect(document.getElementById('resume-ab-badge').textContent).toBe('A: 1:00');
    document.getElementById('resume-ab-set-b-btn').click();
    await flushMicrotasks();
    expect(document.getElementById('resume-ab-badge').textContent).toBe('1:00 - 1:30');
    document.getElementById('resume-ab-clear-btn').click();
    await flushMicrotasks();
    expect(document.getElementById('resume-ab-badge').textContent).toBe('Off');
  });
});
