/**
 * main-world-fetcher.js — Runs in the MAIN world (YouTube page context)
 *
 * Uses XMLHttpRequest instead of fetch() because YouTube's own Service Worker
 * (PWA) can intercept fetch() calls and return empty/cached responses.
 * XHR is NOT intercepted by Service Workers, so it goes directly to the network.
 *
 * Listens for YOUSUB_FETCH_REQUEST messages from the content script,
 * fetches the URL, and sends the result back via YOUSUB_FETCH_RESPONSE.
 */
(function () {
  'use strict';

  try {
    // Phase 50.6: Trusted Types Bypass
    var policy = null;
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      try {
        policy = window.trustedTypes.createPolicy('yousub-fetcher-policy', {
          createHTML: function(html) { return html; },
          createScript: function(s) { return s; },
          createScriptURL: function(u) { return u; }
        });
      } catch (e) {}
    }

    window.addEventListener('message', function (event) {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'YOUSUB_FETCH_REQUEST') return;

      var requestId = event.data.requestId;
      var url = event.data.url;

      console.log('[YouSub] MainWorldFetcher: Fetching URL:', url.substring(0, 120) + '...');

      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.withCredentials = true;
      xhr.timeout = 15000;

      // Phase 50.5/6: Add YouTube-specific headers
      xhr.setRequestHeader('X-YouTube-Client-Name', '1');
      xhr.setRequestHeader('X-YouTube-Client-Version', '2.20240321.01.00');

      xhr.onload = function () {
        console.log('[YouSub] MainWorldFetcher: XHR status:', xhr.status, 'length:', xhr.responseText.length);
        if (xhr.status >= 200 && xhr.status < 300) {
          window.postMessage({
            type: 'YOUSUB_FETCH_RESPONSE',
            requestId: requestId,
            success: true,
            text: xhr.responseText
          }, '*');
        } else {
          window.postMessage({
            type: 'YOUSUB_FETCH_RESPONSE',
            requestId: requestId,
            success: false,
            error: 'HTTP ' + xhr.status + ' ' + xhr.statusText
          }, '*');
        }
      };

      xhr.onerror = function () {
        console.error('[YouSub] MainWorldFetcher: XHR network error');
        window.postMessage({
          type: 'YOUSUB_FETCH_RESPONSE',
          requestId: requestId,
          success: false,
          error: 'Network error'
        }, '*');
      };

      xhr.ontimeout = function () {
        console.error('[YouSub] MainWorldFetcher: XHR timed out');
        window.postMessage({
          type: 'YOUSUB_FETCH_RESPONSE',
          requestId: requestId,
          success: false,
          error: 'Request timed out'
        }, '*');
      };

      xhr.send();
    });

    console.log('[YouSub] MainWorldFetcher: Ready (XHR mode).');
  } catch (e) {
    console.error('[YouSub] MainWorldFetcher Critical Crash:', e);
  }
})();
