(function () {
  'use strict';
  var YS = window.YouSub || (window.YouSub = {});

  // ---------------------------------------------------------------------------
  // Translation helper
  // ---------------------------------------------------------------------------

  /**
   * Send subtitle texts to background worker for translation.
   */
  function requestTranslation(parsedEntries, sourceLang) {
    return new Promise(function (resolve) {
      var texts = parsedEntries.map(function (e) { return e.text; });
      var targetLang = YS.Constants ? YS.Constants.DEFAULT_TARGET_LANG : 'vi';

      console.log('[YouSub] Main: Sending', texts.length, 'entries for translation →', targetLang);

      chrome.runtime.sendMessage(
        {
          action: 'YOUSUB_TRANSLATE_REQUEST',
          texts: texts,
          sourceLang: sourceLang || 'auto',
          targetLang: targetLang
        },
        function (response) {
          if (chrome.runtime.lastError) {
            console.error('[YouSub] Main: Translation message error:', chrome.runtime.lastError.message);
            resolve(parsedEntries);
            return;
          }

          if (response && response.success && Array.isArray(response.translated)) {
            var translated = parsedEntries.map(function (entry, i) {
              return {
                startMs: entry.startMs,
                endMs: entry.endMs,
                text: response.translated[i] || entry.text
              };
            });
            console.log('[YouSub] Main: Translation complete.');
            resolve(translated);
          } else {
            console.warn('[YouSub] Main: Translation failed:', response && response.error);
            resolve(parsedEntries);
          }
        }
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Main flow
  // ---------------------------------------------------------------------------

  YS.PageDetector.init(function onEnter(videoId) {
    console.log('[YouSub] Video page entered. Video ID:', videoId);

    YS.VideoBinder.bind(function onBound(video) {
      console.log('[YouSub] Video element bound. Waiting for user to click extension popup.');
    });
  }, function onLeave() {
    console.log('[YouSub] Main: Video page left — cleanup.');
    YS._lastSubtitles = null;
    YS.VideoBinder.unbind();
    YS.SubtitleExtractor.destroy();
  });

  // Listen for popup trigger
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.action === 'YOUSUB_START_EXTRACTION') {
      console.log('[YouSub] Main: Received START command from popup. Target lang:', message.targetLang);
      sendResponse({ started: true });

      // Update constants temporarily for this run if needed
      if (YS.Constants) {
        YS.Constants.DEFAULT_TARGET_LANG = message.targetLang;
      }

      YS.SubtitleExtractor.extract(function (tracks, parsedEntries, error) {

        // =================================================================
        // Case 1: parsedEntries available (from Transcript DOM scraping)
        // =================================================================
        if (parsedEntries && parsedEntries.length > 0) {
          console.log('[YouSub] Main: Got', parsedEntries.length, 'entries from transcript DOM.');
          
          var sourceLang = 'en';
          if (tracks && tracks.length > 0) {
            sourceLang = tracks[0].languageCode || 'en';
          }

          (async function () {
            try {
              var translatedEntries = await requestTranslation(parsedEntries, sourceLang);
              YS._lastSubtitles = translatedEntries;
              console.log('[YouSub] Main: Translation pipeline COMPLETE!', translatedEntries.length, 'subtitles ready.');
            } catch (e) {
              console.error('[YouSub] Main: Pipeline error:', e);
            }
          })();
          return;
        }

        // =================================================================
        // Case 2: No parsed entries
        // =================================================================
        if (!tracks || tracks.length === 0) {
          console.warn('[YouSub] Main: No subtitle tracks found for this video.');
          return;
        }
        console.warn('[YouSub] Main: Error getting DOM entries:', error);
      });
      return true; // Keep channel open
    }
  });

  console.log('[YouSub] Content Script main module loaded.');
})();
