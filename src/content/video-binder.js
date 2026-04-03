(function () {
  'use strict';
  var YouSub = window.YouSub || (window.YouSub = {});

  var videoElement = null;
  var observer = null;
  var timeoutId = null;
  var boundCallback = null;

  var TIMEOUT_MS = 10000; // 10 seconds max wait
  var VIDEO_SELECTORS = [
    'video.html5-main-video',
    '#movie_player video',
    'video'
  ];

  /**
   * Try to find the video element using a list of selectors.
   * @returns {HTMLVideoElement|null}
   */
  function findVideoElement() {
    for (var i = 0; i < VIDEO_SELECTORS.length; i++) {
      var el = document.querySelector(VIDEO_SELECTORS[i]);
      if (el && el.tagName === 'VIDEO') {
        return el;
      }
    }
    return null;
  }

  /**
   * Called when the video element is successfully found.
   * Cleans up observer and timeout, then calls the bound callback.
   * @param {HTMLVideoElement} video
   */
  function onVideoFound(video) {
    // Clean up observer and timeout
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    videoElement = video;
    console.log('[YouSub] VideoBinder: Video element found. Duration:', video.duration, 'ReadyState:', video.readyState);

    if (boundCallback) {
      boundCallback(video);
    }
  }

  /**
   * Start watching for the video element via MutationObserver.
   */
  function startObserver() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(function () {
      var video = findVideoElement();
      if (video) {
        onVideoFound(video);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Safety timeout — if video never appears, log error and give up
    timeoutId = setTimeout(function () {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      timeoutId = null;
      console.error('[YouSub] VideoBinder: Timed out waiting for video element after', TIMEOUT_MS, 'ms.');
    }, TIMEOUT_MS);
  }

  YouSub.VideoBinder = {
    /**
     * Attempt to find and bind to the <video> element.
     * If not immediately available, uses MutationObserver as fallback.
     * @param {function(HTMLVideoElement)} onBound - Called when video element is ready.
     */
    bind: function (onBound) {
      // Clean up any previous binding first
      this.unbind();

      boundCallback = onBound || null;

      // Try to find it immediately
      var video = findVideoElement();
      if (video) {
        onVideoFound(video);
        return;
      }

      // Not found — start observing DOM mutations
      console.log('[YouSub] VideoBinder: Video element not found immediately, starting MutationObserver...');
      startObserver();
    },

    /**
     * Clean up: disconnect observer, clear timeout, release video reference.
     */
    unbind: function () {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      videoElement = null;
      boundCallback = null;
      console.log('[YouSub] VideoBinder: Unbound.');
    },

    /**
     * Get the currently bound video element.
     * @returns {HTMLVideoElement|null}
     */
    getVideo: function () {
      return videoElement;
    }
  };
})();
