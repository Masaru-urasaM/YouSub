import { TrustedTypes } from '../shared/trusted-types.js';
import { devLog, devWarn } from '../shared/constants.js';

let container = null;
let translatedElement = null;
let originalElement = null;
let statusContainer = null;
let stagePillElement = null;
let stagePillTimer = null;
let spinnerElement = null;
let playerElement = null; // Cached reference to player
let storageListener = null; // Phase 53.1: Track listener for cleanup

let currentStyles = {}; // Track applied styles to avoid redundant updates
let _translationInProgress = false;
let stagePillEnabled = true;

let handles = {};
let playerObserver = null;
let playerClassObserver = null;
let observedBarElement = null;
let currentLayout = null;
let isDragging = false;
let pendingStatusQueue = [];
let pendingCreateTimer = null;

const LAYOUT_MIN_WIDTH = 200;
const LAYOUT_MIN_HEIGHT = 40;
const BAR_SAFE_MARGIN_PX = 10;
const DEFAULT_CUSTOM_MAX_WIDTH_PCT = 80;
const DEFAULT_SHORTS_MAX_WIDTH_PCT = 90;

// Ensure policy is initialized once the module loads
TrustedTypes.init();

function isShortsPath() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/shorts/');
}

function getDefaultMaxWidthPct() {
  return isShortsPath() ? DEFAULT_SHORTS_MAX_WIDTH_PCT : DEFAULT_CUSTOM_MAX_WIDTH_PCT;
}

function getPlayerSize(el) {
  if (!el) return { width: 0, height: 0 };
  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  return {
    width: el.clientWidth || rect?.width || 0,
    height: el.clientHeight || rect?.height || 0,
  };
}

function clampPosition(left, top, width, height, playerW, playerH) {
  return {
    left: Math.max(0, Math.min(left, playerW - width)),
    top: Math.max(0, Math.min(top, playerH - height)),
  };
}

function clampRect(left, top, width, height, playerW, playerH) {
  width = Math.min(Math.max(width, LAYOUT_MIN_WIDTH), playerW);
  height = Math.min(Math.max(height, LAYOUT_MIN_HEIGHT), playerH);
  left = Math.max(0, Math.min(left, playerW - width));
  top = Math.max(0, Math.min(top, playerH - height));
  return { left, top, width, height };
}

const MOBILE_CONTROL_BAR_SELECTORS = [
  '#player-control-overlay:not([aria-hidden="true"]) .player-controls-bottom',
  '.ytm-custom-control .player-controls-bottom',
  '.player-controls-bottom',
];

function findBottomControlBar() {
  if (!playerElement) return null;
  const desktopBar = playerElement.querySelector('.ytp-chrome-bottom');
  if (desktopBar) return desktopBar;

  for (let i = 0; i < MOBILE_CONTROL_BAR_SELECTORS.length; i++) {
    const sel = MOBILE_CONTROL_BAR_SELECTORS[i];
    const mobileBar = playerElement.querySelector(sel) || document.querySelector(sel);
    if (!mobileBar) continue;
    if (
      typeof mobileBar.closest === 'function' &&
      mobileBar.closest('#player-control-overlay[aria-hidden="true"]')
    ) {
      continue;
    }
    return mobileBar;
  }
  return null;
}

function measureControlBarClearance() {
  if (!playerElement || isDragging) return 0;

  const controlsHidden =
    playerElement.classList.contains('ytp-autohide') ||
    playerElement.classList.contains('ytp-autohide-active') ||
    playerElement.classList.contains('ytp-hide-controls');
  if (controlsHidden) return 0;

  const chromeBottom = findBottomControlBar();
  if (!chromeBottom) return 0;

  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const cs = window.getComputedStyle(chromeBottom);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) {
      return 0;
    }
  }

  const pRect = playerElement.getBoundingClientRect();
  const bRect = chromeBottom.getBoundingClientRect();
  const playerHeight = pRect.height || playerElement.clientHeight || 0;
  const playerBottom = pRect.bottom ?? (pRect.top || 0) + playerHeight;
  if (!playerHeight || !bRect.height || bRect.height <= 0) return 0;

  const rawClearance = playerBottom - bRect.top;
  if (rawClearance <= 0 || rawClearance >= playerHeight * 0.45) return 0;

  return Math.ceil(rawClearance + BAR_SAFE_MARGIN_PX);
}

function updateBarClearance() {
  if (!container || !playerElement) return;
  const chromeBottom = findBottomControlBar();
  if (chromeBottom && chromeBottom !== observedBarElement && playerObserver) {
    observedBarElement = chromeBottom;
    playerObserver.observe(chromeBottom);
  }
  const clearancePx = measureControlBarClearance();
  container.style.setProperty('--yousub-bar-clearance', `${clearancePx}px`);
}

function syncOverlayBounds() {
  if (!container || !playerElement || isDragging) return;
  const { width: pw, height: ph } = getPlayerSize(playerElement);
  if (!pw || !ph) return;

  const ch = container.offsetHeight || 0;
  const maxBottomPx = Math.max(0, ph - ch);
  container.style.setProperty('--yousub-max-bottom', `${Math.round(maxBottomPx)}px`);

  if (currentLayout && currentLayout.customMode && typeof currentLayout.centerXPct === 'number') {
    const cw = container.offsetWidth || 0;
    if (cw > 0) {
      const halfW = Math.min(cw, pw) / 2;
      const desiredCenterPx = (currentLayout.centerXPct / 100) * pw;
      const clampedCenterPx = Math.max(halfW, Math.min(desiredCenterPx, pw - halfW));
      container.style.left = (clampedCenterPx / pw) * 100 + '%';
    } else {
      container.style.left = currentLayout.centerXPct + '%';
    }
  }
}

function applyLayoutStyles() {
  if (!container || !currentLayout || !currentLayout.customMode) return;
  container.classList.add('yousub-custom-position');
  container.style.left = currentLayout.centerXPct + '%';
  container.style.top = 'auto';
  container.style.width = '';
  container.style.bottom = '';
  container.style.maxWidth = (currentLayout.maxWidthPct ?? getDefaultMaxWidthPct()) + '%';
  container.style.setProperty('--yousub-custom-bottom', currentLayout.bottomPct + '%');
  if (currentLayout.minHeightPx) {
    container.style.minHeight = currentLayout.minHeightPx + 'px';
  } else {
    container.style.minHeight = '';
  }
}

function normalizeLayout(raw, pw, ph, curH = 0) {
  if (!raw || !raw.customMode) {
    return {
      customMode: false,
      centerXPct: null,
      bottomPct: null,
      maxWidthPct: null,
      minHeightPx: null,
    };
  }
  if (typeof raw.centerXPct === 'number' && typeof raw.bottomPct === 'number') {
    return {
      customMode: true,
      centerXPct: raw.centerXPct,
      bottomPct: raw.bottomPct,
      maxWidthPct: raw.maxWidthPct ?? getDefaultMaxWidthPct(),
      minHeightPx: raw.minHeightPx ?? null,
    };
  }
  // Migrate legacy { leftPct, topPct, widthPct } to bottom-anchored centered layout
  const legacyWidthPct = raw.maxWidthPct || raw.widthPct || getDefaultMaxWidthPct();
  const centerXPct = (raw.leftPct ?? 50 - legacyWidthPct / 2) + legacyWidthPct / 2;
  const heightPct = ph > 0 && curH > 0 ? (curH / ph) * 100 : 12;
  const bottomPct = Math.max(0, 100 - (raw.topPct ?? 70) - heightPct);
  return {
    customMode: true,
    centerXPct,
    bottomPct,
    maxWidthPct: legacyWidthPct,
    minHeightPx: raw.minHeightPx ?? null,
  };
}

function enterCustomMode() {
  if (!container || !playerElement) return;
  const playerRect = playerElement.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const pw = playerRect.width || playerElement.clientWidth;
  const ph = playerRect.height || playerElement.clientHeight;
  if (!pw || !ph) return;

  const centerXPx = containerRect.left - playerRect.left + containerRect.width / 2;
  const playerBottom = playerRect.bottom ?? playerRect.top + ph;
  const containerBottom = containerRect.bottom ?? containerRect.top + containerRect.height;
  const bottomPx = Math.max(0, playerBottom - containerBottom);

  currentLayout = {
    customMode: true,
    centerXPct: (centerXPx / pw) * 100,
    bottomPct: (bottomPx / ph) * 100,
    maxWidthPct: getDefaultMaxWidthPct(),
    minHeightPx: null,
  };

  applyLayoutStyles();
}

function exitCustomMode() {
  if (!container) return;
  container.classList.remove('yousub-custom-position', 'yousub-resizing');
  container.style.left = '';
  container.style.top = '';
  container.style.width = '';
  container.style.maxWidth = '';
  container.style.minHeight = '';
  container.style.bottom = '';
  container.style.removeProperty('--yousub-custom-bottom');
  container.style.removeProperty('--yousub-max-bottom');
  currentLayout = {
    customMode: false,
    centerXPct: null,
    bottomPct: null,
    maxWidthPct: null,
    minHeightPx: null,
  };
  updateBarClearance();
  syncOverlayBounds();
}

function applyLayout() {
  if (!container || !playerElement || !currentLayout || !currentLayout.customMode) return;
  applyLayoutStyles();
  reclampToPlayer();
  updateBarClearance();
}

function reclampToPlayer() {
  if (!container || !playerElement || !currentLayout || !currentLayout.customMode) return;
  const { width: pw, height: ph } = getPlayerSize(playerElement);
  if (!pw || !ph) return;

  const minWidthPct = (Math.min(LAYOUT_MIN_WIDTH, pw) / pw) * 100;
  const maxWidthPct = Math.min(
    Math.max(currentLayout.maxWidthPct ?? getDefaultMaxWidthPct(), minWidthPct),
    100
  );
  currentLayout.maxWidthPct = maxWidthPct;

  const cw = container.offsetWidth || (maxWidthPct / 100) * pw;
  const ch = container.offsetHeight || LAYOUT_MIN_HEIGHT;
  const halfW = Math.min(cw, pw) / 2;
  const minCenterPct = (halfW / pw) * 100;
  const maxCenterPct = 100 - minCenterPct;
  currentLayout.centerXPct = Math.max(
    minCenterPct,
    Math.min(currentLayout.centerXPct, maxCenterPct)
  );

  const maxBottomPct = Math.max(0, ((ph - Math.min(ch, ph)) / ph) * 100);
  currentLayout.bottomPct = Math.max(0, Math.min(currentLayout.bottomPct, maxBottomPct));

  applyLayoutStyles();
  syncOverlayBounds();
}

function loadLayout() {
  const key = isShortsPath() ? 'shorts' : 'regular';
  chrome.storage.local.get(['yousub_overlay_layout']).then((res) => {
    const layouts = res.yousub_overlay_layout || {};
    const layout = layouts[key];
    if (layout && layout.customMode) {
      const { width: pw, height: ph } = getPlayerSize(playerElement);
      const curH = container ? container.offsetHeight : 0;
      currentLayout = normalizeLayout(layout, pw, ph, curH);
      applyLayout();
    } else {
      currentLayout = {
        customMode: false,
        centerXPct: null,
        bottomPct: null,
        maxWidthPct: null,
        minHeightPx: null,
      };
      updateBarClearance();
      syncOverlayBounds();
    }
  });
}

function saveLayout() {
  const key = isShortsPath() ? 'shorts' : 'regular';
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
    const pw = playerRect.width || playerElement.clientWidth;
    const ph = playerRect.height || playerElement.clientHeight;
    const curW = container.offsetWidth || containerRect.width;
    const curH = container.offsetHeight || containerRect.height;
    const offsetX = e.clientX - containerRect.left;
    const offsetY = e.clientY - containerRect.top;

    if (!currentLayout || !currentLayout.customMode) enterCustomMode();
    isDragging = true;
    container.classList.add('yousub-dragging');
    updateBarClearance();

    const onMove = (ev) => {
      if (!pw || !ph) return;
      const newLeft = ev.clientX - playerRect.left - offsetX;
      const newTop = ev.clientY - playerRect.top - offsetY;
      const clamped = clampPosition(newLeft, newTop, curW, curH, pw, ph);

      const centerXPct = ((clamped.left + curW / 2) / pw) * 100;
      const bottomPx = Math.max(0, ph - (clamped.top + curH));
      const bottomPct = (bottomPx / ph) * 100;

      currentLayout.centerXPct = centerXPct;
      currentLayout.bottomPct = bottomPct;
      container.style.left = centerXPct + '%';
      container.style.setProperty('--yousub-custom-bottom', bottomPct + '%');
    };

    const onUp = (ev) => {
      handleEl.releasePointerCapture(ev.pointerId);
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      handleEl.removeEventListener('pointercancel', onUp);
      isDragging = false;
      container.classList.remove('yousub-dragging');
      updateBarClearance();
      syncOverlayBounds();
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
    const pw = playerRect.width || playerElement.clientWidth;
    const ph = playerRect.height || playerElement.clientHeight;
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = startRect.left - playerRect.left;
    const startTop = startRect.top - playerRect.top;
    const startWidth = startRect.width;
    const startHeight = startRect.height;
    const startMinHeightPx = currentLayout?.minHeightPx || null;

    if (!currentLayout || !currentLayout.customMode) enterCustomMode();
    isDragging = true;
    container.classList.add('yousub-dragging', 'yousub-resizing');
    updateBarClearance();

    const onMove = (ev) => {
      if (!pw || !ph) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let newLeft = startLeft,
        newTop = startTop;
      let newWidth = startWidth,
        newHeight = startHeight;

      if (corner.includes('e')) newWidth = startWidth + dx;
      if (corner.includes('w')) {
        newWidth = startWidth - dx;
        newLeft = startLeft + dx;
      }
      if (corner.includes('s')) newHeight = startHeight + dy;
      if (corner.includes('n')) {
        newHeight = startHeight - dy;
        newTop = startTop + dy;
      }

      if (newWidth < LAYOUT_MIN_WIDTH) {
        if (corner.includes('w')) newLeft = startLeft + startWidth - LAYOUT_MIN_WIDTH;
        newWidth = LAYOUT_MIN_WIDTH;
      }
      if (newHeight < LAYOUT_MIN_HEIGHT) {
        if (corner.includes('n')) newTop = startTop + startHeight - LAYOUT_MIN_HEIGHT;
        newHeight = LAYOUT_MIN_HEIGHT;
      }

      const clamped = clampRect(newLeft, newTop, newWidth, newHeight, pw, ph);
      const centerXPct = ((clamped.left + clamped.width / 2) / pw) * 100;
      const bottomPx = Math.max(0, ph - (clamped.top + clamped.height));
      const bottomPct = (bottomPx / ph) * 100;
      const maxWidthPct = (clamped.width / pw) * 100;
      const preserveMinHeight = Math.abs(dy) >= 4 || Boolean(startMinHeightPx);

      container.style.left = centerXPct + '%';
      container.style.maxWidth = maxWidthPct + '%';
      container.style.setProperty('--yousub-custom-bottom', bottomPct + '%');
      container.style.minHeight = preserveMinHeight ? clamped.height + 'px' : '';

      currentLayout.centerXPct = centerXPct;
      currentLayout.bottomPct = bottomPct;
      currentLayout.maxWidthPct = maxWidthPct;
      currentLayout.minHeightPx = preserveMinHeight ? clamped.height : null;
    };

    const onUp = (ev) => {
      handleEl.releasePointerCapture(ev.pointerId);
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      handleEl.removeEventListener('pointercancel', onUp);
      isDragging = false;
      container.classList.remove('yousub-dragging', 'yousub-resizing');
      updateBarClearance();
      syncOverlayBounds();
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
  types.forEach((type) => {
    const el = document.createElement('div');
    el.className = 'yousub-handle yousub-handle-' + type;
    container.appendChild(el);
    handles[type] = el;
  });

  ['nw', 'ne', 'sw', 'se'].forEach((corner) => {
    attachResizeHandler(handles[corner], corner);
  });
  attachMoveHandler(handles.move);
  attachResetHandler(handles.reset);
}

function setupPlayerObserver() {
  if (playerObserver) playerObserver.disconnect();
  observedBarElement = null;
  playerObserver = new ResizeObserver(() => {
    if (currentLayout && currentLayout.customMode) {
      reclampToPlayer();
    } else {
      syncOverlayBounds();
    }
    updateBarClearance();
  });
  playerObserver.observe(playerElement);

  const chromeBottom = findBottomControlBar();
  if (chromeBottom) {
    observedBarElement = chromeBottom;
    playerObserver.observe(chromeBottom);
  }

  if (typeof MutationObserver !== 'undefined') {
    if (playerClassObserver) playerClassObserver.disconnect();
    playerClassObserver = new MutationObserver(() => {
      updateBarClearance();
    });
    playerClassObserver.observe(playerElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  updateBarClearance();
}

function findPlayerElement(isShorts) {
  if (isShorts) {
    // Phase 50.5 + 2026 Shorts DOM: #shorts-player persists even when [is-active] is absent
    return (
      document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player') ||
      document.getElementById('shorts-player') ||
      document.querySelector('ytd-shorts .html5-video-player') ||
      document.querySelector('.ytd-reel-video-renderer[is-active] .html5-video-player')
    );
  }
  return (
    document.getElementById('movie_player') ||
    document.querySelector('#player-container-id .html5-video-player') ||
    document.querySelector('ytm-player .html5-video-player') ||
    document.querySelector('.html5-video-player') ||
    document.querySelector('#ytd-player .html5-video-player') ||
    document.getElementById('player-container-id') ||
    document.querySelector('ytm-player')
  );
}

function readDroppedSubtitleFile(file) {
  if (!file) return Promise.reject(new Error('No file selected'));
  const MAX_SUBTITLE_FILE_BYTES = 5 * 1024 * 1024;
  if (file.size > MAX_SUBTITLE_FILE_BYTES) {
    return Promise.reject(new Error('Subtitle file exceeds 5 MB limit'));
  }
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function createOverlay() {
  if (container) return; // Already created

  const isShorts = window.location.pathname.startsWith('/shorts/');
  playerElement = findPlayerElement(isShorts);

  if (!playerElement) {
    devWarn('[YouSub] Overlay: Player container not found. Retrying in 500ms...');
    if (!pendingCreateTimer) {
      pendingCreateTimer = setTimeout(() => {
        pendingCreateTimer = null;
        createOverlay();
      }, 500);
    }
    return;
  }
  if (pendingCreateTimer) {
    clearTimeout(pendingCreateTimer);
    pendingCreateTimer = null;
  }

  container = document.createElement('div');
  container.id = 'yousub-overlay';
  if (isShorts) container.classList.add('yousub-shorts');

  // Compact Sparrow-inspired pipeline stage pill (Phase 80d)
  stagePillElement = document.createElement('div');
  stagePillElement.id = 'yousub-stage-pill';
  stagePillElement.className = 'yousub-stage-pill hidden';
  stagePillElement.setAttribute('aria-live', 'polite');
  container.appendChild(stagePillElement);

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

  if (pendingStatusQueue.length > 0) {
    const queued = pendingStatusQueue.splice(0, pendingStatusQueue.length);
    for (const item of queued) {
      Overlay.showStatus(item.message, item.type, item.duration, item.options);
    }
  }
}

export const Overlay = {
  init: function () {
    createOverlay();
  },

  show: function () {
    // Phase 52.2: Verify playerElement is still valid before showing
    if (container && playerElement) {
      const isShorts = window.location.pathname.startsWith('/shorts/');
      const activeReel = isShorts
        ? document.querySelector('ytd-reel-video-renderer[is-active]')
        : null;
      const expectedPlayer = findPlayerElement(isShorts);
      const isStale =
        !playerElement.isConnected ||
        (expectedPlayer && expectedPlayer !== playerElement) ||
        (activeReel && !activeReel.contains(playerElement));
      if (isStale) {
        this.destroy();
      }
    }
    createOverlay();
    if (container) {
      container.classList.add('yousub-visible');
      updateBarClearance();
      syncOverlayBounds();
    }
  },

  hide: function () {
    if (container && !isDragging) {
      if (translatedElement) translatedElement.textContent = '';
      if (originalElement) originalElement.classList.add('hidden');
      const hasStatus = statusContainer && statusContainer.children.length > 0;
      const hasPill = stagePillElement && !stagePillElement.classList.contains('hidden');
      if (!hasStatus && !hasPill) {
        container.classList.remove('yousub-visible');
      }
    }
  },

  clearStatus: function (statusId) {
    if (!statusContainer) return;
    if (statusId) {
      const target = statusContainer.querySelector(`[data-status-id="${statusId}"]`);
      if (target && target.parentNode) target.parentNode.removeChild(target);
    } else {
      statusContainer.textContent = '';
    }
    if (
      container &&
      !isDragging &&
      statusContainer.children.length === 0 &&
      (!translatedElement || !translatedElement.textContent) &&
      !_translationInProgress
    ) {
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
   * Display a status message on the overlay.
   * @param {string} message Text/HTML to show (sanitized via TrustedTypes).
   * @param {string} type 'info', 'success', 'warning', 'error'.
   * @param {number} [duration=4000] Timeout in ms; <= 0 stays sticky until dismissed.
   * @param {Object} [options] Optional interactive controls (dismissible, onImportSubtitleFile, actions, id).
   */
  showStatus: function (message, type, duration, options = {}) {
    this.init();
    if (!statusContainer) {
      if (pendingStatusQueue.length >= 3) pendingStatusQueue.shift();
      pendingStatusQueue.push({ message, type, duration, options });
      return;
    }

    this.show(); // Ensure overlay is visible if showing status

    if (options.id) {
      const existing = statusContainer.querySelector(`[data-status-id="${options.id}"]`);
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }

    const msgEl = document.createElement('div');
    // Phase 55: Whitelist valid status types
    const validTypes = ['info', 'success', 'warning', 'error'];
    const safeType = validTypes.includes(type) ? type : 'info';
    msgEl.className = 'yousub-status-msg yousub-status-' + safeType;
    if (options.id) msgEl.setAttribute('data-status-id', options.id);

    const removeMsg = () => {
      if (msgEl.parentNode) {
        msgEl.parentNode.removeChild(msgEl);
      }
      if (
        container &&
        !isDragging &&
        statusContainer &&
        statusContainer.children.length === 0 &&
        (!translatedElement || !translatedElement.textContent) &&
        !_translationInProgress
      ) {
        container.classList.remove('yousub-visible');
      }
    };

    const bodyEl = document.createElement('div');
    bodyEl.className = 'yousub-status-body';
    // Phase 36: Use TrustedTypes for security compliance on YouTube
    bodyEl.innerHTML = TrustedTypes.toSafeHTML(message);
    msgEl.appendChild(bodyEl);

    // Enable click handling for specialized actions (e.g. Open Settings)
    const actionLink = bodyEl.querySelector('[data-action="open-settings"]');
    if (actionLink) {
      actionLink.style.cursor = 'pointer';
      actionLink.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'YOUSUB_OPEN_SETTINGS' });
      });
    }

    const effectiveDuration = duration === undefined || duration === null ? 4000 : duration;

    if (options.dismissible || effectiveDuration <= 0) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'yousub-status-close';
      closeBtn.setAttribute('aria-label', 'Dismiss');
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeMsg();
      });
      msgEl.appendChild(closeBtn);
    }

    const hasActions =
      typeof options.onImportSubtitleFile === 'function' ||
      (Array.isArray(options.actions) && options.actions.length > 0);
    if (hasActions) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'yousub-status-actions';

      if (typeof options.onImportSubtitleFile === 'function') {
        msgEl.classList.add('yousub-status-interactive');
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.srt,.vtt,text/vtt,application/x-subrip';
        fileInput.className = 'yousub-file-input-hidden';
        fileInput.addEventListener('click', (e) => e.stopPropagation());
        fileInput.addEventListener('change', async (e) => {
          e.stopPropagation();
          const file = fileInput.files && fileInput.files[0];
          fileInput.value = '';
          if (!file) return;
          try {
            const text = await readDroppedSubtitleFile(file);
            options.onImportSubtitleFile(text, file.name, removeMsg);
          } catch (err) {
            Overlay.showStatus(err.message || 'Failed to read subtitle file', 'error', 4000);
          }
        });

        const importBtn = document.createElement('button');
        importBtn.type = 'button';
        importBtn.className = 'yousub-status-btn';
        importBtn.textContent = options.importLabel || 'Import .srt / .vtt';
        importBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          fileInput.click();
        });

        actionsRow.appendChild(importBtn);
        actionsRow.appendChild(fileInput);

        msgEl.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.stopPropagation();
          msgEl.classList.add('yousub-drop-active');
        });
        msgEl.addEventListener('dragleave', (e) => {
          e.preventDefault();
          e.stopPropagation();
          msgEl.classList.remove('yousub-drop-active');
        });
        msgEl.addEventListener('drop', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          msgEl.classList.remove('yousub-drop-active');
          const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
          if (!file) return;
          try {
            const text = await readDroppedSubtitleFile(file);
            options.onImportSubtitleFile(text, file.name, removeMsg);
          } catch (err) {
            Overlay.showStatus(err.message || 'Failed to read subtitle file', 'error', 4000);
          }
        });
      }

      if (Array.isArray(options.actions)) {
        for (const action of options.actions) {
          if (!action || typeof action.onClick !== 'function') continue;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'yousub-status-btn';
          btn.textContent = action.label || 'Action';
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            action.onClick(removeMsg);
          });
          actionsRow.appendChild(btn);
        }
      }

      msgEl.appendChild(actionsRow);
      msgEl.addEventListener('click', (e) => e.stopPropagation());
      msgEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    statusContainer.appendChild(msgEl);
    syncOverlayBounds();

    if (effectiveDuration > 0) {
      setTimeout(removeMsg, effectiveDuration);
    }
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

    syncOverlayBounds();
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
      originalElement.style.fontSize = styles.fontSize * 0.7 + 'em';
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

    if (styles.showStagePill !== undefined) {
      const enabled = styles.showStagePill !== false;
      if (currentStyles.showStagePill !== enabled) {
        currentStyles.showStagePill = enabled;
        stagePillEnabled = enabled;
        if (!enabled) {
          this.clearStagePill();
        }
      }
    }

    syncOverlayBounds();
  },

  setText: function (text) {
    this.renderSubtitles(text, '', false);
  },

  /**
   * Update the compact Sparrow-style on-player stage pill with Past / Present / Future chips.
   * @param {Object|null} snapshot Telemetry snapshot from PipelineTelemetry
   */
  updateStagePill: function (snapshot) {
    if (!snapshot || !stagePillEnabled) return;
    createOverlay();
    if (!stagePillElement || !stagePillEnabled) return;

    if (stagePillTimer) {
      clearTimeout(stagePillTimer);
      stagePillTimer = null;
    }

    const STAGE_LABELS = {
      IDLE: 'Preparing...',
      EXTRACT: 'Scanning subtitles...',
      COALESCE: 'Merging cues...',
      ROUTE: 'Translating...',
      VERIFY: 'Verifying...',
      SYNC_CACHE: 'Syncing...',
    };

    const batches = Array.isArray(snapshot.batches) ? snapshot.batches : [];
    const totalBatches = batches.length || snapshot.metrics?.batchCount || 0;
    const rawCount = snapshot.coalescer?.rawCount || 0;
    const coalCount = snapshot.coalescer?.coalescedCount || 0;

    // Past chip
    let pastText = 'Extract ✓';
    if (snapshot.mode === 'cache') {
      const cacheCount = snapshot.sink?.totalCues || coalCount || 0;
      pastText = cacheCount > 0 ? `Cache ✓ ${cacheCount} cues` : 'Cache ✓';
    } else if (snapshot.stage === 'EXTRACT' || snapshot.stage === 'IDLE') {
      pastText = snapshot.mode === 'gemini-video' ? 'Gemini AI' : 'Subtitles';
    } else if (rawCount > 0 && coalCount > 0 && rawCount !== coalCount) {
      pastText = `Extract ✓ ${rawCount}→${coalCount} cues`;
    } else if (coalCount > 0) {
      pastText = `Extract ✓ ${coalCount} cues`;
    }

    // Present chip
    const inFlight = batches.find((b) => b.status === 'IN_FLIGHT');
    const modelStr = snapshot.router?.activeModel || snapshot.router?.activeProvider || '';
    let presentText = STAGE_LABELS[snapshot.stage] || 'Translating...';
    let presentCls = 'yousub-pill-chip yousub-pill-present';

    if (snapshot.stage === 'ERROR') {
      presentText = snapshot.error?.failureReason || 'Error';
      presentCls = 'yousub-pill-chip yousub-pill-error';
    } else if (snapshot.stage === 'COMPLETE') {
      presentText = `Synced ${snapshot.sink?.syncedCues || coalCount || 0} cues`;
      presentCls = 'yousub-pill-chip yousub-pill-past';
    } else if (inFlight) {
      const bLabel = `#${(inFlight.batchIndex ?? 0) + 1}${totalBatches ? `/${totalBatches}` : ''}`;
      const seekTag = inFlight.isSeekTarget ? ' ⚡Seek' : '';
      presentText = `${modelStr ? `${modelStr} · ` : ''}${bLabel}${seekTag}`;
    } else if (modelStr && snapshot.stage === 'ROUTE') {
      presentText = `${modelStr} · Translating...`;
    }

    // Future chip (hidden when there is nothing upcoming)
    const prefetch = batches.find((b) => b.status === 'PREFETCH');
    const nextPending = prefetch || batches.find((b) => b.status === 'PENDING');
    let futureText = '';
    if (snapshot.stage === 'COMPLETE') {
      if (snapshot.sink?.cached) futureText = 'Cached ✓';
    } else if (snapshot.stage === 'ERROR') {
      futureText = 'Retry';
    } else if (nextPending) {
      futureText = `Next #${(nextPending.batchIndex ?? 0) + 1}`;
    } else if (totalBatches > 1 && inFlight && (inFlight.batchIndex ?? 0) + 1 < totalBatches) {
      futureText = `Next #${(inFlight.batchIndex ?? 0) + 2}`;
    } else if (inFlight) {
      futureText = 'Finalizing';
    }

    stagePillElement.textContent = '';

    const pastEl = document.createElement('span');
    pastEl.className = 'yousub-pill-chip yousub-pill-past';
    pastEl.textContent = pastText;

    const arrow1 = document.createElement('span');
    arrow1.className = 'yousub-pill-arrow';
    arrow1.textContent = '→';

    const presEl = document.createElement('span');
    presEl.className = presentCls;
    presEl.textContent = presentText;

    stagePillElement.appendChild(pastEl);
    stagePillElement.appendChild(arrow1);
    stagePillElement.appendChild(presEl);

    if (futureText) {
      const arrow2 = document.createElement('span');
      arrow2.className = 'yousub-pill-arrow';
      arrow2.textContent = '→';

      const futEl = document.createElement('span');
      futEl.className = 'yousub-pill-chip yousub-pill-future';
      futEl.textContent = futureText;

      stagePillElement.appendChild(arrow2);
      stagePillElement.appendChild(futEl);
    }

    stagePillElement.classList.remove('hidden');
    this.show();

    if (snapshot.stage === 'COMPLETE') {
      stagePillTimer = setTimeout(() => {
        stagePillTimer = null;
        this.clearStagePill();
      }, 2500);
    }
  },

  clearStagePill: function () {
    if (stagePillTimer) {
      clearTimeout(stagePillTimer);
      stagePillTimer = null;
    }
    if (stagePillElement) {
      stagePillElement.classList.add('hidden');
      stagePillElement.textContent = '';
    }
    if (
      container &&
      !isDragging &&
      (!statusContainer || statusContainer.children.length === 0) &&
      (!translatedElement || !translatedElement.textContent) &&
      !_translationInProgress
    ) {
      container.classList.remove('yousub-visible');
    }
  },

  destroy: function () {
    if (stagePillTimer) {
      clearTimeout(stagePillTimer);
      stagePillTimer = null;
    }
    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
    }
    if (playerClassObserver) {
      playerClassObserver.disconnect();
      playerClassObserver = null;
    }
    observedBarElement = null;
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
    stagePillElement = null;
    spinnerElement = null;
    playerElement = null;
    handles = {};
    isDragging = false;
    currentLayout = null;
    currentStyles = {};
    _translationInProgress = false;
    stagePillEnabled = true;
    pendingStatusQueue = [];
    if (pendingCreateTimer) {
      clearTimeout(pendingCreateTimer);
      pendingCreateTimer = null;
    }
    devLog('[YouSub] Overlay: Destroyed.');
  },
};

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.Overlay = Overlay;
}
