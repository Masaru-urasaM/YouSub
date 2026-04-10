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

  var videoId = new URLSearchParams(window.location.search).get('v');
  if (!videoId) {
    sendResult(null, null, 'No video ID found in URL');
    return;
  }

  console.log('[YouSub] MainWorldExtractor: Video ID:', videoId);

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
    // Strategy A: Look for button in the description section
    var descSection = document.querySelector('ytd-video-description-transcript-section-renderer');
    if (descSection) {
      var btn = descSection.querySelector('button');
      if (btn) {
        console.log('[YouSub] MainWorldExtractor: Found transcript button in description section.');
        return btn;
      }
    }

    // Strategy B: Search by aria-label
    var ariaBtn = document.querySelector('button[aria-label="Show transcript"]');
    if (ariaBtn) {
      console.log('[YouSub] MainWorldExtractor: Found transcript button by aria-label.');
      return ariaBtn;
    }

    // Strategy C: Search all buttons/renderers for text content
    var allButtons = document.querySelectorAll('ytd-button-renderer, tp-yt-paper-button, button');
    for (var i = 0; i < allButtons.length; i++) {
      var text = allButtons[i].textContent.trim().toLowerCase();
      if (text === 'show transcript' || text === 'transcript') {
        console.log('[YouSub] MainWorldExtractor: Found transcript button by text search.');
        return allButtons[i];
      }
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Step 1b: Try to expand description to reveal transcript button
  // -------------------------------------------------------------------------
  function expandDescription() {
    // Click "...more" to expand description
    var moreBtn = document.querySelector('tp-yt-paper-button#expand');
    if (moreBtn) {
      moreBtn.click();
      console.log('[YouSub] MainWorldExtractor: Expanded description.');
      return true;
    }

    // Alternative: look for the expand button by aria-label
    var expandBtn = document.querySelector('#description-inline-expander tp-yt-paper-button');
    if (expandBtn) {
      expandBtn.click();
      console.log('[YouSub] MainWorldExtractor: Expanded description (alt).');
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
            console.log('[YouSub] MainWorldExtractor: Found', segments.length, 'segments with selector:', selectors[s]);
            resolve(segments);
            return;
          }
        }

        // Diagnostic: log what's in the transcript panel (once)
        if (!loggedOnce && elapsed >= 2000) {
          loggedOnce = true;

          // Check if engagement panel exists
          var panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
          console.log('[YouSub] DIAGNOSTIC: Found', panels.length, 'engagement panels.');
          panels.forEach(function (p, i) {
            var targetId = p.getAttribute('target-id') || 'no-target-id';
            var visibility = p.getAttribute('visibility') || 'no-visibility';
            console.log('[YouSub] DIAGNOSTIC: Panel[' + i + '] target-id=' + targetId + ' visibility=' + visibility);

            // Log child tag names (first 2 levels)
            if (targetId.indexOf('transcript') !== -1 || visibility.indexOf('EXPANDED') !== -1) {
              var children = p.querySelectorAll('*');
              var tags = {};
              children.forEach(function (c) {
                var tag = c.tagName.toLowerCase();
                tags[tag] = (tags[tag] || 0) + 1;
              });
              console.log('[YouSub] DIAGNOSTIC: Panel[' + i + '] child tags:', JSON.stringify(tags));
            }
          });

          // Also check for transcript renderer directly
          var transcriptRenderer = document.querySelector('ytd-transcript-renderer');
          if (transcriptRenderer) {
            console.log('[YouSub] DIAGNOSTIC: ytd-transcript-renderer found! innerHTML length:', transcriptRenderer.innerHTML.length);
            console.log('[YouSub] DIAGNOSTIC: First 500 chars:', transcriptRenderer.innerHTML.substring(0, 500));
          } else {
            console.log('[YouSub] DIAGNOSTIC: ytd-transcript-renderer NOT found in DOM.');
          }
        }

        elapsed += interval;
        if (elapsed >= timeoutMs) {
          console.warn('[YouSub] MainWorldExtractor: Timeout waiting for transcript segments after', timeoutMs, 'ms.');
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
        // The new layout often uses specific classes for timestamp and formatted string
        var tsEl = host.querySelector('.segment-timestamp, [class*="timestamp"]');
        var txtEl = host.querySelector('.segment-text, [class*="segment-text"], yt-formatted-string');
        
        if (tsEl) timestampText = tsEl.innerText || tsEl.textContent;
        if (txtEl) textContent = txtEl.innerText || txtEl.textContent;
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
      console.log('[YouSub] MainWorldExtractor: Closed transcript panel.');
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
          console.log('[YouSub] MainWorldExtractor: Closed transcript panel (method 2).');
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

    var sources = [null, null];
    var player = document.getElementById('movie_player');
    if (player && typeof player.getPlayerResponse === 'function') {
      try { sources[0] = player.getPlayerResponse(); } catch (e) {}
    }
    sources[1] = window.ytInitialPlayerResponse;

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
              isAutoGenerated: t.kind === 'asr',
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
  // Main flow
  // -------------------------------------------------------------------------
  async function run() {
    try {
      var metadata = extractVideoMetadata();
      console.log('[YouSub] MainWorldExtractor: Metadata:', metadata);

      if (metadata.isLive) {
        console.warn('[YouSub] MainWorldExtractor: Video is LIVE. Stopping.');
        sendResult(metadata.tracks, null, 'LIVE_STREAM_DETECTED');
        return;
      }

      // Step 1: Pre-check if transcript is already open
      var segments = await waitForSegments(100);
      if (segments && segments.length > 0) {
        console.log('[YouSub] MainWorldExtractor: Transcript already open. Using existing segments.');
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
          console.log('[YouSub] MainWorldExtractor: Clicking transcript button...');
          btn.click();

          // Step 2: Wait for segments to render
          segments = await waitForSegments(10000);
        } else {
          console.warn('[YouSub] MainWorldExtractor: Transcript button not found.');
        }
      }

      if (segments && segments.length > 0) {
        // Step 3: Parse segments
        var entries = parseTranscriptSegments(segments);
        console.log('[YouSub] MainWorldExtractor: Parsed', entries.length, 'entries from transcript DOM.');

        if (entries.length > 0) {
          console.log('[YouSub] MainWorldExtractor: Sample [0]:', JSON.stringify(entries[0]));
          console.log('[YouSub] MainWorldExtractor: Sample [last]:', JSON.stringify(entries[entries.length - 1]));
        }

        // Send result
        sendResult(metadata.tracks, entries, null);
        console.log('[YouSub] MainWorldExtractor: SUCCESS via Transcript DOM. Entries:', entries.length);
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
})();
