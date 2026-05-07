/**
 * main-world-extractor.js — Runs in the MAIN world (YouTube page context)
 *
 * PRIMARY STRATEGY: Open the Transcript panel, scrape subtitle data from DOM.
 * This bypasses all pot/token/auth issues because YouTube handles auth internally.
 *
 * Flow:
 *  1. Find "Show transcript" button
 *  2. Click it to open the transcript panel
 *  3. Wait for transcript segments to render
 *  4. Parse timestamp + text from each segment
 *  5. Close the panel
 *  6. Send parsed entries to content script
 */
(function () {
  'use strict';

  try {
    // -------------------------------------------------------------------------
    // Phase 50.6: Trusted Types Bypass & Safety
    // -------------------------------------------------------------------------
    var policy = null;
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      try {
        policy = window.trustedTypes.createPolicy('yousub-extractor-policy', {
          createHTML: function(html) { return html; },
          createScript: function(s) { return s; },
          createScriptURL: function(u) { return u; }
        });
      } catch (e) {}
    }

    function setSafeHTML(el, html) {
      if (!el) return;
      if (policy && policy.createHTML) {
        el.innerHTML = policy.createHTML(html);
      } else {
        el.innerHTML = html;
      }
    }

    var _isProd = window.YouSub && window.YouSub.Constants && window.YouSub.Constants.IS_PRODUCTION;
    function _devLog() { if (!_isProd) console.log.apply(console, arguments); }
    function _devWarn() { if (!_isProd) console.warn.apply(console, arguments); }

    var videoId = new URLSearchParams(window.location.search).get('v');
    if (!videoId && window.location.pathname.startsWith('/shorts/')) {
      videoId = window.location.pathname.split('/')[2];
    }

    if (!videoId) {
      sendResult(null, null, 'No video ID found in URL/Path');
      return;
    }

    _devLog('[YouSub] MainWorldExtractor: Video ID:', videoId);

  // -------------------------------------------------------------------------
  // Utility: Send result back to content script
  // -------------------------------------------------------------------------
  function sendResult(tracks, parsedEntries, error) {
    window.postMessage({
      type: 'YOUSUB_CAPTION_TRACKS',
      tracks: tracks,
      parsedEntries: parsedEntries,
      error: error
    }, '*');
  }

  // -------------------------------------------------------------------------
  // Utility: Wait for a duration
  // -------------------------------------------------------------------------
  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // -------------------------------------------------------------------------
  // Utility: Parse timestamp "M:SS" or "H:MM:SS" to milliseconds
  // -------------------------------------------------------------------------
  function parseTimestamp(str) {
    var parts = str.trim().split(':').map(Number);
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

  // -------------------------------------------------------------------------
  // Step 1: Find the "Show transcript" button
  // -------------------------------------------------------------------------
  function findTranscriptButton() {
    var isShorts = window.location.pathname.startsWith('/shorts/');

    // Strategy A: Look for button in the description section (Regular Video)
    if (!isShorts) {
      var descSection = document.querySelector('ytd-video-description-transcript-section-renderer');
      if (descSection) {
        var btn = descSection.querySelector('button');
        if (btn) {
          _devLog('[YouSub] MainWorldExtractor: Found transcript button in description section.');
          return btn;
        }
      }
    }

    // Strategy B: Search by aria-label
    var ariaBtn = document.querySelector('button[aria-label="Show transcript"]');
    if (ariaBtn) {
      _devLog('[YouSub] MainWorldExtractor: Found transcript button by aria-label.');
      return ariaBtn;
    }

    // Strategy C: Shorts-specific search in Active Reel
    if (isShorts) {
      // On Shorts, the transcript button is often inside the Description overlay
      var shortsDesc = document.querySelector('ytd-reel-video-renderer[is-active] ytd-structured-description-content-renderer');
      if (shortsDesc) {
        var shortsBtn = shortsDesc.querySelector('ytd-video-description-transcript-section-renderer button, button[aria-label*="transcript" i]');
        if (shortsBtn) {
          _devLog('[YouSub] MainWorldExtractor: Found transcript button in Shorts description.');
          return shortsBtn;
        }
      }
    }

    // Strategy D: Search all buttons/renderers for text content
    var allButtons = document.querySelectorAll('ytd-button-renderer, tp-yt-paper-button, button, ytd-menu-service-item-renderer');
    for (var i = 0; i < allButtons.length; i++) {
      var text = allButtons[i].textContent.trim().toLowerCase();
      if (text === 'show transcript' || text === 'transcript') {
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
      var moreBtn = document.querySelector('ytd-reel-video-renderer[is-active] #menu.ytd-reel-video-renderer button');
      if (moreBtn) {
        _devLog('[YouSub] MainWorldExtractor: Clicking Shorts "More actions" menu...');
        moreBtn.click();
        await wait(500);

        // Step 2: Find "Description" in the menu
        var menuItems = document.querySelectorAll('ytd-menu-service-item-renderer');
        for (var i = 0; i < menuItems.length; i++) {
          var text = menuItems[i].textContent.toLowerCase();
          // Phase 50.6: Support Vietnamese localization
          if (text.includes('description') || text.includes('mô tả')) {
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
    var moreBtn = document.querySelector('tp-yt-paper-button#expand');
    if (moreBtn) {
      moreBtn.click();
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
  function waitForSegments(timeoutMs) {
    return new Promise(function (resolve) {
      var elapsed = 0;
      var interval = 300;
      var loggedOnce = false;

      function check() {
        // Try multiple selectors for transcript segments
        var selectors = [
          'transcript-segment-view-model', // New YouTube layout
          'ytd-transcript-segment-renderer', // Old layout
          'ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer',
          '[target-id="PAmodern_transcript_view"] transcript-segment-view-model',
          '[target-id="engagement-panel-searchable-transcript"] ytd-transcript-segment-renderer',
          'ytd-transcript-renderer [class*="segment"]',
          'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"] [class*="segment"]'
        ];

        for (var s = 0; s < selectors.length; s++) {
          var segments = document.querySelectorAll(selectors[s]);
          if (segments.length > 0) {
            _devLog('[YouSub] MainWorldExtractor: Found', segments.length, 'segments with selector:', selectors[s]);
            resolve(segments);
            return;
          }
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
            _devLog('[YouSub] DIAGNOSTIC: Panel[' + i + '] target-id=' + targetId + ' visibility=' + visibility);

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
          _devLog('[YouSub] MainWorldExtractor: Timeout waiting for transcript segments after', timeoutMs, 'ms.');
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
      if (seg.tagName.toLowerCase() === 'transcript-segment-view-model' || seg.querySelector('transcript-segment-view-model')) {
        var host = seg.tagName.toLowerCase() === 'transcript-segment-view-model' ? seg : seg.querySelector('transcript-segment-view-model');
        // Phase 53.2: Null guard — DOM may change between check and assignment
        if (host) {
          var tsEl = host.querySelector('.segment-timestamp, [class*="timestamp"]');
          var txtEl = host.querySelector('.segment-text, [class*="segment-text"], yt-formatted-string');

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
          var timestampEl = seg.querySelector('.segment-timestamp, [class*="timestamp"], div.segment-start-offset');
          var textEl = seg.querySelector('.segment-text, yt-formatted-string.segment-text, [class*="segment-text"]');
          
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
           entries.push({ startMs: startMs, endMs: 0, text: textContent.replace(/\n/g, ' ').trim() });
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
  // Step 4: Close the transcript panel
  // -------------------------------------------------------------------------
  function closeTranscriptPanel() {
    // Method 1: Click the close button on the engagement panel
    var closeBtn = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #visibility-button button'
    );
    if (closeBtn) {
      closeBtn.click();
      _devLog('[YouSub] MainWorldExtractor: Closed transcript panel.');
      return;
    }

    // Method 2: Try generic close button
    var panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
    for (var i = 0; i < panels.length; i++) {
      var panel = panels[i];
      if (panel.querySelector('ytd-transcript-renderer')) {
        var close = panel.querySelector('#visibility-button button, tp-yt-icon-button#visibility-button');
        if (close) {
          close.click();
          _devLog('[YouSub] MainWorldExtractor: Closed transcript panel (method 2).');
          return;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fallback: Extract track info and video metadata from page
  // -------------------------------------------------------------------------
  function extractVideoMetadata() {
    var data = {
      tracks: null,
      isLive: false,
      title: document.title
    };

    var sources = [];
    // 1. Try movie_player.getPlayerResponse()
    var player = document.getElementById('movie_player');
    if (player && typeof player.getPlayerResponse === 'function') {
      try { sources.push(player.getPlayerResponse()); } catch (e) {}
    }
    // 2. Try window.ytInitialPlayerResponse
    if (window.ytInitialPlayerResponse) sources.push(window.ytInitialPlayerResponse);
    // 3. Try searching active reel data (Shorts specific)
    try {
      var reel = document.querySelector('ytd-reel-video-renderer[is-active]');
      if (reel && reel.data && reel.data.playerResponse) {
        sources.push(reel.data.playerResponse);
      }
    } catch(e) {}

    for (var s = 0; s < sources.length; s++) {
      var resp = sources[s];
      if (!resp) continue;

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
              isAutoGenerated: (t.kind === 'asr' || !!t.isTranslatable),
              baseUrl: t.baseUrl || ''
            };
          });
        }
      }

      if (data.tracks || data.isLive) break; // Found something
    }

    return data;
  }

  // -------------------------------------------------------------------------
  // Fallback: Fetch caption tracks via YouTube Innertube API
  // Only called when all 3 metadata sources fail to provide tracks.
  // -------------------------------------------------------------------------
  function fetchTracksViaInnertube(vid) {
    return new Promise(function (resolve) {
      try {
        var apiKey = '';
        var clientVersion = '2.20240321.01.00';

        if (window.ytcfg && typeof window.ytcfg.get === 'function') {
          apiKey = window.ytcfg.get('INNERTUBE_API_KEY') || '';
          clientVersion = window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION') || clientVersion;
        }

        var url = 'https://www.youtube.com/youtubei/v1/player';
        if (apiKey) url += '?key=' + encodeURIComponent(apiKey);

        var body = JSON.stringify({
          videoId: vid,
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: clientVersion,
              hl: (navigator.language || 'en').split('-')[0]
            }
          }
        });

        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.timeout = 8000;

        var responded = false;

        xhr.onload = function () {
          if (responded) return;
          responded = true;
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              var resp = JSON.parse(xhr.responseText);
              var result = { tracks: null, isLive: false };

              if (resp.videoDetails && resp.videoDetails.isLive) {
                result.isLive = true;
              }

              if (resp.captions &&
                  resp.captions.playerCaptionsTracklistRenderer &&
                  resp.captions.playerCaptionsTracklistRenderer.captionTracks) {
                result.tracks = resp.captions.playerCaptionsTracklistRenderer.captionTracks.map(function (t) {
                  return {
                    languageCode: t.languageCode || '',
                    languageName: (t.name && t.name.simpleText) || t.languageCode || 'Unknown',
                    isAutoGenerated: (t.kind === 'asr' || !!t.isTranslatable),
                    baseUrl: t.baseUrl || ''
                  };
                });
              }

              resolve(result);
            } catch (parseErr) {
              _devWarn('[YouSub] Innertube: JSON parse error:', parseErr.message);
              resolve({ tracks: null, isLive: false });
            }
          } else {
            _devWarn('[YouSub] Innertube: HTTP', xhr.status);
            resolve({ tracks: null, isLive: false });
          }
        };

        xhr.onerror = function () {
          if (responded) return;
          responded = true;
          _devWarn('[YouSub] Innertube: Network error');
          resolve({ tracks: null, isLive: false });
        };

        xhr.ontimeout = function () {
          if (responded) return;
          responded = true;
          _devWarn('[YouSub] Innertube: Timeout');
          resolve({ tracks: null, isLive: false });
        };

        xhr.send(body);

        setTimeout(function () {
          if (responded) return;
          responded = true;
          _devWarn('[YouSub] Innertube: Safety timeout (12s)');
          try { xhr.abort(); } catch (e) {}
          resolve({ tracks: null, isLive: false });
        }, 12000);

      } catch (e) {
        _devWarn('[YouSub] Innertube: Exception:', e.message);
        resolve({ tracks: null, isLive: false });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Main flow
  // -------------------------------------------------------------------------
  async function run() {
    try {
      var metadata = extractVideoMetadata();
      _devLog('[YouSub] MainWorldExtractor: Metadata:', metadata);

      var hasUsableTracks = metadata.tracks && metadata.tracks.length > 0 &&
        metadata.tracks.some(function (t) { return t.baseUrl; });
      if (!hasUsableTracks) {
        _devLog('[YouSub] MainWorldExtractor: No usable tracks from metadata. Trying Innertube API...');
        var innertubeResult = await fetchTracksViaInnertube(videoId);
        if (innertubeResult.tracks && innertubeResult.tracks.length > 0) {
          metadata.tracks = innertubeResult.tracks;
          _devLog('[YouSub] MainWorldExtractor: Innertube provided', metadata.tracks.length, 'tracks.');
        }
        if (innertubeResult.isLive) metadata.isLive = true;
      }

      if (metadata.isLive) {
        _devWarn('[YouSub] MainWorldExtractor: Video is LIVE. Stopping.');
        sendResult(metadata.tracks, null, 'LIVE_STREAM_DETECTED');
        return;
      }

      // Step 1: Pre-check if transcript is already open
      var segments = await waitForSegments(500);
      if (segments && segments.length > 0) {
        _devLog('[YouSub] MainWorldExtractor: Transcript already open. Using existing segments.');
      } else {
        // Step 1b: Find the transcript button
        var btn = findTranscriptButton();

        if (!btn) {
          // Expand description to reveal button
          expandDescription();
          await wait(800);
          btn = findTranscriptButton();
        }

        if (btn) {
          _devLog('[YouSub] MainWorldExtractor: Clicking transcript button...');
          btn.click();

          // Step 2: Wait for segments to render
          segments = await waitForSegments(10000);
        } else {
          _devWarn('[YouSub] MainWorldExtractor: Transcript button not found.');
        }
      }

      if (segments && segments.length > 0) {
        // Step 3: Parse segments
        var entries = parseTranscriptSegments(segments);
        _devLog('[YouSub] MainWorldExtractor: Parsed', entries.length, 'entries from transcript DOM.');

        if (entries.length > 0) {
          _devLog('[YouSub] MainWorldExtractor: Sample [0]:', JSON.stringify(entries[0]));
          _devLog('[YouSub] MainWorldExtractor: Sample [last]:', JSON.stringify(entries[entries.length - 1]));
        }

        // Send result
        sendResult(metadata.tracks, entries, null);
        _devLog('[YouSub] MainWorldExtractor: SUCCESS via Transcript DOM. Entries:', entries.length);
        return;
      }
 
      // ================================================================
      // FALLBACK: Report failure with track info
      // ================================================================
      if (metadata.tracks && metadata.tracks.length > 0) {
        sendResult(metadata.tracks, null, 'Transcript button not found or segments empty. Tracks available but pot token required for fetch.');
      } else {
        sendResult(null, null, 'No transcript button and no caption tracks found.');
      }

    } catch (e) {
      console.error('[YouSub] MainWorldExtractor: Error:', e.message, e.stack);
      sendResult(null, null, 'Exception: ' + e.message);
    }
  }

    run();
  } catch (globalErr) {
    console.error('[YouSub] MainWorldExtractor Fatal Crash:', globalErr);
  }
})();
