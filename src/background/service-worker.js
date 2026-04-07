/**
 * service-worker.js — YouSub Background Service Worker
 *
 * Central router for all background operations:
 * 1. Translation requests (with caching)
 * 2. Proxy fetching for subtitle tracks
 * 3. Cache management (clear, check, remove)
 * 4. API Key testing
 */

import '../shared/libs/browser-polyfill.js';
import { translate } from './translator.js';
import { Logger } from '../shared/logger.js';
import { Providers } from './providers.js';
import { Cache } from './cache.js';

Logger.info('ServiceWorker', 'Background Service Worker loaded.');

// ---------------------------------------------------------------------------
// Message Router
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  // Logger.info('ServiceWorker', `Received message: ${request.type}`);

  try {
    // 1. YOUSUB_TRANSLATE_REQUEST — Translate subtitle segments
    if (request.type === 'YOUSUB_TRANSLATE_REQUEST') {
      const { texts, videoId, sourceLang, targetLang } = request;
      const tabId = sender.tab ? sender.tab.id : null;

      // Check Cache first
      Cache.get(videoId, sourceLang || 'auto', targetLang).then(cached => {
        if (cached) {
          Logger.info('ServiceWorker', `Cache HIT for ${videoId}. Skipping API.`);
          sendResponse({ success: true, translated: cached, fromCache: true });
          return;
        }

        // Cache MISS — Call translator
        Logger.info('ServiceWorker', `Cache MISS for ${videoId}. Calling translator...`);
        translate(texts, sourceLang, targetLang, tabId)
          .then(result => {
            // Only cache if fully successful (no fallback originals)
            if (result.success && !result.hadFallback) {
              Cache.set(videoId, sourceLang || 'auto', targetLang, result.translated);
            }
            sendResponse(result);
          })
          .catch(err => {
            Logger.error('ServiceWorker', `Translation CRASH: ${err.message}`);
            sendResponse({ success: false, failureReason: 'INTERNAL_ERROR', error: err.message });
          });
      }).catch(err => {
        sendResponse({ success: false, failureReason: 'CACHE_ERROR', error: err.message });
      });

      return true; // Keep channel open
    }

    // 2. YOUSUB_FETCH_TEXT — Proxy fetch to bypass CSP/CORS
    if (request.type === 'YOUSUB_FETCH_TEXT') {
      fetch(request.url, { credentials: 'include' })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then(text => sendResponse({ success: true, text }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 3. YOUSUB_CHECK_CACHE — Fast check if translation exists
    if (request.type === 'YOUSUB_CHECK_CACHE') {
      Cache.get(request.videoId, request.sourceLang || 'auto', request.targetLang)
        .then(cached => sendResponse({ exists: !!cached }))
        .catch(() => sendResponse({ exists: false }));
      return true;
    }

    // 4. YOUSUB_CLEAR_VIDEO_CACHE — Reset cache for one video
    if (request.type === 'YOUSUB_CLEAR_VIDEO_CACHE') {
      Cache.removeByVideoId(request.videoId)
        .then(() => {
          broadcastToTabs({ type: 'YOUSUB_CACHE_CLEARED', videoId: request.videoId });
          sendResponse({ success: true });
        })
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 5. YOUSUB_CLEAR_CACHE — Reset ALL cache
    if (request.type === 'YOUSUB_CLEAR_CACHE') {
      Cache.clearAll()
        .then(count => {
          broadcastToTabs({ type: 'YOUSUB_CACHE_CLEARED' });
          sendResponse({ success: true, count });
        })
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 6. YOUSUB_TEST_API_KEY — Test key in settings
    if (request.type === 'YOUSUB_TEST_API_KEY') {
      Providers.testApiKey(request.provider, request.model, request.apiKey)
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, message: err.message }));
      return true;
    }

    // 7. YOUSUB_OPEN_SETTINGS
    if (request.type === 'YOUSUB_OPEN_SETTINGS') {
      browser.runtime.openOptionsPage();
      sendResponse({ success: true });
      return true;
    }

  } catch (err) {
    Logger.error('ServiceWorker', `Fatal Listener Error: ${err.message}`);
    sendResponse({ success: false, failureReason: 'BACKGROUND_CRASH', error: err.message });
  }

  return false;
});

/**
 * Helper: Send message to all tabs
 */
function broadcastToTabs(msg) {
  browser.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      browser.tabs.sendMessage(tab.id, msg).catch(() => {});
    });
  });
}
