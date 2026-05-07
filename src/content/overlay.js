import { TrustedTypes } from '../shared/trusted-types.js';
import { devLog, devWarn } from '../shared/constants.js';

let container = null;
let translatedElement = null;
let originalElement = null;
let statusContainer = null;
let spinnerElement = null;
let playerElement = null; // Cached reference to player
let storageListener = null; // Phase 53.1: Track listener for cleanup

let currentStyles = {}; // Track applied styles to avoid redundant updates
let _translationInProgress = false;

// Ensure policy is initialized once the module loads
TrustedTypes.init();

function createOverlay() {
  if (container) return; // Already created

  const isShorts = window.location.pathname.startsWith('/shorts/');
  
  if (isShorts) {
    // Phase 50.5: Multiple selectors for Shorts active player
    playerElement = document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player') ||
                    document.querySelector('ytd-shorts .html5-video-player') ||
                    document.querySelector('.ytd-reel-video-renderer[is-active] .html5-video-player');
  } else {
    playerElement = document.getElementById('movie_player') || 
                    document.querySelector('.html5-video-player') ||
                    document.querySelector('#ytd-player .html5-video-player');
  }

  if (!playerElement) {
    devWarn('[YouSub] Overlay: Player container not found. Retrying in 500ms...');
    setTimeout(createOverlay, 500);
    return;
  }

  container = document.createElement('div');
  container.id = 'yousub-overlay';
  if (isShorts) container.classList.add('yousub-shorts');

  // Status messages container (top of overlay)
  statusContainer = document.createElement('div');
  statusContainer.id = 'yousub-status-container';
  container.appendChild(statusContainer);

  // Main translated line
  translatedElement = document.createElement('div');
  translatedElement.id = 'yousub-text-translated';
  translatedElement.className = 'yousub-text-line';

  // Original source line
  originalElement = document.createElement('div');
  originalElement.id = 'yousub-text-original';
  originalElement.className = 'yousub-text-line hidden';

  // Spinner (Loading indicator)
  spinnerElement = document.createElement('div');
  spinnerElement.id = 'yousub-spinner';
  spinnerElement.className = 'hidden';
  container.appendChild(spinnerElement);

  container.appendChild(translatedElement);
  container.appendChild(originalElement);
  playerElement.appendChild(container);

  // Initial style application
  Overlay.refreshStyles();

  // Phase 53.1: Store listener reference for cleanup in destroy()
  storageListener = (changes, area) => {
    if (area === 'local' && changes.yousub_appearance) {
      Overlay.applyStyles(changes.yousub_appearance.newValue);
    }
  };
  chrome.storage.onChanged.addListener(storageListener);

  devLog('[YouSub] Overlay: Dynamic overlay created (ESM).');
}

export const Overlay = {
  show: function () {
    // Phase 52.2: Verify playerElement is still valid before showing
    if (container && playerElement) {
      const isShorts = window.location.pathname.startsWith('/shorts/');
      const isStale = !playerElement.isConnected ||
        (isShorts && !playerElement.closest('ytd-reel-video-renderer[is-active]'));
      if (isStale) {
        this.destroy();
      }
    }
    createOverlay();
    if (container) {
      container.classList.add('yousub-visible');
    }
  },

  hide: function () {
    if (container) {
      container.classList.remove('yousub-visible');
    }
  },

  setLoading: function (isLoading) {
    createOverlay();
    if (!container || !spinnerElement) return;
    _translationInProgress = isLoading;

    if (isLoading) {
      container.classList.add('yousub-loading');
      spinnerElement.classList.remove('hidden');
      if (translatedElement) translatedElement.classList.add('yousub-dimmed');
      if (originalElement) originalElement.classList.add('yousub-dimmed');
    } else {
      container.classList.remove('yousub-loading');
      spinnerElement.classList.add('hidden');
      if (translatedElement) translatedElement.classList.remove('yousub-dimmed');
      if (originalElement) originalElement.classList.remove('yousub-dimmed');
    }
  },

  /**
   * Display a temporary status message on the overlay.
   * @param {string} message Text to show.
   * @param {string} type 'info', 'success', 'warning', 'error'.
   * @param {number} duration Timeout in ms.
   */
  showStatus: function (message, type, duration) {
    createOverlay();
    if (!statusContainer) return;

    this.show(); // Ensure overlay is visible if showing status

    const msgEl = document.createElement('div');
    // Phase 55: Whitelist valid status types
    const validTypes = ['info', 'success', 'warning', 'error'];
    const safeType = validTypes.includes(type) ? type : 'info';
    msgEl.className = 'yousub-status-msg yousub-status-' + safeType;
    
    // Phase 36: Use TrustedTypes for security compliance on YouTube
    msgEl.innerHTML = TrustedTypes.toSafeHTML(message);

    // Enable click handling for specialized actions (e.g. Open Settings)

    // Enable click handling for specialized actions (e.g. Open Settings)
    const actionLink = msgEl.querySelector('[data-action="open-settings"]');
    if (actionLink) {
      actionLink.style.cursor = 'pointer';
      actionLink.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'YOUSUB_OPEN_SETTINGS' });
      });
    }

    statusContainer.appendChild(msgEl);

    setTimeout(function() {
      if (msgEl.parentNode) {
        msgEl.parentNode.removeChild(msgEl);
      }
    }, duration || 4000);
  },

  /**
   * @param {string} translated
   * @param {string} original
   * @param {boolean} isDualMode
   * @param {boolean} [isTranslated] If true, show at full opacity even during loading
   */
  renderSubtitles: function (translated, original, isDualMode, isTranslated) {
    createOverlay();
    if (!translatedElement || !originalElement) return;

    // Use textContent for safety and performance (Phase 50.1.3)
    translatedElement.textContent = translated || '';

    if (isDualMode && original) {
      originalElement.textContent = original;
      originalElement.classList.remove('hidden');
    } else {
      originalElement.classList.add('hidden');
    }

    if (isTranslated) {
      translatedElement.classList.remove('yousub-dimmed');
      originalElement.classList.remove('yousub-dimmed');
      if (spinnerElement) spinnerElement.classList.add('hidden');
    } else if (_translationInProgress) {
      translatedElement.classList.add('yousub-dimmed');
      originalElement.classList.add('yousub-dimmed');
      if (spinnerElement) spinnerElement.classList.remove('hidden');
    }
  },

  /**
   * Fetches current style preference and applies it.
   */
  refreshStyles: function () {
    chrome.storage.local.get(['yousub_appearance']).then((res) => {
      if (res.yousub_appearance) {
        this.applyStyles(res.yousub_appearance);
      }
    });
  },

  /**
   * Updates the DOM styles directly.
   */
  applyStyles: function (styles) {
    if (!container || !translatedElement || !styles) return;

    if (styles.fontSize !== undefined && currentStyles.fontSize !== styles.fontSize) {
      translatedElement.style.fontSize = styles.fontSize + 'em';
      originalElement.style.fontSize = (styles.fontSize * 0.7) + 'em';
      currentStyles.fontSize = styles.fontSize;
    }

    if (styles.fontColor !== undefined && currentStyles.fontColor !== styles.fontColor) {
      translatedElement.style.color = styles.fontColor;
      currentStyles.fontColor = styles.fontColor;
    }

    if (styles.bgOpacity !== undefined && currentStyles.bgOpacity !== styles.bgOpacity) {
      const opacity = styles.bgOpacity || 0;
      container.style.backgroundColor = 'rgba(0, 0, 0, ' + opacity + ')';
      currentStyles.bgOpacity = styles.bgOpacity;
    }

    if (styles.posBottom !== undefined && currentStyles.posBottom !== styles.posBottom) {
      container.style.setProperty('--yousub-pos-bottom', styles.posBottom + 'px');
      currentStyles.posBottom = styles.posBottom;
    }
  },

  setText: function (text) {
    this.renderSubtitles(text, '', false);
  },

  destroy: function () {
    // Phase 53.1: Remove storage listener to prevent accumulation
    if (storageListener) {
      chrome.storage.onChanged.removeListener(storageListener);
      storageListener = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    translatedElement = null;
    originalElement = null;
    statusContainer = null;
    playerElement = null;
    currentStyles = {};
    _translationInProgress = false;
    devLog('[YouSub] Overlay: Destroyed.');
  }
};

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.Overlay = Overlay;
}
