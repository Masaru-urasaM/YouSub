import { devLog } from '../shared/constants.js';

let currentVideoId = null;
let onEnterCallback = null;
let onLeaveCallback = null;
let isInitialized = false;
let urlPollInterval = null;
let lastCheckedHref = '';

function parseVideoIdFromLocation() {
  const pathname = window.location.pathname;
  if (pathname === '/watch') {
    return new URLSearchParams(window.location.search).get('v') || null;
  }
  if (pathname.startsWith('/shorts/')) {
    return pathname.split('/')[2] || null;
  }
  return null;
}

/**
 * Check the current page state and fire appropriate callbacks.
 * Detects watch pages, extracts video ID, and handles transitions.
 */
function checkPage() {
  const pathname = window.location.pathname;
  const isWatchPage = pathname === '/watch';
  const isShortsPage = pathname.startsWith('/shorts/');
  const videoId = parseVideoIdFromLocation();

  if ((isWatchPage || isShortsPage) && videoId && videoId !== currentVideoId) {
    if (currentVideoId) {
      if (onLeaveCallback) onLeaveCallback();
    }
    currentVideoId = videoId;
    devLog(
      '[YouSub] PageDetector: ' + (isShortsPage ? 'Shorts' : 'Watch') + ' page detected. Video ID:',
      videoId
    );
    if (onEnterCallback) onEnterCallback(videoId);
  } else if (!isWatchPage && !isShortsPage && currentVideoId) {
    devLog('[YouSub] PageDetector: Left video page.');
    if (onLeaveCallback) onLeaveCallback();
    currentVideoId = null;
  }
}

function handlePotentialNavigation() {
  lastCheckedHref = window.location.href;
  checkPage();
}

export const PageDetector = {
  /**
   * Initialize the page detector.
   * @param {function(string)} onEnter - Called when a watch page is entered, receives videoId.
   * @param {function()} onLeave - Called when a watch page is left.
   */
  init: function (onEnter, onLeave) {
    this.destroy();
    isInitialized = true;
    onEnterCallback = onEnter;
    onLeaveCallback = onLeave;
    lastCheckedHref = window.location.href;

    devLog('[YouSub] PageDetector: Initializing and checking current page...');

    // Desktop Polymer & Mobile Web (m.youtube.com) SPA navigation hooks
    document.addEventListener('yt-navigate-finish', handlePotentialNavigation);
    document.addEventListener('yt-page-data-updated', handlePotentialNavigation);
    window.addEventListener('popstate', handlePotentialNavigation);
    window.addEventListener('state-navigateend', handlePotentialNavigation);

    // Lightweight URL poller as reliable backstop for History pushState on m.youtube.com
    urlPollInterval = setInterval(function () {
      if (window.location.href !== lastCheckedHref) {
        handlePotentialNavigation();
      }
    }, 1000);

    // Run immediate check for the current page
    checkPage();

    devLog('[YouSub] PageDetector initialized (ESM).');
  },

  /**
   * Clean up event listeners and reset state.
   */
  destroy: function () {
    document.removeEventListener('yt-navigate-finish', handlePotentialNavigation);
    document.removeEventListener('yt-page-data-updated', handlePotentialNavigation);
    window.removeEventListener('popstate', handlePotentialNavigation);
    window.removeEventListener('state-navigateend', handlePotentialNavigation);
    if (urlPollInterval) {
      clearInterval(urlPollInterval);
      urlPollInterval = null;
    }
    lastCheckedHref = '';
    isInitialized = false;
    currentVideoId = null;
    onEnterCallback = null;
    onLeaveCallback = null;
    devLog('[YouSub] PageDetector destroyed.');
  },

  /**
   * Get the currently tracked video ID, falling back to the current URL when active.
   * @returns {string|null}
   */
  getCurrentVideoId: function () {
    if (currentVideoId) return currentVideoId;
    return isInitialized ? parseVideoIdFromLocation() : null;
  },
};

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.PageDetector = PageDetector;
}
