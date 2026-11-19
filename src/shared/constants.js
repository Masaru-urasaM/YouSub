import '../shared/libs/browser-polyfill.js';

export const Constants = {
  APP_NAME: 'YouSub',
  VERSION: '0.2.6',
  IS_PRODUCTION: false, // Auto-switched to true during packaging
  BUILD_DATE: null, // Injected during packaging
  BUILD_HASH: null, // Injected during packaging (git short hash)
  DEFAULT_TARGET_LANG: 'vi',
  DEFAULT_SOURCE_LANG: 'auto',
};

export const RESUME_STORAGE_KEY = 'yousub_playback_resume_v1';
export const RESUME_SYNC_KEY = 'yousub_resume_sync_v1';
export const RESUME_SETTINGS_KEY = 'yousub_resume_settings';
export const RESUME_CHANNEL_SPEEDS_KEY = 'yousub_channel_speeds_v1';
export const TRANSLATION_ACTIVATION_KEY = 'yousub_activation_mode';
export const SKIP_MUSIC_VIDEOS_KEY = 'yousub_skip_music_videos';
export const TRANSLATION_STYLE_KEY = 'yousub_translation_style';
export const CUSTOM_PROMPT_KEY = 'yousub_custom_prompt';
export const CUSTOM_GLOSSARY_KEY = 'yousub_custom_glossary';
export const USAGE_STATS_KEY = 'yousub_usage_stats_v1';
export const ONBOARDING_DISMISSED_KEY = 'yousub_onboarding_dismissed';
export const DEFAULT_RESUME_SETTINGS = Object.freeze({
  enabled: true,
  rewindSec: 3,
  minDurationSec: 60,
  syncEnabled: true,
  preventCompletionReset: true,
  rememberPlaybackSpeed: true,
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
