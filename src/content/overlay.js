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

let handles = {};
let playerObserver = null;
let currentLayout = null;
let isDragging = false;

const LAYOUT_MIN_WIDTH = 200;
const LAYOUT_MIN_HEIGHT = 40;

// Ensure policy is initialized once the module loads
TrustedTypes.init();

function clampPosition(left, top, width, height, playerW, playerH) {
  return {
    left: Math.max(0, Math.min(left, playerW - width)),
    top: Math.max(0, Math.min(top, playerH - height))
  };
}

function clampRect(left, top, width, height, playerW, playerH) {
  width = Math.min(Math.max(width, LAYOUT_MIN_WIDTH), playerW);
  height = Math.min(Math.max(height, LAYOUT_MIN_HEIGHT), playerH);
  left = Math.max(0, Math.min(left, playerW - width));
  top = Math.max(0, Math.min(top, playerH - height));
  return { left, top, width, height };
}

function enterCustomMode() {
  if (!container || !playerElement) return;
  const playerRect = playerElement.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  if (playerRect.width === 0 || playerRect.height === 0) return;

  const leftPct = (containerRect.left - playerRect.left) / playerRect.width * 100;
  const topPct = (containerRect.top - playerRect.top) / playerRect.height * 100;
  const widthPct = containerRect.width / playerRect.width * 100;

  container.classList.add('yousub-custom-position');
  container.style.left = leftPct + '%';
  container.style.top = topPct + '%';
  container.style.width = widthPct + '%';
  container.style.bottom = 'auto';

  currentLayout = { customMode: true, leftPct, topPct, widthPct, minHeightPx: null };
}

function exitCustomMode() {
  if (!container) return;
  container.classList.remove('yousub-custom-position');
  container.style.left = '';
  container.style.top = '';
  container.style.width = '';
  container.style.minHeight = '';
  container.style.bottom = '';
  currentLayout = { customMode: false, leftPct: null, topPct: null, widthPct: null, minHeightPx: null };
}

function applyLayout() {
  if (!container || !playerElement || !currentLayout || !currentLayout.customMode) return;
  container.classList.add('yousub-custom-position');
  container.style.left = currentLayout.leftPct + '%';
  container.style.top = currentLayout.topPct + '%';
  if (currentLayout.widthPct) container.style.width = currentLayout.widthPct + '%';
  if (currentLayout.minHeightPx) container.style.minHeight = currentLayout.minHeightPx + 'px';
  container.style.bottom = 'auto';
  reclampToPlayer();
}

function reclampToPlayer() {
  if (!container || !playerElement || !currentLayout || !currentLayout.customMode) return;
  const pw = playerElement.clientWidth;
  const ph = playerElement.clientHeight;
  if (pw === 0 || ph === 0) return;

  const left = currentLayout.leftPct / 100 * pw;
  const top = currentLayout.topPct / 100 * ph;
  const width = currentLayout.widthPct ? currentLayout.widthPct / 100 * pw : container.offsetWidth;
  const height = container.offsetHeight;

  const clamped = clampRect(left, top, width, height, pw, ph);
  container.style.left = (clamped.left / pw * 100) + '%';
  container.style.top = (clamped.top / ph * 100) + '%';
  if (currentLayout.widthPct) container.style.width = (clamped.width / pw * 100) + '%';
  currentLayout.leftPct = clamped.left / pw * 100;
  currentLayout.topPct = clamped.top / ph * 100;
  if (currentLayout.widthPct) currentLayout.widthPct = clamped.width / pw * 100;
}

function loadLayout() {
  const isShorts = window.location.pathname.startsWith('/shorts/');
  const key = isShorts ? 'shorts' : 'regular';
  chrome.storage.local.get(['yousub_overlay_layout']).then((res) => {
    const layouts = res.yousub_overlay_layout || {};
    const layout = layouts[key];
    if (layout && layout.customMode) {
      currentLayout = { ...layout };
      applyLayout();
    } else {
      currentLayout = { customMode: false, leftPct: null, topPct: null, widthPct: null, minHeightPx: null };
    }
  });
}

function saveLayout() {
  const isShorts = window.location.pathname.startsWith('/shorts/');
  const key = isShorts ? 'shorts' : 'regular';
  chrome.storage.local.get(['yousub_overlay_layout']).then((res) => {
    const layouts = res.yousub_overlay_layout || {};
    layouts[key] = { ...currentLayout };
    chrome.storage.local.set({ yousub_overlay_layout: layouts });
  });
}

function attachMoveHandler(handleEl) {
  handleEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleEl.setPointerCapture(e.pointerId);

    const playerRect = playerElement.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const offsetX = e.clientX - containerRect.left;
    const offsetY = e.clientY - containerRect.top;

    isDragging = true;
    container.classList.add('yousub-dragging');
    if (!currentLayout || !currentLayout.customMode) enterCustomMode();

    const onMove = (ev) => {
      const newLeft = ev.clientX - playerRect.left - offsetX;
      const newTop = ev.clientY - playerRect.top - offsetY;
      const clamped = clampPosition(newLeft, newTop, container.offsetWidth, container.offsetHeight, playerRect.width, playerRect.height);

      const leftPct = clamped.left / playerRect.width * 100;
      const topPct = clamped.top / playerRect.height * 100;
      container.style.left = leftPct + '%';
      container.style.top = topPct + '%';
      currentLayout.leftPct = leftPct;
      currentLayout.topPct = topPct;
    };

    const onUp = (ev) => {
      handleEl.releasePointerCapture(ev.pointerId);
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      handleEl.removeEventListener('pointercancel', onUp);
      isDragging = false;
      container.classList.remove('yousub-dragging');
      saveLayout();
    };

    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
    handleEl.addEventListener('pointercancel', onUp);
  });
}

function attachResizeHandler(handleEl, corner) {
  handleEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleEl.setPointerCapture(e.pointerId);

    const playerRect = playerElement.getBoundingClientRect();
    const startRect = container.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = startRect.left - playerRect.left;
    const startTop = startRect.top - playerRect.top;
    const startWidth = startRect.width;
    const startHeight = startRect.height;

    isDragging = true;
    container.classList.add('yousub-dragging');
    if (!currentLayout || !currentLayout.customMode) enterCustomMode();

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let newLeft = startLeft, newTop = startTop;
      let newWidth = startWidth, newHeight = startHeight;

      if (corner.includes('e')) newWidth = startWidth + dx;
      if (corner.includes('w')) { newWidth = startWidth - dx; newLeft = startLeft + dx; }
      if (corner.includes('s')) newHeight = startHeight + dy;
      if (corner.includes('n')) { newHeight = startHeight - dy; newTop = startTop + dy; }

      if (newWidth < LAYOUT_MIN_WIDTH) {
        if (corner.includes('w')) newLeft = startLeft + startWidth - LAYOUT_MIN_WIDTH;
        newWidth = LAYOUT_MIN_WIDTH;
      }
      if (newHeight < LAYOUT_MIN_HEIGHT) {
        if (corner.includes('n')) newTop = startTop + startHeight - LAYOUT_MIN_HEIGHT;
        newHeight = LAYOUT_MIN_HEIGHT;
      }

      const clamped = clampRect(newLeft, newTop, newWidth, newHeight, playerRect.width, playerRect.height);
      const leftPct = clamped.left / playerRect.width * 100;
      const topPct = clamped.top / playerRect.height * 100;
      const widthPct = clamped.width / playerRect.width * 100;

      container.style.left = leftPct + '%';
      container.style.top = topPct + '%';
      container.style.width = widthPct + '%';
      container.style.minHeight = clamped.height + 'px';

      currentLayout.leftPct = leftPct;
      currentLayout.topPct = topPct;
      currentLayout.widthPct = widthPct;
      currentLayout.minHeightPx = clamped.height;
    };

    const onUp = (ev) => {
      handleEl.releasePointerCapture(ev.pointerId);
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      handleEl.removeEventListener('pointercancel', onUp);
      isDragging = false;
      container.classList.remove('yousub-dragging');
      saveLayout();
    };

    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
    handleEl.addEventListener('pointercancel', onUp);
  });
}

function attachResetHandler(handleEl) {
  handleEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    exitCustomMode();
    saveLayout();
  });
}

function createHandles() {
  const types = ['nw', 'ne', 'sw', 'se', 'move', 'reset'];
  types.forEach(type => {
    const el = document.createElement('div');
    el.className = 'yousub-handle yousub-handle-' + type;
    container.appendChild(el);
    handles[type] = el;
  });

  ['nw', 'ne', 'sw', 'se'].forEach(corner => {
    attachResizeHandler(handles[corner], corner);
  });
  attachMoveHandler(handles.move);
  attachResetHandler(handles.reset);
}

function setupPlayerObserver() {
  if (playerObserver) playerObserver.disconnect();
  playerObserver = new ResizeObserver(() => {
    if (!currentLayout || !currentLayout.customMode) return;
    reclampToPlayer();
  });
  playerObserver.observe(playerElement);
}

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

  createHandles();
  loadLayout();
  setupPlayerObserver();

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
    if (container && !isDragging) {
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
    if (playerObserver) { playerObserver.disconnect(); playerObserver = null; }
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
    handles = {};
    isDragging = false;
    currentLayout = null;
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
