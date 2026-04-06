(function () {
  'use strict';

  var YS = window.YouSub || (window.YouSub = {});

  var subtitles = [];
  var videoElement = null;
  var currentIndex = -1;
  var onTimeUpdateBound = null;
  var isRunning = false;
  var isDualMode = false;

  // Binary search implementation to accurately and efficiently find matching subtitle
  function findSubtitleAt(subs, timeMs) {
    var low = 0;
    var high = subs.length - 1;

    while (low <= high) {
      var mid = Math.floor((low + high) / 2);
      var entry = subs[mid];

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
    if (!isRunning || !videoElement || !subtitles.length || !YS.Overlay) return;
 
    var timeMs = videoElement.currentTime * 1000;
    var foundIndex = -1;
 
    // Optimization: Temporal Locality
    // Check if we are still in the current subtitle
    if (currentIndex !== -1) {
      var current = subtitles[currentIndex];
      if (timeMs >= current.startMs && timeMs < current.endMs) {
        foundIndex = currentIndex;
      } 
      // Check if it's the next subtitle (most common case during playback)
      else if (currentIndex + 1 < subtitles.length) {
        var next = subtitles[currentIndex + 1];
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
        var entry = subtitles[currentIndex];
        YS.Overlay.renderSubtitles(entry.text || entry.original, entry.original, isDualMode);
        YS.Overlay.show();
      } else {
        YS.Overlay.hide();
      }
    }
  }

  YS.SyncEngine = {
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
      browser.storage.local.get(['yousub_dual_mode']).then(function(res) {
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

      if (YS.Overlay) {
        YS.Overlay.hide();
      }
      console.log('[YouSub] SyncEngine: Stopped.');
    },

    setDualMode: function (enabled) {
      isDualMode = enabled;
      // Force refresh current sub
      if (isRunning && currentIndex !== -1) {
        var entry = subtitles[currentIndex];
        YS.Overlay.renderSubtitles(entry.text || entry.original, entry.original, isDualMode);
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
    }
  };

})();
