import { devLog } from '../shared/constants.js';

let videoElement = null;
let observer = null;
let timeoutId = null;
let boundCallback = null;
let callbackFired = false; // Phase 53.2: Prevent double invocation

const TIMEOUT_MS = 10000; // 10 seconds max wait
const VIDEO_SELECTORS = [
  'ytd-reel-video-renderer[is-active] video', // Shorts: Active reel video
  'video.html5-main-video', // Regular: Main player video
  '#movie_player video', // Fallback
  'video', // Generic
];

/**
 * Check if an element is visible in the viewport.
 */
function isVisible(el) {
  if (!el) return false;
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

/**
 * Try to find the video element using a list of selectors.
 * @returns {HTMLVideoElement|null}
 */
function findVideoElement() {
  for (let i = 0; i < VIDEO_SELECTORS.length; i++) {
    const el = document.querySelector(VIDEO_SELECTORS[i]);
    if (el && el.tagName === 'VIDEO' && isVisible(el)) {
      return el;
    }
  }

  // Final fallback: search all videos and find the first visible one
  const allVideos = document.querySelectorAll('video');
  for (let j = 0; j < allVideos.length; j++) {
    if (isVisible(allVideos[j])) {
      return allVideos[j];
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
  // Phase 53.2: Prevent double invocation from initial check + observer race
  if (callbackFired) return;
  callbackFired = true;

  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  videoElement = video;
  devLog(
    '[YouSub] VideoBinder: Video element found. Duration:',
    video.duration,
    'ReadyState:',
    video.readyState
  );

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
    try {
      const video = findVideoElement();
      if (video) {
        onVideoFound(video);
      }
    } catch (e) {
      console.error('[YouSub] VideoBinder: Observer callback error:', e);
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  timeoutId = setTimeout(function () {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    timeoutId = null;
    console.error(
      '[YouSub] VideoBinder: Timed out waiting for video element after',
      TIMEOUT_MS,
      'ms.'
    );
  }, TIMEOUT_MS);
}

export const VideoBinder = {
  /**
   * Attempt to find and bind to the <video> element.
   * If not immediately available, uses MutationObserver as fallback.
   * @param {function(HTMLVideoElement)} onBound - Called when video element is ready.
   */
  bind: function (onBound) {
    this.unbind();
    boundCallback = onBound || null;

    const video = findVideoElement();
    if (video) {
      onVideoFound(video);
      return;
    }

    devLog(
      '[YouSub] VideoBinder: Video element not found immediately, starting MutationObserver...'
    );
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
    callbackFired = false;
    devLog('[YouSub] VideoBinder: Unbound.');
  },

  /**
   * Get the currently bound video element.
   * @returns {HTMLVideoElement|null}
   */
  getVideo: function () {
    return videoElement;
  },
};

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.VideoBinder = VideoBinder;
}
