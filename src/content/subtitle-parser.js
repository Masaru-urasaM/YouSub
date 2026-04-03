(function () {
  'use strict';
  var YouSub = window.YouSub || (window.YouSub = {});

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  var fetcherInjected = false;
  var pendingFetches = {};      // requestId → { resolve, reject }
  var fetchIdCounter = 0;

  /**
   * Sort array of subtitle segments by start time.
   */
  function sortTracks(tracks) {
    return tracks.sort(function (a, b) {
      return a.startMs - b.startMs;
    });
  }

  /**
   * Decode basic HTML entities that might appear in older XML/JSON responses.
   */
  function decodeHtml(html) {
    var txt = document.createElement('textarea');
    txt.innerHTML = html;
    return txt.value;
  }

  /**
   * Inject the main-world-fetcher.js script into the page if not already done.
   * This script runs in the YouTube page context (same-origin, with cookies).
   */
  function ensureFetcherInjected() {
    if (fetcherInjected) return;
    fetcherInjected = true;

    var script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/content/main-world-fetcher.js');
    script.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(script);

    // Listen for fetch responses from main world
    window.addEventListener('message', function (event) {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'YOUSUB_FETCH_RESPONSE') return;

      var id = event.data.requestId;
      var pending = pendingFetches[id];
      if (!pending) return;

      delete pendingFetches[id];

      if (event.data.success) {
        pending.resolve(event.data.text);
      } else {
        pending.reject(new Error(event.data.error || 'Main world fetch failed'));
      }
    });

    console.log('[YouSub] SubtitleParser: Main-world fetcher injected.');
  }

  /**
   * Fetch text via the main-world fetcher (page context, with cookies).
   * Falls back to background service worker if main world fetch fails.
   */
  function fetchText(url) {
    ensureFetcherInjected();

    return new Promise(function (resolve, reject) {
      var requestId = 'yousub_fetch_' + (++fetchIdCounter);

      // Timeout: 10 seconds
      var timer = setTimeout(function () {
        delete pendingFetches[requestId];
        reject(new Error('Main world fetch timed out after 10s'));
      }, 10000);

      pendingFetches[requestId] = {
        resolve: function (text) {
          clearTimeout(timer);
          resolve(text);
        },
        reject: function (err) {
          clearTimeout(timer);
          reject(err);
        }
      };

      // Small delay to ensure fetcher script is loaded
      setTimeout(function () {
        window.postMessage({
          type: 'YOUSUB_FETCH_REQUEST',
          requestId: requestId,
          url: url
        }, '*');
      }, 50);
    });
  }

  /**
   * Fallback: fetch via background service worker (for non-YouTube URLs).
   */
  function fetchFromBackground(url) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ action: 'YOUSUB_FETCH_TEXT', url: url }, function (response) {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (response && response.success) {
          resolve(response.text);
        } else {
          reject(new Error((response && response.error) || 'Background fetch failed'));
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // SubtitleParser
  // ---------------------------------------------------------------------------

  YouSub.SubtitleParser = {
    /**
     * Fetch subtitle contents and parse them into a generic format.
     * @param {string} baseUrl - The base URL of the subtitle track
     * @returns {Promise<Array>} - Resolves to array of {startMs, endMs, text}
     */
    fetch: async function (baseUrl) {
      try {
        console.log('[YouSub] SubtitleParser: Fetching from baseUrl:', baseUrl.substring(0, 120) + '...');

        // ---------------------------------------------------------------
        // Attempt 1: JSON3 via MAIN world (page context, with cookies)
        // ---------------------------------------------------------------
        var json3Url = baseUrl + '&fmt=json3';

        try {
          console.log('[YouSub] SubtitleParser: Trying JSON3 via main-world fetch...');
          var json3Text = await fetchText(json3Url);
          console.log('[YouSub] SubtitleParser: Main-world JSON3 response length:', json3Text.length);

          if (json3Text && json3Text.trim().length > 0) {
            var jsonData = JSON.parse(json3Text);
            var json3Result = this.parseJson3(jsonData);
            if (json3Result.length > 0) {
              console.log('[YouSub] SubtitleParser: JSON3 success,', json3Result.length, 'entries.');
              return json3Result;
            }
          }
        } catch (e) {
          console.warn('[YouSub] SubtitleParser: Main-world JSON3 failed:', e.message);
        }

        // ---------------------------------------------------------------
        // Attempt 2: XML via MAIN world
        // ---------------------------------------------------------------
        try {
          console.log('[YouSub] SubtitleParser: Trying XML via main-world fetch...');
          var xmlText = await fetchText(baseUrl);
          console.log('[YouSub] SubtitleParser: Main-world XML response length:', xmlText.length);

          if (xmlText && xmlText.trim().length > 0) {
            var xmlResult = this.parseXml(xmlText);
            if (xmlResult.length > 0) {
              console.log('[YouSub] SubtitleParser: XML success,', xmlResult.length, 'entries.');
              return xmlResult;
            }
          }
        } catch (e) {
          console.warn('[YouSub] SubtitleParser: Main-world XML failed:', e.message);
        }

        // ---------------------------------------------------------------
        // Attempt 3: Background service worker fallback
        // ---------------------------------------------------------------
        try {
          console.log('[YouSub] SubtitleParser: Trying JSON3 via background fetch...');
          var bgText = await fetchFromBackground(json3Url);
          if (bgText && bgText.trim().length > 0) {
            var bgData = JSON.parse(bgText);
            var bgResult = this.parseJson3(bgData);
            if (bgResult.length > 0) {
              console.log('[YouSub] SubtitleParser: Background JSON3 success,', bgResult.length, 'entries.');
              return bgResult;
            }
          }
        } catch (e) {
          console.warn('[YouSub] SubtitleParser: Background fallback failed:', e.message);
        }

        console.error('[YouSub] SubtitleParser: All fetch attempts failed.');
        return [];
      } catch (error) {
        console.error('[YouSub] SubtitleParser Error:', error);
        return [];
      }
    },

    /**
     * Parse YouTube's JSON3 subtitles format.
     */
    parseJson3: function (data) {
      var output = [];
      if (!data || !data.events) return output;

      data.events.forEach(function (event) {
        if (!event.segs) return;

        var startMs = event.tStartMs || 0;
        var durationMs = event.dDurationMs || 0;
        var endMs = startMs + durationMs;

        var fullText = '';
        event.segs.forEach(function (seg) {
          if (seg.utf8) fullText += seg.utf8;
        });

        fullText = fullText.replace(/\n/g, ' ').trim();
        if (fullText.length > 0 && durationMs > 0) {
          output.push({ startMs: startMs, endMs: endMs, text: fullText });
        }
      });

      return sortTracks(output);
    },

    /**
     * Parse fallback XML format using DOMParser.
     */
    parseXml: function (xmlText) {
      var output = [];
      try {
        var parser = new DOMParser();
        var xml = parser.parseFromString(xmlText, 'text/xml');
        var textNodes = xml.querySelectorAll('text');

        for (var i = 0; i < textNodes.length; i++) {
          var node = textNodes[i];
          var startSec = parseFloat(node.getAttribute('start') || '0');
          var durSec = parseFloat(node.getAttribute('dur') || '0');

          var startMs = Math.round(startSec * 1000);
          var durationMs = Math.round(durSec * 1000);
          var endMs = startMs + durationMs;

          var textContent = node.textContent || '';
          textContent = decodeHtml(textContent).replace(/\n/g, ' ').trim();

          if (textContent.length > 0 && durationMs > 0) {
            output.push({ startMs: startMs, endMs: endMs, text: textContent });
          }
        }
      } catch (e) {
        console.error('[YouSub] SubtitleParser: Failed to parse XML', e);
      }
      return sortTracks(output);
    }
  };
})();
