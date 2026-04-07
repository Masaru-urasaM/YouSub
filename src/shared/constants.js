import '../shared/libs/browser-polyfill.js';

export const Constants = {
  APP_NAME: 'YouSub',
  VERSION: '0.1.0',
  IS_PRODUCTION: false,        // Auto-switched to true during packaging
  DEFAULT_TARGET_LANG: 'vi',   // Default translation target language
  DEFAULT_SOURCE_LANG: 'auto'  // Auto-detect source language
};

// Message types for chrome.runtime.sendMessage between content ↔ background
export const MSG = {
  TRANSLATE_REQUEST:  'YOUSUB_TRANSLATE_REQUEST',
  TRANSLATE_RESPONSE: 'YOUSUB_TRANSLATE_RESPONSE',
  TEST_API_KEY:       'YOUSUB_TEST_API_KEY',
  TEST_RESULT:        'YOUSUB_TEST_RESULT',
  API_KEYS_UPDATED:   'YOUSUB_API_KEYS_UPDATED'
};

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.Constants = Constants;
  window.YouSub.MSG = MSG;
}

console.log('[YouSub] Constants module loaded (ESM)');
