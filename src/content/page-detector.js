(function () {
  'use strict';
  var YouSub = window.YouSub || (window.YouSub = {});

  var currentVideoId = null;
  var onEnterCallback = null;
  var onLeaveCallback = null;

  /**
   * Check the current page state and fire appropriate callbacks.
   * Detects watch pages, extracts video ID, and handles transitions.
   */
  function checkPage() {
    var isWatchPage = window.location.pathname === '/watch';
    var videoId = new URLSearchParams(window.location.search).get('v');

    if (isWatchPage && videoId && videoId !== currentVideoId) {
      // New video detected (or first video)
      if (currentVideoId) {
        // Leaving a previous video — fire leave before entering new one
        if (onLeaveCallback) onLeaveCallback();
      }
      currentVideoId = videoId;
      console.log('[YouSub] PageDetector: Watch page detected. Video ID:', videoId);
      if (onEnterCallback) onEnterCallback(videoId);
    } else if (!isWatchPage && currentVideoId) {
      // Left watch page entirely (home, search, channel, etc.)
      console.log('[YouSub] PageDetector: Left watch page.');
      if (onLeaveCallback) onLeaveCallback();
      currentVideoId = null;
    }
  }

  YouSub.PageDetector = {
    /**
     * Initialize the page detector.
     * @param {function(string)} onEnter - Called when a watch page is entered, receives videoId.
     * @param {function()} onLeave - Called when a watch page is left.
     */
    init: function (onEnter, onLeave) {
      onEnterCallback = onEnter;
      onLeaveCallback = onLeave;

      // Handle SPA navigation (YouTube doesn't do full page reloads)
      document.addEventListener('yt-navigate-finish', checkPage);

      // Handle initial page load (user may have directly opened a watch URL)
      checkPage();

      console.log('[YouSub] PageDetector initialized.');
    },

    /**
     * Clean up event listeners and reset state.
     */
    destroy: function () {
      document.removeEventListener('yt-navigate-finish', checkPage);
      currentVideoId = null;
      onEnterCallback = null;
      onLeaveCallback = null;
      console.log('[YouSub] PageDetector destroyed.');
    },

    /**
     * Get the currently tracked video ID.
     * @returns {string|null}
     */
    getCurrentVideoId: function () {
      return currentVideoId;
    }
  };
})();
