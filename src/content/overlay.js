let container = null;
let translatedElement = null;
let originalElement = null;
let statusContainer = null;
let spinnerElement = null;
let playerElement = null; // Cached reference to player

let currentStyles = {}; // Track applied styles to avoid redundant updates

function createOverlay() {
  if (container) return; // Already created

  playerElement = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  if (!playerElement) {
    console.warn('[YouSub] Overlay: Player container not found.');
    return;
  }

  container = document.createElement('div');
  container.id = 'yousub-overlay';

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

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.yousub_appearance) {
      Overlay.applyStyles(changes.yousub_appearance.newValue);
    }
  });

  console.log('[YouSub] Overlay: Dynamic overlay created (ESM).');
}

export const Overlay = {
  show: function () {
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
    msgEl.className = 'yousub-status-msg yousub-status-' + (type || 'info');
    
    // Phase 36: Use TrustedTypes for security compliance on YouTube
    if (typeof window !== 'undefined' && window.YouSub && window.YouSub.TrustedTypes) {
      msgEl.innerHTML = window.YouSub.TrustedTypes.toSafeHTML(message);
    } else {
      msgEl.innerHTML = message;
    }

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
   */
  renderSubtitles: function (translated, original, isDualMode) {
    createOverlay();
    if (!translatedElement || !originalElement) return;

    translatedElement.textContent = translated || '';
    
    if (isDualMode && original) {
      originalElement.textContent = original;
      originalElement.classList.remove('hidden');
    } else {
      originalElement.classList.add('hidden');
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
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    translatedElement = null;
    originalElement = null;
    statusContainer = null;
    playerElement = null;
    currentStyles = {};
    console.log('[YouSub] Overlay: Destroyed.');
  }
};

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.Overlay = Overlay;
}
