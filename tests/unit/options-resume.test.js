import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TextEncoder } from 'util';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPTIONS_HTML = fs.readFileSync(
  path.resolve(__dirname, '../../src/options/options.html'),
  'utf8'
);

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

const { RESUME_STORAGE_KEY, RESUME_SYNC_KEY, RESUME_SETTINGS_KEY, DEFAULT_RESUME_SETTINGS } =
  await import('../../src/shared/constants.js');
const { PlaybackResumeStore } = await import('../../src/shared/playback-resume-store.js');
const { initResumeTab } = await import('../../src/options/tab-resume.js');

function mountOptionsDom() {
  const parsed = new DOMParser().parseFromString(OPTIONS_HTML, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('tab-resume.js & Options Playback Tab (Phase 85)', () => {
  let controller = null;
  let saveIndicator;

  beforeEach(() => {
    chrome.storage.local.store = {};
    chrome.storage.sync.store = {};
    chrome.storage.onChanged._listeners = [];
    PlaybackResumeStore._resetInternalForTests();
    jest.clearAllMocks();
    saveIndicator = jest.fn();
    mountOptionsDom();
  });

  afterEach(() => {
    if (controller && typeof controller.destroy === 'function') {
      controller.destroy();
      controller = null;
    }
    PlaybackResumeStore._resetInternalForTests();
  });

  test('renders 4 options tabs with Playback between Appearance and About', () => {
    const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
    expect(tabButtons.map((btn) => btn.getAttribute('data-target'))).toEqual([
      'tab-translation',
      'tab-appearance',
      'tab-resume',
      'tab-about',
    ]);
    const resumeTab = document.getElementById('tab-resume-tab');
    const resumePanel = document.getElementById('tab-resume');
    expect(resumeTab.getAttribute('aria-controls')).toBe('tab-resume');
    expect(resumePanel.getAttribute('aria-labelledby')).toBe('tab-resume-tab');
  });

  test('loads defaults and custom saved resume settings into UI', async () => {
    controller = await initResumeTab(saveIndicator);
    expect(document.getElementById('resume-enabled').checked).toBe(DEFAULT_RESUME_SETTINGS.enabled);
    expect(document.getElementById('resume-sync-enabled').checked).toBe(
      DEFAULT_RESUME_SETTINGS.syncEnabled
    );
    expect(document.getElementById('resume-prevent-reset').checked).toBe(
      DEFAULT_RESUME_SETTINGS.preventCompletionReset
    );
    expect(document.getElementById('resume-rewind-sec').value).toBe(
      String(DEFAULT_RESUME_SETTINGS.rewindSec)
    );
    expect(document.getElementById('resume-min-duration').value).toBe(
      String(DEFAULT_RESUME_SETTINGS.minDurationSec)
    );
    controller.destroy();

    await PlaybackResumeStore.saveSettings({
      enabled: false,
      syncEnabled: false,
      preventCompletionReset: false,
      rewindSec: 5,
      minDurationSec: 300,
    });

    controller = await initResumeTab(saveIndicator);
    expect(document.getElementById('resume-enabled').checked).toBe(false);
    expect(document.getElementById('resume-sync-enabled').checked).toBe(false);
    expect(document.getElementById('resume-prevent-reset').checked).toBe(false);
    expect(document.getElementById('resume-rewind-sec').value).toBe('5');
    expect(document.getElementById('resume-min-duration').value).toBe('300');
  });

  test('persists every toggle and select change and invokes saveIndicator', async () => {
    controller = await initResumeTab(saveIndicator);

    const enabledEl = document.getElementById('resume-enabled');
    enabledEl.checked = false;
    enabledEl.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    const syncEl = document.getElementById('resume-sync-enabled');
    syncEl.checked = false;
    syncEl.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    const preventEl = document.getElementById('resume-prevent-reset');
    preventEl.checked = false;
    preventEl.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    const rewindEl = document.getElementById('resume-rewind-sec');
    rewindEl.value = '10';
    rewindEl.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    const minDurEl = document.getElementById('resume-min-duration');
    minDurEl.value = '600';
    minDurEl.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    expect(saveIndicator).toHaveBeenCalledTimes(5);
    const saved = await PlaybackResumeStore.getSettings();
    expect(saved).toEqual({
      enabled: false,
      syncEnabled: false,
      preventCompletionReset: false,
      rewindSec: 10,
      minDurationSec: 600,
    });
  });

  test('Clear Playback History opens confirm modal; cancel preserves data and confirm wipes local + sync', async () => {
    await PlaybackResumeStore.updateProgress('v_clear_1', {
      title: 'Story 1',
      currentTimeSec: 1200,
      durationSec: 3600,
      forceSyncFlush: true,
    });

    controller = await initResumeTab(saveIndicator);

    const clearBtn = document.getElementById('clear-resume-history-btn');
    const modal = document.getElementById('confirm-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalMsg = document.getElementById('modal-message');

    // Open and cancel
    clearBtn.click();
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(modalTitle.textContent).toBe('Clear Playback History');
    expect(modalMsg.textContent).toContain('timestamps, checkpoints, and bookmarks');

    document.getElementById('modal-cancel-btn').click();
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(chrome.storage.local.store[RESUME_STORAGE_KEY].v_clear_1).toBeDefined();

    // Open again and confirm
    clearBtn.click();
    document.getElementById('modal-confirm-btn').click();
    await flushMicrotasks();

    expect(modal.classList.contains('hidden')).toBe(true);
    expect(chrome.storage.local.store[RESUME_STORAGE_KEY]).toBeUndefined();
    expect(chrome.storage.sync.store[RESUME_SYNC_KEY]).toBeUndefined();
    expect(saveIndicator).toHaveBeenCalled();
  });

  test('reloads form when storage.onChanged fires for RESUME_SETTINGS_KEY', async () => {
    controller = await initResumeTab(saveIndicator);
    await PlaybackResumeStore.saveSettings({ rewindSec: 10, enabled: false });

    for (const listener of chrome.storage.onChanged._listeners) {
      listener({ [RESUME_SETTINGS_KEY]: { newValue: { rewindSec: 10, enabled: false } } }, 'local');
    }
    await flushMicrotasks();

    expect(document.getElementById('resume-enabled').checked).toBe(false);
    expect(document.getElementById('resume-rewind-sec').value).toBe('10');
  });
});
