import { devLog, devWarn } from '../shared/constants.js';

let fetcherInjected = false;
const pendingFetches = {};      // requestId → { resolve, reject }
let fetchIdCounter = 0;

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
  if (!html) return '';
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return doc.documentElement.textContent || '';
  } catch (e) {
    devWarn('[YouSub] SubtitleParser: decodeHtml failed', e);
    return html;
  }
}

/**
 * Inject the main-world-fetcher.js script into the page if not already done.
 * This script runs in the YouTube page context (same-origin, with cookies).
 */
function ensureFetcherInjected() {
  if (fetcherInjected) return;
  fetcherInjected = true;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/content/main-world-fetcher.js');
  script.onload = function () { this.remove(); };
  (document.head || document.documentElement).appendChild(script);

  // Listen for fetch responses from main world
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'YOUSUB_FETCH_RESPONSE') return;

    const id = event.data.requestId;
    const pending = pendingFetches[id];
    if (!pending) return;

    delete pendingFetches[id];

    if (event.data.success) {
      pending.resolve(event.data.text);
    } else {
      pending.reject(new Error(event.data.error || 'Main world fetch failed'));
    }
  });

  devLog('[YouSub] SubtitleParser: Main-world fetcher injected.');
}

/**
 * Fetch text via the main-world fetcher (page context, with cookies).
 * Falls back to background service worker if main world fetch fails.
 */
function fetchText(url) {
  ensureFetcherInjected();

  return new Promise(function (resolve, reject) {
    const requestId = 'yousub_fetch_' + (++fetchIdCounter);

    // Timeout: 10 seconds
    const timer = setTimeout(function () {
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
    chrome.runtime.sendMessage({ type: 'YOUSUB_FETCH_TEXT', url: url }, function (response) {
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

export const SubtitleParser = {
  /**
   * Fetch subtitle contents and parse them into a generic format.
   * @param {string} baseUrl - The base URL of the subtitle track
   * @returns {Promise<Array>} - Resolves to array of {startMs, endMs, text}
   */
  fetch: async function (baseUrl) {
    try {
      devLog('[YouSub] SubtitleParser: Fetching from baseUrl:', baseUrl.substring(0, 120) + '...');

      var json3Url = baseUrl + '&fmt=json3';

      try {
        devLog('[YouSub] SubtitleParser: Trying JSON3 via main-world fetch...');
        const json3Text = await fetchText(json3Url);
        devLog('[YouSub] SubtitleParser: Main-world JSON3 response length:', json3Text.length);

        if (json3Text && json3Text.trim().length > 0) {
          let jsonData;
          try { jsonData = JSON.parse(json3Text); } catch (parseErr) {
            throw new Error('JSON3 parse error: ' + parseErr.message);
          }
          const json3Result = this.parseJson3(jsonData);
          if (json3Result.length > 0) {
            devLog('[YouSub] SubtitleParser: JSON3 success,', json3Result.length, 'entries.');
            return json3Result;
          }
        }
      } catch (e) {
        devWarn('[YouSub] SubtitleParser: Main-world JSON3 failed:', e.message);
      }

      try {
        devLog('[YouSub] SubtitleParser: Trying XML via main-world fetch...');
        const xmlText = await fetchText(baseUrl);
        devLog('[YouSub] SubtitleParser: Main-world XML response length:', xmlText.length);

        if (xmlText && xmlText.trim().length > 0) {
          const xmlResult = this.parseXml(xmlText);
          if (xmlResult.length > 0) {
            devLog('[YouSub] SubtitleParser: XML success,', xmlResult.length, 'entries.');
            return xmlResult;
          }
        }
      } catch (e) {
        devWarn('[YouSub] SubtitleParser: Main-world XML failed:', e.message);
      }

      try {
        devLog('[YouSub] SubtitleParser: Trying JSON3 via background fetch...');
        const bgText = await fetchFromBackground(json3Url);
        if (bgText && bgText.trim().length > 0) {
          let bgData;
          try { bgData = JSON.parse(bgText); } catch (parseErr) {
            throw new Error('Background JSON3 parse error: ' + parseErr.message);
          }
          const bgResult = this.parseJson3(bgData);
          if (bgResult.length > 0) {
            devLog('[YouSub] SubtitleParser: Background JSON3 success,', bgResult.length, 'entries.');
            return bgResult;
          }
        }
      } catch (e) {
        devWarn('[YouSub] SubtitleParser: Background fallback failed:', e.message);
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
    const output = [];
    if (!data || !data.events) return output;

    data.events.forEach(function (event) {
      if (!event.segs) return;

      const startMs = event.tStartMs || 0;
      const durationMs = event.dDurationMs || 0;
      const endMs = startMs + durationMs;

      let fullText = '';
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
    const output = [];
    try {
      const parser = new DOMParser();
      const xml = parser.parseFromString(xmlText, 'text/xml');
      const textNodes = xml.querySelectorAll('text');

      for (let i = 0; i < textNodes.length; i++) {
        const node = textNodes[i];
        const startSec = parseFloat(node.getAttribute('start') || '0');
        const durSec = parseFloat(node.getAttribute('dur') || '0');

        const startMs = Math.round(startSec * 1000);
        const durationMs = Math.round(durSec * 1000);
        const endMs = startMs + durationMs;

        let textContent = node.textContent || '';
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

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.SubtitleParser = SubtitleParser;
}
