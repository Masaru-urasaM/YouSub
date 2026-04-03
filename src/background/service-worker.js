/**
 * service-worker.js — YouSub Background Service Worker
 *
 * Handles two message types from content scripts:
 *  1. YOUSUB_FETCH_TEXT          — proxy fetch to bypass page-level CSP/CORS
 *  2. YOUSUB_TRANSLATE_REQUEST   — translate subtitle strings via Lingva API
 */

import { translate } from './translator.js';

console.log('[YouSub] Background Service Worker loaded.');

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {

  // ------------------------------------------------------------------
  // YOUSUB_FETCH_TEXT — Proxy fetch for content script (Phase 6)
  // Uses credentials: 'include' to send YouTube cookies.
  // ------------------------------------------------------------------
  if (request.action === 'YOUSUB_FETCH_TEXT') {
    var shortUrl = request.url.substring(0, 100) + '...';
    console.log('[YouSub] BG: Fetching URL:', shortUrl);

    fetch(request.url, { credentials: 'include' })
      .then(function (response) {
        console.log('[YouSub] BG: HTTP', response.status, response.statusText, 'for:', shortUrl);
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' ' + response.statusText);
        }
        return response.text();
      })
      .then(function (text) {
        console.log('[YouSub] BG: Fetch success. Body length:', text.length, 'chars');
        if (text.length === 0) {
          console.warn('[YouSub] BG: WARNING — Response body is EMPTY (0 bytes)');
        }
        sendResponse({ success: true, text: text });
      })
      .catch(function (error) {
        console.error('[YouSub] BG: Fetch FAILED:', error.message);
        sendResponse({ success: false, error: error.message });
      });

    return true; // Keep channel open for async response
  }

  // ------------------------------------------------------------------
  // YOUSUB_TRANSLATE_REQUEST — Translate subtitle strings (Phase 7)
  // ------------------------------------------------------------------
  if (request.action === 'YOUSUB_TRANSLATE_REQUEST') {
    var texts = request.texts;
    var sourceLang = request.sourceLang;
    var targetLang = request.targetLang;
    console.log('[YouSub] BG: Translate request —', texts && texts.length, 'entries');

    translate(texts, sourceLang, targetLang)
      .then(function (translated) {
        sendResponse({ success: true, translated: translated });
      })
      .catch(function (error) {
        console.error('[YouSub] BG: Translation error:', error.message);
        sendResponse({ success: false, error: error.message });
      });

    return true; // Keep channel open for async response
  }
});
