import { devLog } from '../shared/constants.js';

let currentVideoId = null;
let onEnterCallback = null;
let onLeaveCallback = null;

/**
 * Check the current page state and fire appropriate callbacks.
 * Detects watch pages, extracts video ID, and handles transitions.
 */
function checkPage() {
  const pathname = window.location.pathname;
  const isWatchPage = pathname === '/watch';
  const isShortsPage = pathname.startsWith('/shorts/');
  
  let videoId = null;
  if (isWatchPage) {
    videoId = new URLSearchParams(window.location.search).get('v');
  } else if (isShortsPage) {
    const parts = pathname.split('/');
    videoId = parts[2];
  }

  if ((isWatchPage || isShortsPage) && videoId && videoId !== currentVideoId) {
    if (currentVideoId) {
      if (onLeaveCallback) onLeaveCallback();
    }
    currentVideoId = videoId;
    devLog('[YouSub] PageDetector: ' + (isShortsPage ? 'Shorts' : 'Watch') + ' page detected. Video ID:', videoId);
    if (onEnterCallback) onEnterCallback(videoId);
  } else if (!isWatchPage && !isShortsPage && currentVideoId) {
    devLog('[YouSub] PageDetector: Left video page.');
    if (onLeaveCallback) onLeaveCallback();
    currentVideoId = null;
  }
}

export const PageDetector = {
  /**
   * Initialize the page detector.
   * @param {function(string)} onEnter - Called when a watch page is entered, receives videoId.
   * @param {function()} onLeave - Called when a watch page is left.
   */
  init: function (onEnter, onLeave) {
    onEnterCallback = onEnter;
    onLeaveCallback = onLeave;

    devLog('[YouSub] PageDetector: Initializing and checking current page...');
    
    // Add listener for future navigations
    document.addEventListener('yt-navigate-finish', checkPage);
    
    // Run immediate check for the current page
    checkPage();

    devLog('[YouSub] PageDetector initialized (ESM).');
  },

  /**
   * Clean up event listeners and reset state.
   */
  destroy: function () {
    document.removeEventListener('yt-navigate-finish', checkPage);
    currentVideoId = null;
    onEnterCallback = null;
    onLeaveCallback = null;
    devLog('[YouSub] PageDetector destroyed.');
  },

  /**
   * Get the currently tracked video ID.
   * @returns {string|null}
   */
  getCurrentVideoId: function () {
    return currentVideoId;
  }
};

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.PageDetector = PageDetector;
}
