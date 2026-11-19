import '../shared/libs/browser-polyfill.js';

export const Constants = {
  APP_NAME: 'YouSub',
  VERSION: '0.2.5',
  IS_PRODUCTION: false, // Auto-switched to true during packaging
  BUILD_DATE: null, // Injected during packaging
  BUILD_HASH: null, // Injected during packaging (git short hash)
  DEFAULT_TARGET_LANG: 'vi',
  DEFAULT_SOURCE_LANG: 'auto',
};

export const RESUME_STORAGE_KEY = 'yousub_playback_resume_v1';
export const RESUME_SYNC_KEY = 'yousub_resume_sync_v1';
export const RESUME_SETTINGS_KEY = 'yousub_resume_settings';
export const DEFAULT_RESUME_SETTINGS = Object.freeze({
  enabled: true,
  rewindSec: 3,
  minDurationSec: 60,
  syncEnabled: true,
  preventCompletionReset: true,
});

// Message types for chrome.runtime.sendMessage between content ↔ background
export const MSG = {
  TRANSLATE_REQUEST: 'YOUSUB_TRANSLATE_REQUEST',
  TRANSLATE_RESPONSE: 'YOUSUB_TRANSLATE_RESPONSE',
  TEST_API_KEY: 'YOUSUB_TEST_API_KEY',
  TEST_RESULT: 'YOUSUB_TEST_RESULT',
  API_KEYS_UPDATED: 'YOUSUB_API_KEYS_UPDATED',
};

export function devLog(...args) {
  if (!Constants.IS_PRODUCTION) console.log(...args);
}

export function devWarn(...args) {
  if (!Constants.IS_PRODUCTION) console.warn(...args);
}

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.Constants = Constants;
  window.YouSub.MSG = MSG;
  window.YouSub.devLog = devLog;
  window.YouSub.devWarn = devWarn;
}
