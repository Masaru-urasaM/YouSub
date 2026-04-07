import { Overlay } from './overlay.js';

let subtitles = [];
let videoElement = null;
let currentIndex = -1;
let onTimeUpdateBound = null;
let isRunning = false;
let isDualMode = false;

// Binary search implementation to accurately and efficiently find matching subtitle
function findSubtitleAt(subs, timeMs) {
  let low = 0;
  let high = subs.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const entry = subs[mid];

    if (timeMs < entry.startMs) {
      high = mid - 1;
    } else if (timeMs >= entry.endMs) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

function onTimeUpdate() {
  if (!isRunning || !videoElement || !subtitles.length) return;

  const timeMs = videoElement.currentTime * 1000;
  let foundIndex = -1;

  // Optimization: Temporal Locality
  // Check if we are still in the current subtitle
  if (currentIndex !== -1) {
    const current = subtitles[currentIndex];
    if (timeMs >= current.startMs && timeMs < current.endMs) {
      foundIndex = currentIndex;
    } 
    // Check if it's the next subtitle (most common case during playback)
    else if (currentIndex + 1 < subtitles.length) {
      const next = subtitles[currentIndex + 1];
      if (timeMs >= next.startMs && timeMs < next.endMs) {
        foundIndex = currentIndex + 1;
      }
    }
  }

  // Fallback to Binary Search if temporal locality failed
  if (foundIndex === -1) {
    foundIndex = findSubtitleAt(subtitles, timeMs);
  }

  if (foundIndex !== currentIndex) {
    currentIndex = foundIndex;
    if (currentIndex !== -1) {
      const entry = subtitles[currentIndex];
      Overlay.renderSubtitles(entry.text || entry.original, entry.original, isDualMode);
      Overlay.show();
    } else {
      Overlay.hide();
    }
  }
}

export const SyncEngine = {
  start: function (subs, video) {
    this.stop(); 

    subtitles = subs || [];
    videoElement = video;
    currentIndex = -1;

    if (!subtitles.length || !videoElement) {
      console.warn('[YouSub] SyncEngine: Missing subtitles or video element.');
      return;
    }

    // Load Dual Mode preference
    chrome.storage.local.get(['yousub_dual_mode']).then(function(res) {
      isDualMode = !!res.yousub_dual_mode;
      
      onTimeUpdateBound = onTimeUpdate.bind(this);
      videoElement.addEventListener('timeupdate', onTimeUpdateBound);
      isRunning = true;
      console.log('[YouSub] SyncEngine: Started (Dual Mode: ' + isDualMode + ')');

      // Force initial render in case video is currently paused
      onTimeUpdateBound();
    });
  },

  stop: function () {
    isRunning = false;
    if (videoElement && onTimeUpdateBound) {
      videoElement.removeEventListener('timeupdate', onTimeUpdateBound);
    }
    subtitles = [];
    videoElement = null;
    currentIndex = -1;
    onTimeUpdateBound = null;

    Overlay.hide();
    console.log('[YouSub] SyncEngine: Stopped.');
  },

  setDualMode: function (enabled) {
    isDualMode = enabled;
    if (isRunning && currentIndex !== -1) {
      const entry = subtitles[currentIndex];
      Overlay.renderSubtitles(entry.text || entry.original, entry.original, isDualMode);
    }
  },

  pause: function () {
    isRunning = false;
  },

  resume: function () {
    isRunning = true;
    if (onTimeUpdateBound) {
      onTimeUpdateBound();
    }
  },

  /**
   * Update the subtitle data for a full result (Phase 35).
   */
  updateSubtitles: function (newSubs) {
    subtitles = newSubs || [];
    console.log('[YouSub] SyncEngine: Full subtitles updated. Count: ' + subtitles.length);
    if (isRunning && onTimeUpdateBound) {
      onTimeUpdateBound();
    }
  },

  /**
   * Update a specific batch of subtitles (Phase 35.7).
   * @param {Array} batch New translated strings
   * @param {number} startIndex Starting index in the master array
   */
  updatePartial: function (batch, startIndex) {
    if (!subtitles.length || !Array.isArray(batch)) return;

    for (let i = 0; i < batch.length; i++) {
        const globalIndex = startIndex + i;
        if (subtitles[globalIndex]) {
            subtitles[globalIndex].text = batch[i];
        }
    }
    
    console.log(`[YouSub] SyncEngine: Merged partial batch of ${batch.length} at index ${startIndex}`);
    
    if (isRunning && onTimeUpdateBound) {
      onTimeUpdateBound();
    }
  }
};

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.SyncEngine = SyncEngine;
}
