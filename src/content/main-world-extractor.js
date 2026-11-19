/**
 * main-world-extractor.js — Runs in the MAIN world (YouTube page context via
 * manifest content_scripts world: "MAIN").
 *
 * Strategy order:
 *  1. Reuse already-open transcript segments if the user opened the panel manually
 *  2. Silent Innertube XHR (/youtubei/v1/get_panel, /next, /get_transcript) — zero UI panel flash
 *  3. Fallback: click "Show transcript" in Watch DOM, parse segments, and auto-close the panel
 */
(function () {
  'use strict';

  try {
    if (window.__yousubMainExtractorReady) return;
    window.__yousubMainExtractorReady = true;

    // -------------------------------------------------------------------------
    // Phase 50.6: Trusted Types Bypass & Safety
    // -------------------------------------------------------------------------
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      try {
        window.trustedTypes.createPolicy('yousub-extractor-policy', {
          createHTML: function (html) {
            return html;
          },
          createScript: function (s) {
            return s;
          },
          createScriptURL: function (u) {
            return u;
          },
        });
      } catch {}
    }

    var _isProd = window.YouSub && window.YouSub.Constants && window.YouSub.Constants.IS_PRODUCTION;
    function _devLog() {
      if (!_isProd) console.log.apply(console, arguments);
    }
    function _devWarn() {
      if (!_isProd) console.warn.apply(console, arguments);
    }

    function parseCurrentVideoId() {
      var id = new URLSearchParams(window.location.search).get('v');
      if (!id && window.location.pathname.startsWith('/shorts/')) {
        id = window.location.pathname.split('/')[2];
      }
      return id || null;
    }

    // -------------------------------------------------------------------------
    // Utility: Send result back to content script
    // -------------------------------------------------------------------------
    function sendResult(tracks, parsedEntries, error, requestId) {
      var payload = {
        type: 'YOUSUB_CAPTION_TRACKS',
        tracks: tracks,
        parsedEntries: parsedEntries,
        error: error,
      };
      if (requestId) payload.requestId = requestId;
      window.postMessage(payload, '*');
    }

    // -------------------------------------------------------------------------
    // Utility: Wait for a duration
    // -------------------------------------------------------------------------
    function wait(ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    }

    // -------------------------------------------------------------------------
    // Utility: Parse timestamp "M:SS" or "H:MM:SS" to milliseconds
    // -------------------------------------------------------------------------
    function parseTimestamp(str) {
      if (typeof str !== 'string') return NaN;
      var clean = str.trim();
      if (!/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(clean)) return NaN;
      var parts = clean.split(':').map(Number);
      var seconds = 0;
      if (parts.length === 3) {
        seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      } else if (parts.length === 2) {
        seconds = parts[0] * 60 + parts[1];
      } else if (parts.length === 1) {
        seconds = parts[0];
      }
      return Math.round(seconds * 1000);
    }

    function getActivePlayer(isShorts) {
      if (isShorts) {
        return (
          document.getElementById('shorts-player') ||
          document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player') ||
          document.querySelector('ytd-shorts .html5-video-player') ||
          document.getElementById('movie_player') ||
          document.querySelector('.html5-video-player')
        );
      }
      return (
        document.getElementById('movie_player') ||
        document.getElementById('player-container-id') ||
        document.querySelector('.html5-video-player')
      );
    }

    // -------------------------------------------------------------------------
    // Utility: JSDOM-safe element visibility check (avoids hidden stale SPA DOM)
    // -------------------------------------------------------------------------
    function isElementUsable(el) {
      if (!el) return false;
      if (el.hasAttribute && el.hasAttribute('hidden')) return false;
      if (el.closest) {
        if (
          el.closest('[hidden]') ||
          el.closest('[visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"]') ||
          el.closest('[visibility="ENGAGEMENT_PANEL_VISIBILITY_COLLAPSED"]') ||
          el.closest('[visibility="ENGAGEMENT_PANEL_VISIBILITY_MINIMIZED"]')
        ) {
          return false;
        }
        var panel = el.closest('ytd-engagement-panel-section-list-renderer');
        if (panel && panel.hasAttribute && panel.hasAttribute('visibility')) {
          if (panel.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
            return false;
          }
        }
      }
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
      if (el.style && el.style.display === 'none') return false;
      return true;
    }

    function findFirstUsable(nodeList) {
      if (!nodeList) return null;
      for (var i = 0; i < nodeList.length; i++) {
        if (isElementUsable(nodeList[i])) return nodeList[i];
      }
      return null;
    }

    // -------------------------------------------------------------------------
    // Step 1: Find the "Show transcript" button
    // -------------------------------------------------------------------------
    function findTranscriptButton() {
      var isShorts = window.location.pathname.startsWith('/shorts/');

      // Strategy A: Look for button in the description section (Regular Video)
      if (!isShorts) {
        var descSection = document.querySelector(
          'ytd-video-description-transcript-section-renderer'
        );
        if (descSection && isElementUsable(descSection)) {
          var btn = findFirstUsable(descSection.querySelectorAll('button'));
          if (btn) {
            _devLog('[YouSub] MainWorldExtractor: Found transcript button in description section.');
            return btn;
          }
        }
      }

      // Strategy B: Search by aria-label (locale-resilient). The structural
      // selectors above already cover non-English videos language-agnostically;
      // this adds EN (case-insensitive substring) + JA aria-label matches so a
      // Japanese-UI YouTube still hits the fast DOM-scrape path.
      var ariaBtn = findFirstUsable(
        document.querySelectorAll(
          'button[aria-label*="transcript" i], button[aria-label*="文字起こし"]'
        )
      );
      if (ariaBtn) {
        _devLog('[YouSub] MainWorldExtractor: Found transcript button by aria-label.');
        return ariaBtn;
      }

      // Strategy C: Shorts-specific search in Active Reel (with/without [is-active])
      if (isShorts) {
        var shortsDesc = document.querySelector(
          'ytd-reel-video-renderer[is-active] ytd-structured-description-content-renderer, ytd-shorts ytd-structured-description-content-renderer, ytd-reel-video-renderer ytd-structured-description-content-renderer'
        );
        if (shortsDesc && isElementUsable(shortsDesc)) {
          var shortsBtn = findFirstUsable(
            shortsDesc.querySelectorAll(
              'ytd-video-description-transcript-section-renderer button, button[aria-label*="transcript" i], button[aria-label*="文字起こし"]'
            )
          );
          if (shortsBtn) {
            _devLog('[YouSub] MainWorldExtractor: Found transcript button in Shorts description.');
            return shortsBtn;
          }
        }
      }

      // Strategy D: Search all buttons/renderers for text content (locale-resilient).
      // EN + JA + VI YouTube UI labels for "Show transcript" / "transcript"
      var transcriptLabels = [
        'show transcript',
        'transcript',
        '文字起こしを表示',
        '文字起こし',
        'hiển thị bản chép lời',
        'bản chép lời',
      ];
      var allButtons = document.querySelectorAll(
        'ytd-button-renderer, tp-yt-paper-button, button, ytd-menu-service-item-renderer'
      );
      for (var i = 0; i < allButtons.length; i++) {
        if (!isElementUsable(allButtons[i])) continue;
        var text = allButtons[i].textContent.trim().toLowerCase();
        if (transcriptLabels.indexOf(text) !== -1) {
          _devLog('[YouSub] MainWorldExtractor: Found transcript button by text search.');
          return allButtons[i];
        }
      }

      return null;
    }

    // -------------------------------------------------------------------------
    // Step 1b: Try to expand description/menu to reveal transcript button
    // -------------------------------------------------------------------------
    async function expandDescription() {
      var isShorts = window.location.pathname.startsWith('/shorts/');

      if (isShorts) {
        // Step 1: Find and click "More actions" (...) button on the active short
        var moreBtn = document.querySelector(
          'ytd-reel-video-renderer[is-active] #menu.ytd-reel-video-renderer button, ytd-shorts #menu.ytd-reel-video-renderer button'
        );
        if (moreBtn) {
          _devLog('[YouSub] MainWorldExtractor: Clicking Shorts "More actions" menu...');
          moreBtn.click();
          await wait(500);

          // Step 2: Find "Description" in the menu
          var menuItems = document.querySelectorAll('ytd-menu-service-item-renderer');
          for (var i = 0; i < menuItems.length; i++) {
            var text = menuItems[i].textContent.toLowerCase();
            // Phase 50.6 + localization: EN / VI / JA
            if (text.includes('description') || text.includes('mô tả') || text.includes('説明')) {
              _devLog('[YouSub] MainWorldExtractor: Clicking "Description" in Shorts menu...');
              menuItems[i].click();
              return true;
            }
          }
        }
        return false;
      }

      // Regular Video Logic
      // Click "...more" to expand description
      var expandMoreBtn = document.querySelector('tp-yt-paper-button#expand');
      if (expandMoreBtn) {
        expandMoreBtn.click();
        _devLog('[YouSub] MainWorldExtractor: Expanded description.');
        return true;
      }

      // Alternative: look for the expand button by aria-label
      var expandBtn = document.querySelector('#description-inline-expander tp-yt-paper-button');
      if (expandBtn) {
        expandBtn.click();
        _devLog('[YouSub] MainWorldExtractor: Expanded description (alt).');
        return true;
      }

      return false;
    }

    // -------------------------------------------------------------------------
    // Step 2: Wait for transcript segments to appear in DOM
    // -------------------------------------------------------------------------
    var TRANSCRIPT_SEGMENT_SELECTORS = [
      'transcript-segment-view-model', // New YouTube layout
      'ytd-transcript-segment-renderer', // Old layout
      'ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer',
      '[target-id="PAmodern_transcript_view"] transcript-segment-view-model',
      '[target-id="engagement-panel-searchable-transcript"] ytd-transcript-segment-renderer',
      'ytd-transcript-renderer [class*="segment"]',
      'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"] [class*="segment"]',
    ];

    function findExistingSegments() {
      for (var s = 0; s < TRANSCRIPT_SEGMENT_SELECTORS.length; s++) {
        var rawSegments = document.querySelectorAll(TRANSCRIPT_SEGMENT_SELECTORS[s]);
        var segments = [];
        for (var n = 0; n < rawSegments.length; n++) {
          if (isElementUsable(rawSegments[n])) segments.push(rawSegments[n]);
        }
        if (segments.length > 0) {
          return { segments: segments, selector: TRANSCRIPT_SEGMENT_SELECTORS[s] };
        }
      }
      return null;
    }

    function waitForSegments(timeoutMs) {
      return new Promise(function (resolve) {
        var elapsed = 0;
        var interval = 300;
        var loggedOnce = false;

        function check() {
          var hit = findExistingSegments();
          if (hit) {
            _devLog(
              '[YouSub] MainWorldExtractor: Found',
              hit.segments.length,
              'segments with selector:',
              hit.selector
            );
            resolve(hit.segments);
            return;
          }

          // Diagnostic: log what's in the transcript panel (once)
          if (!loggedOnce && elapsed >= 2000) {
            loggedOnce = true;

            // Check if engagement panel exists
            var panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
            _devLog('[YouSub] DIAGNOSTIC: Found', panels.length, 'engagement panels.');
            panels.forEach(function (p, i) {
              var targetId = p.getAttribute('target-id') || 'no-target-id';
              var visibility = p.getAttribute('visibility') || 'no-visibility';
              _devLog(
                '[YouSub] DIAGNOSTIC: Panel[' +
                  i +
                  '] target-id=' +
                  targetId +
                  ' visibility=' +
                  visibility
              );

              // Log child tag names (first 2 levels)
              if (targetId.indexOf('transcript') !== -1 || visibility.indexOf('EXPANDED') !== -1) {
                var children = p.querySelectorAll('*');
                var tags = {};
                children.forEach(function (c) {
                  var tag = c.tagName.toLowerCase();
                  tags[tag] = (tags[tag] || 0) + 1;
                });
                _devLog('[YouSub] DIAGNOSTIC: Panel[' + i + '] child tags:', JSON.stringify(tags));
              }
            });

            // Also check for transcript renderer directly
            var transcriptRenderer = document.querySelector('ytd-transcript-renderer');
            if (transcriptRenderer) {
              _devLog('[YouSub] DIAGNOSTIC: ytd-transcript-renderer found.');
            } else {
              _devLog('[YouSub] DIAGNOSTIC: ytd-transcript-renderer NOT found in DOM.');
            }
          }

          elapsed += interval;
          if (elapsed >= timeoutMs) {
            _devLog(
              '[YouSub] MainWorldExtractor: Timeout waiting for transcript segments after',
              timeoutMs,
              'ms.'
            );
            resolve(null);
            return;
          }

          setTimeout(check, interval);
        }

        check();
      });
    }

    // -------------------------------------------------------------------------
    // Step 3: Parse transcript segments from DOM
    // -------------------------------------------------------------------------
    function parseTranscriptSegments(segments) {
      var entries = [];

      for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];

        var timestampText = '';
        var textContent = '';

        // Strategy A: Dedicated selectors for transcript-segment-view-model (2024/2025 layout)
        if (
          seg.tagName.toLowerCase() === 'transcript-segment-view-model' ||
          seg.querySelector('transcript-segment-view-model')
        ) {
          var host =
            seg.tagName.toLowerCase() === 'transcript-segment-view-model'
              ? seg
              : seg.querySelector('transcript-segment-view-model');
          // Phase 53.2: Null guard — DOM may change between check and assignment
          if (host) {
            var tsEl = host.querySelector('.segment-timestamp, [class*="timestamp"]');
            var txtEl = host.querySelector(
              '.segment-text, [class*="segment-text"], yt-formatted-string'
            );

            if (tsEl) timestampText = tsEl.innerText || tsEl.textContent;
            if (txtEl) textContent = txtEl.innerText || txtEl.textContent;
          }
        }

        // Strategy B: Fallback to innerText parsing if above failed
        if (!timestampText || !textContent) {
          var innerText = seg.innerText ? seg.innerText.trim() : '';
          if (innerText && innerText.indexOf('\n') !== -1) {
            var parts = innerText.split('\n');
            timestampText = parts[0].trim();
            textContent = parts.slice(1).join(' ').trim();
          } else {
            // Fallback for older youtube versions
            var timestampEl = seg.querySelector(
              '.segment-timestamp, [class*="timestamp"], div.segment-start-offset'
            );
            var textEl = seg.querySelector(
              '.segment-text, yt-formatted-string.segment-text, [class*="segment-text"]'
            );

            if (!timestampEl && !textEl && seg.children.length >= 2) {
              timestampEl = seg.children[0];
              textEl = seg.children[1];
            }

            if (timestampEl) timestampText = timestampEl.innerText || timestampEl.textContent;
            if (textEl) textContent = textEl.innerText || textEl.textContent;
          }
        }

        // Force strip any hidden prepended accessibility text
        // Matches "44 seconds", "1 minute, 13 seconds" etc. at the start of the string
        var timePrefixRegex = /^(?:\d+\s+(?:hours?|minutes?|seconds?),?\s*)+/i;
        if (textContent) {
          textContent = textContent.replace(timePrefixRegex, '').trim();
        }

        timestampText = timestampText ? timestampText.replace(/[^0-9:]/g, '') : '';

        if (timestampText && textContent) {
          var startMs = parseTimestamp(timestampText);
          if (!isNaN(startMs)) {
            entries.push({
              startMs: startMs,
              endMs: 0,
              text: textContent
                .replace(/[\r\n\u00a0]+/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim(),
            });
          }
        }
      }

      // Calculate endMs: each entry ends when the next one starts
      for (var j = 0; j < entries.length; j++) {
        if (j + 1 < entries.length) {
          entries[j].endMs = entries[j + 1].startMs;
        } else {
          // Last entry: add 5 seconds as default duration
          entries[j].endMs = entries[j].startMs + 5000;
        }
      }

      return entries;
    }

    // -------------------------------------------------------------------------
    // Fallback: Extract track info and video metadata from page
    // -------------------------------------------------------------------------
    function findActiveReelPlayerResponse(targetVideoId) {
      try {
        var activeReel = document.querySelector('ytd-reel-video-renderer[is-active]');
        if (activeReel && activeReel.data && activeReel.data.playerResponse) {
          return activeReel.data.playerResponse;
        }
        var reels = document.querySelectorAll('ytd-reel-video-renderer');
        for (var i = 0; i < reels.length; i++) {
          var pr = reels[i] && reels[i].data && reels[i].data.playerResponse;
          if (pr && pr.videoDetails && pr.videoDetails.videoId === targetVideoId) {
            return pr;
          }
        }
        if (reels.length > 0 && reels[0].data && reels[0].data.playerResponse) {
          return reels[0].data.playerResponse;
        }
      } catch {}
      return null;
    }

    function extractVideoMetadata(targetVideoId) {
      var isShorts = window.location.pathname.startsWith('/shorts/');
      var data = {
        tracks: null,
        isLive: false,
        title: document.title,
      };

      var sources = [];
      // 1. Try active player (#shorts-player on Shorts, #movie_player on Watch)
      var player = getActivePlayer(isShorts);
      if (player && typeof player.getPlayerResponse === 'function') {
        try {
          sources.push(player.getPlayerResponse());
        } catch {}
      }
      // 2. Try Shorts reel renderer data BEFORE window.ytInitialPlayerResponse (which can be stale on Shorts swipe)
      var reelResp = findActiveReelPlayerResponse(targetVideoId);
      if (reelResp) sources.push(reelResp);
      // 3. Try window.ytInitialPlayerResponse (only if it matches current videoId or lacks videoDetails)
      if (window.ytInitialPlayerResponse) sources.push(window.ytInitialPlayerResponse);

      for (var s = 0; s < sources.length; s++) {
        var resp = sources[s];
        if (!resp) continue;
        if (
          resp.videoDetails &&
          resp.videoDetails.videoId &&
          resp.videoDetails.videoId !== targetVideoId
        ) {
          continue;
        }

        // Detect Live status
        if (resp.videoDetails && resp.videoDetails.isLive) {
          data.isLive = true;
        }

        // Extract Tracks
        if (resp.captions) {
          var renderer = resp.captions.playerCaptionsTracklistRenderer;
          if (renderer && renderer.captionTracks) {
            data.tracks = renderer.captionTracks.map(function (t) {
              return {
                languageCode: t.languageCode || '',
                languageName: (t.name && t.name.simpleText) || t.languageCode || 'Unknown',
                isAutoGenerated: t.kind === 'asr' || !!t.isTranslatable,
                baseUrl: t.baseUrl || '',
              };
            });
          }
        }

        if (data.tracks || data.isLive) break; // Found something
      }

      return data;
    }

    // -------------------------------------------------------------------------
    // Shared Innertube XHR helper + Fallbacks (Player Tracks + get_panel)
    // -------------------------------------------------------------------------
    function buildInnertubeContext() {
      var existing =
        window.ytcfg && typeof window.ytcfg.get === 'function'
          ? window.ytcfg.get('INNERTUBE_CONTEXT')
          : null;
      if (existing && typeof existing === 'object') {
        return existing;
      }
      var clientVersion = '2.20261116.00.00';
      if (window.ytcfg && typeof window.ytcfg.get === 'function') {
        clientVersion = window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION') || clientVersion;
      }
      return {
        client: {
          clientName: 'WEB',
          clientVersion: clientVersion,
          hl: (navigator.language || 'en').split('-')[0],
        },
      };
    }

    function postInnertubeJson(endpointPath, payload, queryParams) {
      return new Promise(function (resolve) {
        try {
          var apiKey = '';
          var clientName = '';
          var clientVersion = '';
          if (window.ytcfg && typeof window.ytcfg.get === 'function') {
            apiKey = window.ytcfg.get('INNERTUBE_API_KEY') || '';
            clientName = window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_NAME') || '';
            clientVersion = window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION') || '';
          }

          var queryParts = [];
          if (queryParams) queryParts.push(queryParams);
          if (apiKey) queryParts.push('key=' + encodeURIComponent(apiKey));
          var origin =
            window.location &&
            window.location.origin &&
            window.location.hostname &&
            (window.location.hostname === 'youtube.com' ||
              window.location.hostname.endsWith('.youtube.com'))
              ? window.location.origin
              : 'https://www.youtube.com';
          var url =
            origin + endpointPath + (queryParts.length > 0 ? '?' + queryParts.join('&') : '');

          var body = JSON.stringify(payload);
          var xhr = new XMLHttpRequest();
          xhr.open('POST', url, true);
          xhr.setRequestHeader('Content-Type', 'application/json');
          if (clientName) xhr.setRequestHeader('X-YouTube-Client-Name', String(clientName));
          if (clientVersion)
            xhr.setRequestHeader('X-YouTube-Client-Version', String(clientVersion));
          xhr.withCredentials = true;
          xhr.timeout = 8000;

          var responded = false;
          xhr.onload = function () {
            if (responded) return;
            responded = true;
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve({ ok: true, status: xhr.status, data: JSON.parse(xhr.responseText) });
              } catch (parseErr) {
                _devWarn('[YouSub] Innertube JSON parse error:', parseErr.message);
                resolve({ ok: false, status: xhr.status, data: null });
              }
            } else {
              _devWarn('[YouSub] Innertube HTTP', xhr.status, endpointPath);
              resolve({ ok: false, status: xhr.status, data: null });
            }
          };

          xhr.onerror = function () {
            if (responded) return;
            responded = true;
            _devWarn('[YouSub] Innertube network error:', endpointPath);
            resolve({ ok: false, status: 0, data: null });
          };

          xhr.ontimeout = function () {
            if (responded) return;
            responded = true;
            _devWarn('[YouSub] Innertube timeout:', endpointPath);
            resolve({ ok: false, status: 0, data: null });
          };

          xhr.send(body);

          setTimeout(function () {
            if (responded) return;
            responded = true;
            _devWarn('[YouSub] Innertube safety timeout (12s):', endpointPath);
            try {
              xhr.abort();
            } catch {}
            resolve({ ok: false, status: 0, data: null });
          }, 12000);
        } catch (e) {
          _devWarn('[YouSub] Innertube exception:', e.message);
          resolve({ ok: false, status: 0, data: null });
        }
      });
    }

    async function fetchTracksViaInnertube(vid) {
      var res = await postInnertubeJson('/youtubei/v1/player', {
        videoId: vid,
        context: buildInnertubeContext(),
      });
      var result = { tracks: null, isLive: false };
      var resp = res && res.data;
      if (!resp) return result;

      if (resp.videoDetails && resp.videoDetails.isLive) {
        result.isLive = true;
      }
      if (
        resp.captions &&
        resp.captions.playerCaptionsTracklistRenderer &&
        resp.captions.playerCaptionsTracklistRenderer.captionTracks
      ) {
        result.tracks = resp.captions.playerCaptionsTracklistRenderer.captionTracks.map(
          function (t) {
            return {
              languageCode: t.languageCode || '',
              languageName: (t.name && t.name.simpleText) || t.languageCode || 'Unknown',
              isAutoGenerated: t.kind === 'asr' || !!t.isTranslatable,
              baseUrl: t.baseUrl || '',
            };
          }
        );
      }
      return result;
    }

    function encodeVarint(n, out) {
      var val = n >>> 0;
      while (val >= 0x80) {
        out.push((val & 0x7f) | 0x80);
        val = val >>> 7;
      }
      out.push(val);
    }

    function encodeUtf8Bytes(str) {
      if (typeof TextEncoder !== 'undefined') {
        return Array.from(new TextEncoder().encode(str));
      }
      var bytes = [];
      for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else {
          bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
      }
      return bytes;
    }

    function buildTranscriptPanelParams(vid) {
      // Encodes protobuf: field 153 (tag bytes 0xaa, 0x09) -> { 1: vid, 3: 1 }
      var vidBytes = encodeUtf8Bytes(vid);
      var inner = [];
      inner.push(0x0a);
      encodeVarint(vidBytes.length, inner);
      for (var i = 0; i < vidBytes.length; i++) inner.push(vidBytes[i]);
      inner.push(0x18, 0x01);

      var outer = [0xaa, 0x09];
      encodeVarint(inner.length, outer);
      for (var j = 0; j < inner.length; j++) outer.push(inner[j]);

      var bin = '';
      for (var k = 0; k < outer.length; k++) bin += String.fromCharCode(outer[k]);
      return btoa(bin);
    }

    function extractRunsText(node) {
      if (!node || typeof node !== 'object') return '';
      if (typeof node.simpleText === 'string') return node.simpleText;
      if (typeof node.content === 'string') return node.content;
      if (
        node.elementsAttributedString &&
        typeof node.elementsAttributedString.content === 'string'
      ) {
        return node.elementsAttributedString.content;
      }
      if (Array.isArray(node.runs)) {
        return node.runs
          .map(function (r) {
            return (r && r.text) || '';
          })
          .join('');
      }
      return '';
    }

    function normalizeSegmentText(str) {
      return String(str || '')
        .replace(/[\r\n\u00a0]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    function parseGetPanelResponse(data) {
      if (!data || typeof data !== 'object') return [];
      var rawEntries = [];

      function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.transcriptSegmentViewModel) {
          var vm = node.transcriptSegmentViewModel;
          var vmText = normalizeSegmentText(
            vm.simpleText || extractRunsText(vm.snippet) || vm.text || ''
          );
          var vmStart = NaN;
          if (vm.startMs != null && vm.startMs !== '' && !isNaN(Number(vm.startMs))) {
            vmStart = Number(vm.startMs);
          } else {
            var vmTsText =
              typeof vm.timestamp === 'string' ? vm.timestamp : extractRunsText(vm.timestamp);
            vmStart = vmTsText ? parseTimestamp(vmTsText) : NaN;
          }
          var vmEnd = vm.endMs != null && vm.endMs !== '' ? Number(vm.endMs) || 0 : 0;
          if (!isNaN(vmStart) && vmText) {
            rawEntries.push({ startMs: vmStart, endMs: vmEnd, text: vmText });
          }
          return;
        }
        if (node.transcriptSegmentRenderer) {
          var r = node.transcriptSegmentRenderer;
          var rStart = Number(r.startMs);
          var rEnd = Number(r.endMs) || 0;
          var rText = normalizeSegmentText(extractRunsText(r.snippet));
          if (!isNaN(rStart) && rText) {
            rawEntries.push({ startMs: rStart, endMs: rEnd, text: rText });
          }
          return;
        }
        if (Array.isArray(node)) {
          for (var i = 0; i < node.length; i++) walk(node[i]);
        } else {
          var keys = Object.keys(node);
          for (var k = 0; k < keys.length; k++) walk(node[keys[k]]);
        }
      }

      walk(data);

      rawEntries.sort(function (a, b) {
        return a.startMs - b.startMs;
      });

      for (var j = 0; j < rawEntries.length; j++) {
        if (!rawEntries[j].endMs || rawEntries[j].endMs <= rawEntries[j].startMs) {
          if (j + 1 < rawEntries.length) {
            rawEntries[j].endMs = Math.max(rawEntries[j].startMs, rawEntries[j + 1].startMs);
          } else {
            rawEntries[j].endMs = rawEntries[j].startMs + 5000;
          }
        }
      }

      return rawEntries;
    }

    function findPanelParamsInTree(node) {
      if (!node || typeof node !== 'object') return null;
      if (
        node.contentSourcePanelIdentifier &&
        node.contentSourcePanelIdentifier.tag === 'PAmodern_transcript_view' &&
        node.globalConfiguration &&
        typeof node.globalConfiguration.params === 'string'
      ) {
        return node.globalConfiguration.params;
      }
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
          var found = findPanelParamsInTree(node[i]);
          if (found) return found;
        }
      } else {
        var keys = Object.keys(node);
        for (var k = 0; k < keys.length; k++) {
          var foundChild = findPanelParamsInTree(node[keys[k]]);
          if (foundChild) return foundChild;
        }
      }
      return null;
    }

    function findGetTranscriptParamsInTree(node) {
      if (!node || typeof node !== 'object') return null;
      if (node.getTranscriptEndpoint && typeof node.getTranscriptEndpoint.params === 'string') {
        return node.getTranscriptEndpoint.params;
      }
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
          var found = findGetTranscriptParamsInTree(node[i]);
          if (found) return found;
        }
      } else {
        var keys = Object.keys(node);
        for (var k = 0; k < keys.length; k++) {
          var foundChild = findGetTranscriptParamsInTree(node[keys[k]]);
          if (foundChild) return foundChild;
        }
      }
      return null;
    }

    async function fetchTranscriptViaGetPanel(vid) {
      var initialParams = buildTranscriptPanelParams(vid);
      var context = buildInnertubeContext();

      var panelRes = await postInnertubeJson(
        '/youtubei/v1/get_panel',
        {
          context: context,
          panelId: 'PAmodern_transcript_view',
          params: initialParams,
        },
        'prettyPrint=false'
      );

      var entries = parseGetPanelResponse(panelRes && panelRes.data);
      if (entries.length > 0) return entries;

      // Fallback if YouTube rotated panel params encoding or uses classic getTranscriptEndpoint: discover via /youtubei/v1/next
      var nextRes = await postInnertubeJson('/youtubei/v1/next', {
        context: context,
        videoId: vid,
      });
      var discoveredParams = nextRes && nextRes.data ? findPanelParamsInTree(nextRes.data) : null;
      if (discoveredParams && discoveredParams !== initialParams) {
        var retryRes = await postInnertubeJson(
          '/youtubei/v1/get_panel',
          {
            context: context,
            panelId: 'PAmodern_transcript_view',
            params: discoveredParams,
          },
          'prettyPrint=false'
        );
        entries = parseGetPanelResponse(retryRes && retryRes.data);
        if (entries.length > 0) return entries;
      }

      var classicParams =
        nextRes && nextRes.data ? findGetTranscriptParamsInTree(nextRes.data) : null;
      if (classicParams) {
        var transcriptRes = await postInnertubeJson('/youtubei/v1/get_transcript', {
          context: context,
          params: classicParams,
        });
        entries = parseGetPanelResponse(transcriptRes && transcriptRes.data);
      }

      return entries.length > 0 ? entries : null;
    }

    function closeTranscriptPanel(shouldCollapseDescription) {
      try {
        var selectors = [
          'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]',
          'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]',
        ];
        var panels = Array.from(document.querySelectorAll(selectors.join(', ')));
        if (panels.length === 0) {
          var expandedPanels = document.querySelectorAll(
            'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]'
          );
          for (var i = 0; i < expandedPanels.length; i++) {
            if (
              expandedPanels[i].querySelector(
                'ytd-transcript-renderer, transcript-segment-view-model, ytd-transcript-segment-renderer'
              )
            ) {
              panels.push(expandedPanels[i]);
            }
          }
        }
        for (var j = 0; j < panels.length; j++) {
          var closeBtn = panels[j].querySelector(
            '#visibility-button button, ytd-engagement-panel-title-header-renderer #visibility-button button, button[aria-label*="close" i], button[aria-label*="đóng" i], button[aria-label*="閉じる"]'
          );
          if (closeBtn && typeof closeBtn.click === 'function') {
            closeBtn.click();
          } else {
            panels[j].setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
          }
        }
        if (shouldCollapseDescription) {
          var collapseBtn =
            document.querySelector('#description-inline-expander tp-yt-paper-button#collapse') ||
            document.querySelector('tp-yt-paper-button#collapse');
          if (
            collapseBtn &&
            isElementUsable(collapseBtn) &&
            typeof collapseBtn.click === 'function'
          ) {
            collapseBtn.click();
          }
        }
      } catch {}
    }

    // -------------------------------------------------------------------------
    // Main flow
    // -------------------------------------------------------------------------
    async function run(requestId) {
      try {
        var currentVideoId = parseCurrentVideoId();
        if (!currentVideoId) {
          sendResult(null, null, 'No video ID found in URL/Path', requestId);
          return;
        }
        _devLog('[YouSub] MainWorldExtractor: Video ID:', currentVideoId);

        var metadata = extractVideoMetadata(currentVideoId);
        _devLog('[YouSub] MainWorldExtractor: Metadata:', metadata);

        var hasUsableTracks =
          metadata.tracks &&
          metadata.tracks.length > 0 &&
          metadata.tracks.some(function (t) {
            return t.baseUrl;
          });
        if (!hasUsableTracks) {
          _devLog(
            '[YouSub] MainWorldExtractor: No usable tracks from metadata. Trying Innertube API...'
          );
          var innertubeResult = await fetchTracksViaInnertube(currentVideoId);
          if (innertubeResult.tracks && innertubeResult.tracks.length > 0) {
            metadata.tracks = innertubeResult.tracks;
            _devLog(
              '[YouSub] MainWorldExtractor: Innertube provided',
              metadata.tracks.length,
              'tracks.'
            );
          }
          if (innertubeResult.isLive) metadata.isLive = true;
        }

        if (metadata.isLive) {
          _devWarn('[YouSub] MainWorldExtractor: Video is LIVE. Stopping.');
          sendResult(metadata.tracks, null, 'LIVE_STREAM_DETECTED', requestId);
          return;
        }

        var isShorts = window.location.pathname.startsWith('/shorts/');
        var hasNoTracksConfirmed = !metadata.tracks || metadata.tracks.length === 0;

        // Step 1: Reuse already-open transcript segments immediately without touching UI
        var existingHit = findExistingSegments();
        if (existingHit && existingHit.segments.length > 0) {
          _devLog('[YouSub] MainWorldExtractor: Transcript already open. Using existing segments.');
          var existingEntries = parseTranscriptSegments(existingHit.segments);
          if (existingEntries.length > 0) {
            sendResult(metadata.tracks, existingEntries, null, requestId);
            return;
          }
        }

        // Step 2: Silent Innertube API FIRST — never pops open the Transcript sidebar
        if (isShorts || !hasNoTracksConfirmed) {
          _devLog('[YouSub] MainWorldExtractor: Trying silent Innertube transcript fetch...');
          var panelEntries = await fetchTranscriptViaGetPanel(currentVideoId);
          if (panelEntries && panelEntries.length > 0) {
            sendResult(metadata.tracks, panelEntries, null, requestId);
            _devLog(
              '[YouSub] MainWorldExtractor: SUCCESS via silent Innertube. Entries:',
              panelEntries.length
            );
            return;
          }
        }

        // Step 3: DOM fallback (Watch only unless a transcript button is already visible),
        // then immediately close the panel so it does not stay open on screen.
        var btn = findTranscriptButton();
        var skipSlowWatchDomProbe = isShorts || (hasNoTracksConfirmed && !btn);
        var expandedByUs = false;

        if (!btn && !skipSlowWatchDomProbe) {
          expandedByUs = await expandDescription();
          if (expandedByUs) {
            await wait(800);
            btn = findTranscriptButton();
          }
        }

        if (btn) {
          _devLog('[YouSub] MainWorldExtractor: Clicking transcript button (DOM fallback)...');
          var segments = null;
          try {
            btn.click();
            segments = await waitForSegments(10000);
            if (segments && segments.length > 0) {
              var entries = parseTranscriptSegments(segments);
              _devLog(
                '[YouSub] MainWorldExtractor: Parsed',
                entries.length,
                'entries from transcript DOM.'
              );
              if (entries.length > 0) {
                sendResult(metadata.tracks, entries, null, requestId);
                _devLog(
                  '[YouSub] MainWorldExtractor: SUCCESS via Transcript DOM. Entries:',
                  entries.length
                );
                return;
              }
            }
          } finally {
            closeTranscriptPanel(expandedByUs);
          }
        } else {
          if (expandedByUs) closeTranscriptPanel(true);
          _devWarn('[YouSub] MainWorldExtractor: Transcript button not found.');
        }

        // ================================================================
        // FALLBACK: Report failure with track info
        // ================================================================
        if (metadata.tracks && metadata.tracks.length > 0) {
          sendResult(
            metadata.tracks,
            null,
            'Transcript button not found or segments empty. Tracks available but pot token required for fetch.',
            requestId
          );
        } else {
          sendResult(null, null, 'No transcript button and no caption tracks found.', requestId);
        }
      } catch (e) {
        console.error('[YouSub] MainWorldExtractor: Error:', e.message, e.stack);
        sendResult(null, null, 'Exception: ' + e.message, requestId);
      }
    }

    window.addEventListener('message', function (event) {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'YOUSUB_EXTRACT_CAPTIONS') return;
      run(event.data.requestId);
    });
  } catch (globalErr) {
    console.error('[YouSub] MainWorldExtractor Fatal Crash:', globalErr);
  }
})();
