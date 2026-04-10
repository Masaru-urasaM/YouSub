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
import { HealthManager } from './health.js';

Logger.info('ServiceWorker', 'Background Service Worker loaded.');

// ---------------------------------------------------------------------------
// Message Router
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  Logger.debug('ServiceWorker', `Received message: ${request.type}`);

  // Route to specific handlers
  handleRequest(request, sender)
    .then(response => {
      sendResponse(response);
    })
    .catch(err => {
      Logger.error('ServiceWorker', `Router Error: ${err.message}`);
      sendResponse({ success: false, failureReason: 'BACKGROUND_CRASH', error: err.message });
    });

  return true; // Keep channel open for async response
});

/**
 * Central handler for all requests to ensure async consistency
 */
async function handleRequest(request, sender) {
  try {
    // 1. YOUSUB_TRANSLATE_REQUEST
    if (request.type === 'YOUSUB_TRANSLATE_REQUEST') {
      const { segments, videoId, sourceLang, targetLang } = request;
      const tabId = sender.tab ? sender.tab.id : null;

      Logger.info('ServiceWorker', `Incoming translation request for ${videoId} (${segments.length} segments)`);

      const cached = await Cache.get(videoId, sourceLang || 'auto', targetLang);
      if (cached) {
        Logger.info('ServiceWorker', `Cache HIT for ${videoId}`);
        const cacheStats = { source: 'cache', timestamp: Date.now() };
        await browser.storage.local.set({ [`yousub_stats_${videoId}`]: cacheStats });
        return { success: true, translated: cached, fromCache: true };
      }

      Logger.info('ServiceWorker', `Cache MISS for ${videoId}. Starting translation pipeline...`);
      await browser.storage.local.remove([`yousub_stats_${videoId}`]);

      const result = await translate(segments, sourceLang, targetLang, tabId);
      if (result.success && !result.hadFallback) {
        await Cache.set(videoId, sourceLang || 'auto', targetLang, result.translated);
      }

      if (result.success) {
        const stats = {
          source: 'api',
          model: result.stats?.model || 'unknown',
          totalTokens: result.stats?.totalTokens || 0,
          promptTokens: result.stats?.promptTokens || 0,
          completionTokens: result.stats?.completionTokens || 0,
          durationMs: result.stats?.durationMs || 0,
          batchCount: result.stats?.batchCount || 0,
          timestamp: Date.now()
        };
        await browser.storage.local.set({ [`yousub_stats_${videoId}`]: stats });
      }
      return result;
    }

    // 2. YOUSUB_FETCH_TEXT
    if (request.type === 'YOUSUB_FETCH_TEXT') {
      const res = await fetch(request.url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return { success: true, text };
    }

    // 3. YOUSUB_CHECK_CACHE
    if (request.type === 'YOUSUB_CHECK_CACHE') {
      const cached = await Cache.get(request.videoId, request.sourceLang || 'auto', request.targetLang);
      return { exists: !!cached };
    }

    // 4. YOUSUB_CLEAR_VIDEO_CACHE
    if (request.type === 'YOUSUB_CLEAR_VIDEO_CACHE') {
      await Cache.removeByVideoId(request.videoId);
      broadcastToTabs({ type: 'YOUSUB_CACHE_CLEARED', videoId: request.videoId });
      return { success: true };
    }

    // 5. YOUSUB_CLEAR_CACHE
    if (request.type === 'YOUSUB_CLEAR_CACHE') {
      const count = await Cache.clearAll();
      broadcastToTabs({ type: 'YOUSUB_CACHE_CLEARED' });
      return { success: true, count };
    }

    // 6. YOUSUB_TEST_API_KEY
    if (request.type === 'YOUSUB_TEST_API_KEY') {
      return await Providers.testApiKey(request.provider, request.model, request.apiKey);
    }

    // 7. YOUSUB_OPEN_SETTINGS
    if (request.type === 'YOUSUB_OPEN_SETTINGS') {
      browser.runtime.openOptionsPage();
      return { success: true };
    }

    // 8. YOUSUB_GET_HEALTH_SUMMARY
    if (request.type === 'YOUSUB_GET_HEALTH_SUMMARY') {
      const resSet = await browser.storage.local.get(['yousub_api_keys']);
      const summary = await HealthManager.getSummary(resSet.yousub_api_keys || []);
      return { success: true, summary };
    }

    return { success: false, failureReason: 'INVALID_REQUEST_TYPE' };
  } catch (err) {
    throw err; // Caught by the listener wrapper
  }
}

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
