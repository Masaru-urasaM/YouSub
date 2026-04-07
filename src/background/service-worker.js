/**
 * service-worker.js — YouSub Background Service Worker
 *
 * Handles two message types from content scripts:
 *  1. YOUSUB_FETCH_TEXT          — proxy fetch to bypass page-level CSP/CORS
 *  2. YOUSUB_TRANSLATE_REQUEST   — translate subtitle strings via Lingva API
 */

import '../shared/libs/browser-polyfill.js';
import { translate } from './translator.js';
import { Logger } from '../shared/logger.js';
import { Providers } from './providers.js';
import { Cache } from './cache.js';

Logger.info('ServiceWorker', 'Background Service Worker loaded.');

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener(function (request, sender, sendResponse) {

  // ------------------------------------------------------------------
  // YOUSUB_FETCH_TEXT — Proxy fetch for content script (Phase 6)
  // Uses credentials: 'include' to send YouTube cookies.
  // ------------------------------------------------------------------
  if (request.type === 'YOUSUB_FETCH_TEXT') {
    var shortUrl = request.url.substring(0, 100) + '...';
    Logger.info('ServiceWorker', `Fetching URL: ${shortUrl}`);

    fetch(request.url, { credentials: 'include' })
      .then(function (response) {
        Logger.info('ServiceWorker', `HTTP ${response.status} ${response.statusText} for: ${shortUrl}`);
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' ' + response.statusText);
        }
        return response.text();
      })
      .then(function (text) {
        Logger.info('ServiceWorker', `Fetch success. Body length: ${text.length} chars`);
        if (text.length === 0) {
          Logger.warn('ServiceWorker', 'WARNING — Response body is EMPTY (0 bytes)');
        }
        sendResponse({ success: true, text: text });
      })
      .catch(function (error) {
        Logger.error('ServiceWorker', `Fetch FAILED: ${error.message}`);
        sendResponse({ success: false, error: error.message });
      });

    return true; // Keep channel open for async response
  }

  // ------------------------------------------------------------------
  // YOUSUB_TRANSLATE_REQUEST — Translate subtitle strings (Phase 7)
  // ------------------------------------------------------------------
  if (request.type === 'YOUSUB_TRANSLATE_REQUEST') {
    const { texts, videoId, sourceLang, targetLang } = request;
    Logger.info('ServiceWorker', `Translate request — ${texts && texts.length} entries`);

    // 1. Check Cache
    Cache.get(videoId, sourceLang, targetLang).then(cached => {
      if (cached) {
        Logger.info('ServiceWorker', `Cache HIT for ${videoId}, skipped API call.`);
        sendResponse({ success: true, translated: cached });
        return;
      }

      // 2. Cache MISS — Call API
      Logger.info('ServiceWorker', `Cache MISS for ${videoId}, calling translator...`);
      translate(texts, sourceLang, targetLang, sender.tab.id, (startIndex, translatedBatch) => {
        // Phase 35: Push partial result back to content script
        browser.tabs.sendMessage(sender.tab.id, {
          type: 'YOUSUB_TRANSLATE_PARTIAL',
          videoId: videoId,
          startIndex: startIndex,
          translated: translatedBatch
        }).catch(() => {
          // Tab might be closed, ignore
        });
      })
        .then(function (result) {
          const { translated, hadFallback } = result;
          Logger.info('ServiceWorker', `Translation complete — returning ${translated.length} entries (hadFallback: ${hadFallback})`);

          // 3. Only cache if translation was fully successful (no fallback to originals)
          if (!hadFallback) {
            Cache.set(videoId, sourceLang, targetLang, translated);
          } else {
            Logger.warn('ServiceWorker', `Skipping cache for ${videoId} — translation had fallback batches.`);
          }

          sendResponse({ success: true, translated: translated, hadFallback: !!hadFallback });
        })
        .catch(function (error) {
          Logger.error('ServiceWorker', `Translation error: ${error.stack}`);
          sendResponse({ success: false, error: error.stack });
        });
    });

    return true; // Keep channel open for async response
  }

  // ------------------------------------------------------------------
  if (request.type === 'YOUSUB_CLEAR_CACHE') {
    Cache.clearAll()
      .then((count) => sendResponse({ success: true, count }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ------------------------------------------------------------------
  // YOUSUB_CLEAR_VIDEO_CACHE — Clear cache for specific video (Phase 31)
  // ------------------------------------------------------------------
  if (request.type === 'YOUSUB_CLEAR_VIDEO_CACHE') {
    Cache.removeByVideoId(request.videoId)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ------------------------------------------------------------------
  // YOUSUB_CHECK_CACHE — Check if video has signature (Phase 30)
  // ------------------------------------------------------------------
  if (request.type === 'YOUSUB_CHECK_CACHE') {
    const { videoId, sourceLang, targetLang } = request;
    Cache.get(videoId, sourceLang || 'auto', targetLang)
      .then(cached => sendResponse({ exists: !!cached }))
      .catch(() => sendResponse({ exists: false }));
    return true;
  }

  // ------------------------------------------------------------------
  // YOUSUB_TEST_API_KEY — Verify if API key config works (Phase 13.7)
  // ------------------------------------------------------------------
  if (request.type === 'YOUSUB_TEST_API_KEY') {
    const { provider, model, apiKey } = request;

    Providers.testApiKey(provider, model, apiKey)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, message: err.message, model }));

    return true; // Keep channel open for async response
  }

  // ------------------------------------------------------------------
  // YOUSUB_OPEN_SETTINGS — Open extension options page (Phase 33)
  // ------------------------------------------------------------------
  if (request.type === 'YOUSUB_OPEN_SETTINGS') {
    browser.runtime.openOptionsPage();
    sendResponse({ success: true });
    return true;
  }
});
