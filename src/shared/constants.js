(function () {
  'use strict';
  const YS = window.YouSub || (window.YouSub = {});

  YS.Constants = {
    APP_NAME: 'YouSub',
    VERSION: '0.1.0',
    DEFAULT_TARGET_LANG: 'vi',   // Default translation target language
    DEFAULT_SOURCE_LANG: 'auto'  // Auto-detect source language
  };

  // Message types for chrome.runtime.sendMessage between content ↔ background
  YS.MSG = {
    TRANSLATE_REQUEST:  'YOUSUB_TRANSLATE_REQUEST',
    TRANSLATE_RESPONSE: 'YOUSUB_TRANSLATE_RESPONSE',
    TEST_API_KEY:       'YOUSUB_TEST_API_KEY',
    TEST_RESULT:        'YOUSUB_TEST_RESULT',
    API_KEYS_UPDATED:   'YOUSUB_API_KEYS_UPDATED'
  };

  console.log('[YouSub] Constants module loaded');
})();
