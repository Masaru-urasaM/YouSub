import { Constants } from '../shared/constants.js';
import { PageDetector } from './page-detector.js';
import { VideoBinder } from './video-binder.js';
import { SubtitleExtractor } from './subtitle-extractor.js';
import { SubtitleParser } from './subtitle-parser.js';
import { Overlay } from './overlay.js';
import { SyncEngine } from './sync-engine.js';

console.log('[YouSub] Main: Module loaded and executing...');

// ---------------------------------------------------------------------------
// Translation helper
// ---------------------------------------------------------------------------

function requestTranslation(parsedEntries, videoId, sourceLang, providedTargetLang) {
  return new Promise(function (resolve) {
    try {
      console.log('[YouSub] Main: requestTranslation called for', parsedEntries.length, 'entries');
      // Enriched data with timestamps
      const segments = parsedEntries.map(function (e) { 
        return { text: e.text, startMs: e.startMs }; 
      });
      const targetLang = providedTargetLang || (typeof Constants !== 'undefined' ? Constants.DEFAULT_TARGET_LANG : 'vi');

      console.log('[YouSub] Main: Sending to background →', targetLang);

      chrome.runtime.sendMessage(
        {
          type: 'YOUSUB_TRANSLATE_REQUEST',
          videoId: videoId,
          segments: segments, // Changed from 'texts' to 'segments'
          sourceLang: sourceLang || 'auto',
          targetLang: targetLang
        },
        function (response) {
          if (chrome.runtime.lastError) {
            console.error('[YouSub] Main: Message error:', chrome.runtime.lastError.message);
            resolve({ success: false, failureReason: 'RUNTIME_ERROR', error: chrome.runtime.lastError.message });
            return;
          }

          if (response && response.success === false) {
            console.error('[YouSub] Main: Failed response:', response.failureReason);
            resolve({ success: false, failureReason: response.failureReason, failures: response.failures });
            return;
          }

          if (response && response.success && Array.isArray(response.translated)) {
            console.log('[YouSub] Main: Success response received');
            const translated = parsedEntries.map(function (entry, i) {
              return {
                startMs: entry.startMs,
                endMs: entry.endMs,
                original: entry.text,
                text: response.translated[i] || entry.text
              };
            });
            resolve({
              success: true,
              translated: translated,
              hadFallback: !!response.hadFallback,
              failureReason: response.failureReason,
              failures: response.failures
            });
            return;
          }

          resolve({ success: false, failureReason: 'UNKNOWN_RESPONSE' });
        }
      );
    } catch (e) {
      console.error('[YouSub] Main: requestTranslation crash:', e);
      resolve({ success: false, failureReason: 'INTERNAL_ERROR', error: e.toString() });
    }
  });
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function processEntries(entries, videoId, targetLang) {
  try {
    console.log('[YouSub] Main: processEntries started. Count:', entries.length);
    if (!entries || entries.length === 0) return;
    
    SyncEngine.stop();
    Overlay.destroy();
    Overlay.setLoading(true);
    Overlay.show();

    const subtitles = entries.map(function(e) {
      return {
        startMs: e.startMs,
        endMs: e.endMs,
        original: e.text,
        text: e.text
      };
    });

    console.log('[YouSub] Main: Starting SyncEngine with original text...');
    VideoBinder.bind(function (video) {
        console.log('[YouSub] Main: Video element available to SyncEngine');
        SyncEngine.start(subtitles, video);
    });

    console.log('[YouSub] Main: Requesting translation from worker...');
    let response = await requestTranslation(entries, videoId, 'auto', targetLang);
    
    if (response.success === false) {
      console.warn('[YouSub] Main: Haling pipeline due to error');
      SyncEngine.stop();
      Overlay.destroy();
      const msg = `<strong>Translation failed:</strong> ${response.failureReason || 'Error'}<br><small>${response.error || ''}</small>`;
      Overlay.showStatus(msg, 'error', 20000);
      Overlay.setLoading(false);
      return;
    }

    if (response.translated && response.translated.length > 0) {
      console.log('[YouSub] Main: Final translated results merging...');
      const statusTitle = response.fromCache ? 'Loaded from cache' : 'Translation complete!';
      const statusType = response.fromCache ? 'info' : 'success';
      Overlay.showStatus(statusTitle, statusType, 2000);
      SyncEngine.updateSubtitles(response.translated);
    }
    Overlay.setLoading(false);
  } catch (err) {
    console.error('[YouSub] Main: processEntries CRITICAL ERROR:', err);
    Overlay.setLoading(false);
  }
}

async function startSubtitlePipeline(videoId, targetLang) {
  console.log('[YouSub] Main: startSubtitlePipeline triggered for:', videoId);
  Overlay.setLoading(true);
  Overlay.show();

  SubtitleExtractor.extract(async function (tracks, parsedEntries, error) {
    console.log('[YouSub] Main: Extractor results received. Entries:', parsedEntries ? parsedEntries.length : 0, 'Error:', error);
    
    if (parsedEntries && parsedEntries.length > 0) {
      await processEntries(parsedEntries, videoId, targetLang);
      return;
    }

    if (!parsedEntries) {
      Overlay.showStatus('Could not find subtitles', 'warning', 4000);
    }
    Overlay.setLoading(false);
  });
}

// Init PageDetector
console.log('[YouSub] Main: Registering PageDetector callbacks...');
PageDetector.init(
  function onEnter(videoId) {
    console.log('[YouSub] Main: ON_ENTER fired for video:', videoId);
    
    Overlay.destroy();

    VideoBinder.bind(function(videoEl) {
      console.log('[YouSub] Main: Video element bound properly. Checking storage...');
      
      chrome.storage.local.get(['yousub_translation_enabled', 'targetLang'], function(res) {
        if (chrome.runtime.lastError) {
          console.error('[YouSub] Main: Storage error:', chrome.runtime.lastError);
          return;
        }
        
        const enabled = res.yousub_translation_enabled;
        const targetLang = res.targetLang || 'vi';
        console.log('[YouSub] Main: Settings result:', { enabled, targetLang });
        
        if (enabled) {
          console.log('[YouSub] Main: Auto-translation is ENABLED. Checking cache...');
          chrome.runtime.sendMessage({
            type: 'YOUSUB_CHECK_CACHE',
            videoId: videoId,
            targetLang: targetLang
          }, function(checkRes) {
            if (chrome.runtime.lastError) {
               console.error('[YouSub] Main: Cache check message error:', chrome.runtime.lastError);
               return;
            }
            if (checkRes && checkRes.exists) {
              console.log('[YouSub] Main: Cache hit. Auto-starting pipeline.');
              startSubtitlePipeline(videoId, targetLang);
            } else {
              console.log('[YouSub] Main: Cache miss or no cache found.');
            }
          });
        } else {
          console.log('[YouSub] Main: Auto-translation is DISABLED.');
        }
      });
    });
  },
  function onLeave() {
    console.log('[YouSub] Main: ON_LEAVE fired.');
    SyncEngine.stop();
    Overlay.destroy();
  }
);

// Listen for translation trigger from popup
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  const currentVideoId = PageDetector.getCurrentVideoId();
  
  if (request.type === 'YOUSUB_START_TRANSLATION' || request.type === 'YOUSUB_TOGGLE_TRANSLATION') {
    console.log('[YouSub] Main: Translation toggle/start received:', request);
    
    if (request.enabled === false) {
      console.log('[YouSub] Main: Disabling translation.');
      SyncEngine.stop();
      Overlay.destroy();
    } else {
      const videoId = request.videoId || currentVideoId;
      if (videoId) {
        console.log('[YouSub] Main: Starting pipeline for', videoId);
        startSubtitlePipeline(videoId, request.targetLang || 'vi');
      } else {
        console.warn('[YouSub] Main: Cannot start translation, no video ID found.');
      }
    }
  }

  if (request.type === 'YOUSUB_TOGGLE_DUAL_MODE') {
    console.log('[YouSub] Main: Dual mode toggle received:', request.enabled);
    SyncEngine.setDualMode(request.enabled);
  }
  
  if (request.type === 'YOUSUB_CACHE_CLEARED' || request.type === 'YOUSUB_CLEAR_VIDEO_CACHE') {
    console.log('[YouSub] Main: Cache cleared message received.');
    SyncEngine.stop();
    Overlay.destroy();
  }
  
  // Return true if we want to send a response asynchronously (though not needed here)
  return false; 
});
