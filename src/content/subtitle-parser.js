import { devLog, devWarn } from '../shared/constants.js';

let fetchListenerRegistered = false;
const pendingFetches = {}; // requestId → { resolve, reject }
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
 * Register the postMessage listener for responses from the declarative MAIN-world
 * fetcher script (main-world-fetcher.js registered via manifest world:"MAIN").
 */
function ensureFetchListener() {
  if (fetchListenerRegistered) return;
  fetchListenerRegistered = true;

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

  devLog('[YouSub] SubtitleParser: Main-world fetch bridge ready.');
}

/**
 * Fetch text via the main-world fetcher (page context, with cookies).
 * Falls back to background service worker if main world fetch fails.
 */
function fetchText(url) {
  ensureFetchListener();

  return new Promise(function (resolve, reject) {
    const requestId = 'yousub_fetch_' + ++fetchIdCounter;

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
      },
    };

    window.postMessage(
      {
        type: 'YOUSUB_FETCH_REQUEST',
        requestId: requestId,
        url: url,
      },
      '*'
    );
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
          try {
            jsonData = JSON.parse(json3Text);
          } catch (parseErr) {
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
          try {
            bgData = JSON.parse(bgText);
          } catch (parseErr) {
            throw new Error('Background JSON3 parse error: ' + parseErr.message);
          }
          const bgResult = this.parseJson3(bgData);
          if (bgResult.length > 0) {
            devLog(
              '[YouSub] SubtitleParser: Background JSON3 success,',
              bgResult.length,
              'entries.'
            );
            return bgResult;
          }
        }
      } catch (e) {
        devWarn('[YouSub] SubtitleParser: Background fallback failed:', e.message);
      }

      devWarn('[YouSub] SubtitleParser: All fetch attempts failed.');
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
  },

  /**
   * Parse an SRT or WebVTT timestamp ("HH:MM:SS,mmm", "HH:MM:SS.mmm", or "MM:SS.mmm")
   * into integer milliseconds. Returns NaN when malformed.
   */
  parseTimestampMs: function (tsString) {
    if (!tsString || typeof tsString !== 'string') return NaN;
    const clean = tsString.trim();
    const match = clean.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (!match) return NaN;

    const hours = match[1] ? parseInt(match[1], 10) : 0;
    const minutes = parseInt(match[2], 10);
    const seconds = parseInt(match[3], 10);
    const ms = match[4] ? parseInt(match[4].padEnd(3, '0'), 10) : 0;

    if (minutes >= 60 || seconds >= 60) return NaN;
    return (hours * 3600 + minutes * 60 + seconds) * 1000 + ms;
  },

  /**
   * Strip VTT/SRT/ASS inline styling tags and decode entities into clean cue text.
   */
  cleanCueText: function (rawLines) {
    const joined = rawLines.join(' ').replace(/\{\\[^}]*\}/g, '');
    const stripped = joined
      .replace(/<\/?(?:i|b|u|s|font|c|v|ruby|rt|lang)(?:[.\s][^>]*)?>/gi, '')
      .replace(/<\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?>/g, '');
    return decodeHtml(stripped)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  },

  /**
   * Parse SubRip (.srt) subtitle text into [{ startMs, endMs, text }].
   */
  parseSrt: function (srtText) {
    if (!srtText || typeof srtText !== 'string') return [];
    const normalized = srtText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const blocks = normalized.split(/\n\s*\n/);
    const output = [];

    for (const block of blocks) {
      const lines = block
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.trim().length > 0);
      if (lines.length < 2) continue;

      let timingIdx = 0;
      if (/^\d+$/.test(lines[0].trim())) {
        timingIdx = 1;
      }
      if (timingIdx >= lines.length) continue;

      const timingMatch = lines[timingIdx].trim().match(/^([^\s]+)\s+-->\s+([^\s]+)(?:\s+.*)?$/);
      if (!timingMatch) continue;

      const startMs = this.parseTimestampMs(timingMatch[1]);
      const endMs = this.parseTimestampMs(timingMatch[2]);
      const text = this.cleanCueText(lines.slice(timingIdx + 1));

      if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs && text.length > 0) {
        output.push({ startMs, endMs, text });
      }
    }

    return sortTracks(output);
  },

  /**
   * Parse WebVTT (.vtt) subtitle text into [{ startMs, endMs, text }].
   */
  parseVtt: function (vttText) {
    if (!vttText || typeof vttText !== 'string') return [];
    const normalized = vttText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const blocks = normalized.split(/\n\s*\n/);
    const output = [];

    for (let b = 0; b < blocks.length; b++) {
      const rawBlock = blocks[b].trim();
      if (!rawBlock) continue;
      if (b === 0 && /^WEBVTT(?:\s|$|-)/i.test(rawBlock)) continue;
      if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/i.test(rawBlock)) continue;

      const lines = rawBlock.split('\n').filter((l) => l.trim().length > 0);
      if (lines.length < 2) continue;

      const arrowIdx = lines.findIndex((l) => l.includes('-->'));
      if (arrowIdx === -1 || arrowIdx + 1 >= lines.length) continue;

      const timingMatch = lines[arrowIdx].trim().match(/^([^\s]+)\s+-->\s+([^\s]+)(?:\s+.*)?$/);
      if (!timingMatch) continue;

      const startMs = this.parseTimestampMs(timingMatch[1]);
      const endMs = this.parseTimestampMs(timingMatch[2]);
      const text = this.cleanCueText(lines.slice(arrowIdx + 1));

      if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs && text.length > 0) {
        output.push({ startMs, endMs, text });
      }
    }

    return sortTracks(output);
  },

  /**
   * Auto-detect .vtt vs .srt subtitle content and parse into [{ startMs, endMs, text }].
   */
  parseSubtitleFile: function (content, fileName = '') {
    if (!content || typeof content !== 'string') return [];
    const trimmed = content.replace(/^\uFEFF/, '').trimStart();
    const isVtt = /^WEBVTT(?:\s|$|-)/i.test(trimmed) || /\.vtt$/i.test(fileName);

    if (isVtt) {
      const vttEntries = this.parseVtt(content);
      return vttEntries.length > 0 ? vttEntries : this.parseSrt(content);
    }
    const srtEntries = this.parseSrt(content);
    return srtEntries.length > 0 ? srtEntries : this.parseVtt(content);
  },
};

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.SubtitleParser = SubtitleParser;
}
