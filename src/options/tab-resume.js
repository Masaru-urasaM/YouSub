import '../shared/libs/browser-polyfill.js';
import { DEFAULT_RESUME_SETTINGS, RESUME_SETTINGS_KEY } from '../shared/constants.js';
import { PlaybackResumeStore } from '../shared/playback-resume-store.js';
import { Logger } from '../shared/logger.js';
import { showConfirmModal } from './options-modal.js';

function resolveMsg(i18nFn, key, fallback) {
  if (typeof i18nFn === 'function') {
    const val = i18nFn(key, fallback);
    if (val) return val;
  }
  try {
    if (typeof browser !== 'undefined' && browser.i18n?.getMessage) {
      return browser.i18n.getMessage(key) || fallback;
    }
  } catch {
    // Ignore outside extension runtime
  }
  return fallback;
}

function applySelectValue(selectEl, numValue, defaultVal) {
  if (!selectEl) return;
  const target = String(Number.isFinite(Number(numValue)) ? Number(numValue) : defaultVal);
  const hasOption = Array.from(selectEl.options || []).some((opt) => opt.value === target);
  selectEl.value = hasOption ? target : String(defaultVal);
}

/**
 * Initialize the Playback Resume & Sync tab inside options.html.
 * @param {() => void} saveIndicatorCallback
 * @param {(key: string, fallback?: string) => string} [i18nFn]
 */
export async function initResumeTab(saveIndicatorCallback, i18nFn) {
  const enabledInput = document.getElementById('resume-enabled');
  const syncInput = document.getElementById('resume-sync-enabled');
  const preventResetInput = document.getElementById('resume-prevent-reset');
  const rememberSpeedInput = document.getElementById('resume-remember-speed');
  const rewindSelect = document.getElementById('resume-rewind-sec');
  const minDurationSelect = document.getElementById('resume-min-duration');
  const clearHistoryBtn = document.getElementById('clear-resume-history-btn');

  if (!enabledInput && !syncInput && !preventResetInput && !rewindSelect && !minDurationSelect) {
    return null;
  }

  const modalEls = {
    confirmModal: document.getElementById('confirm-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalMessage: document.getElementById('modal-message'),
    modalCancelBtn: document.getElementById('modal-cancel-btn'),
    modalConfirmBtn: document.getElementById('modal-confirm-btn'),
  };

  async function loadSettingsIntoForm() {
    const settings = await PlaybackResumeStore.getSettings();
    if (enabledInput) enabledInput.checked = settings.enabled !== false;
    if (syncInput) syncInput.checked = settings.syncEnabled !== false;
    if (preventResetInput) preventResetInput.checked = settings.preventCompletionReset !== false;
    if (rememberSpeedInput) rememberSpeedInput.checked = settings.rememberPlaybackSpeed !== false;
    applySelectValue(rewindSelect, settings.rewindSec, DEFAULT_RESUME_SETTINGS.rewindSec);
    applySelectValue(
      minDurationSelect,
      settings.minDurationSec,
      DEFAULT_RESUME_SETTINGS.minDurationSec
    );
    return settings;
  }

  async function savePatch(patch) {
    try {
      await PlaybackResumeStore.saveSettings(patch);
      if (typeof saveIndicatorCallback === 'function') {
        saveIndicatorCallback();
      }
    } catch (err) {
      Logger.warn('OptionsResume', 'Failed to save resume settings', { error: err?.message });
    }
  }

  await loadSettingsIntoForm();

  if (enabledInput) {
    enabledInput.addEventListener('change', () => {
      savePatch({ enabled: Boolean(enabledInput.checked) });
    });
  }

  if (syncInput) {
    syncInput.addEventListener('change', () => {
      savePatch({ syncEnabled: Boolean(syncInput.checked) });
    });
  }

  if (preventResetInput) {
    preventResetInput.addEventListener('change', () => {
      savePatch({ preventCompletionReset: Boolean(preventResetInput.checked) });
    });
  }

  if (rememberSpeedInput) {
    rememberSpeedInput.addEventListener('change', () => {
      savePatch({ rememberPlaybackSpeed: Boolean(rememberSpeedInput.checked) });
    });
  }

  if (rewindSelect) {
    rewindSelect.addEventListener('change', () => {
      const val = Number(rewindSelect.value);
      savePatch({
        rewindSec: Number.isFinite(val) && val >= 0 ? val : DEFAULT_RESUME_SETTINGS.rewindSec,
      });
    });
  }

  if (minDurationSelect) {
    minDurationSelect.addEventListener('change', () => {
      const val = Number(minDurationSelect.value);
      savePatch({
        minDurationSec:
          Number.isFinite(val) && val >= 0 ? val : DEFAULT_RESUME_SETTINGS.minDurationSec,
      });
    });
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      const title = resolveMsg(i18nFn, 'optionsResumeClearConfirmTitle', 'Clear Playback History');
      const message = resolveMsg(
        i18nFn,
        'optionsResumeClearConfirmMsg',
        'Delete all saved playback timestamps, checkpoints, and bookmarks across local and synced storage?'
      );
      showConfirmModal(modalEls, title, message, async () => {
        await PlaybackResumeStore.clearAllRecords();
        Logger.info('OptionsResume', 'Cleared all playback resume history');
        if (typeof saveIndicatorCallback === 'function') {
          saveIndicatorCallback();
        }
      });
    });
  }

  const onStorageChanged = (changes, area) => {
    if (area === 'local' && changes && RESUME_SETTINGS_KEY in changes) {
      loadSettingsIntoForm().catch(() => {});
    }
  };

  if (browser.storage?.onChanged?.addListener) {
    browser.storage.onChanged.addListener(onStorageChanged);
  }

  return {
    reload: loadSettingsIntoForm,
    destroy() {
      if (browser.storage?.onChanged?.removeListener) {
        try {
          browser.storage.onChanged.removeListener(onStorageChanged);
        } catch {
          // Ignore
        }
      }
    },
  };
}
