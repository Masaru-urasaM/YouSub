import '../shared/libs/browser-polyfill.js';
import { RESUME_SETTINGS_KEY, RESUME_STORAGE_KEY, RESUME_SYNC_KEY } from '../shared/constants.js';
import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import {
  PlaybackResumeStore,
  buildQuickJumpPills,
  formatTimestamp,
} from '../shared/playback-resume-store.js';
import { Overlay } from './overlay.js';
import { PlaybackResume } from './playback-resume.js';

export const MOBILE_FAB_POS_KEY = 'yousub_mobile_fab_pos';
const FAB_DIM_DELAY_MS = 3500;
const FAB_MIN_TOP_PCT = 12;
const FAB_MAX_TOP_PCT = 82;
const DEFAULT_FAB_TOP_PCT = 62;
const DRAG_THRESHOLD_PX = 8;

const DEFAULT_APPEARANCE = {
  fontSize: 1.5,
  fontColor: '#ffffff',
  bgOpacity: 0.25,
  posBottom: 20,
};

function msg(key, fallback) {
  try {
    if (typeof browser !== 'undefined' && browser.i18n?.getMessage) {
      return browser.i18n.getMessage(key) || fallback;
    }
  } catch {
    /* ignore outside extension runtime */
  }
  return fallback;
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (typeof text === 'string') el.textContent = text;
  return el;
}

function isShortsPath() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/shorts/');
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function getStorageApi() {
  if (typeof browser !== 'undefined' && browser.storage?.local) return browser.storage;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) return chrome.storage;
  return null;
}

/**
 * Determine whether the floating pill should be displayed on the current environment.
 * Auto-enables on mobile/touch YouTube viewports, and respects desktop opt-in.
 * @param {object} [opts]
 * @returns {boolean}
 */
export function shouldShowMobileFab(opts = {}) {
  if (opts.showDesktopFab === true) return true;

  const host = String(
    opts.hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '') ?? ''
  ).toLowerCase();
  if (host.startsWith('m.')) return true;

  const mm =
    opts.matchMedia ??
    (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia.bind(window)
      : null);
  if (mm) {
    try {
      if (mm('(hover: none) and (pointer: coarse)')?.matches) return true;
    } catch {
      /* ignore invalid media query in mocked globals */
    }
  }

  const touchPoints =
    opts.maxTouchPoints ??
    (typeof navigator !== 'undefined' ? Number(navigator.maxTouchPoints) || 0 : 0);
  const width =
    opts.innerWidth ?? (typeof window !== 'undefined' ? Number(window.innerWidth) || 0 : 0);
  return touchPoints > 0 && width > 0 && width <= 900;
}

let callbacks = {};
let addons = new Map();

let activeVideoId = null;
let isTranslationActive = false;
let isDualMode = false;
let currentTargetLang = 'vi';
let currentAppearance = { ...DEFAULT_APPEARANCE };
let fabTopPct = DEFAULT_FAB_TOP_PCT;
let sessionHidden = false;
let isDrawerOpen = false;
let badgeText = '';

let rootEl = null;
let fabBtn = null;
let badgeEl = null;
let backdropEl = null;
let drawerEl = null;
let dimTimer = null;
let lastPointerHandledAt = 0;

let storageListener = null;
let fullscreenListener = null;
let resizeListener = null;
let keydownListener = null;

function clearDimTimer() {
  if (dimTimer) {
    clearTimeout(dimTimer);
    dimTimer = null;
  }
}

function scheduleFabDim() {
  clearDimTimer();
  if (!fabBtn || isDrawerOpen) return;
  fabBtn.classList.remove('yousub-fab-dimmed');
  dimTimer = setTimeout(() => {
    dimTimer = null;
    if (fabBtn && !isDrawerOpen) {
      fabBtn.classList.add('yousub-fab-dimmed');
    }
  }, FAB_DIM_DELAY_MS);
}

function getMountHost() {
  if (typeof document === 'undefined') return null;
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.body ||
    document.documentElement
  );
}

function syncMountHost() {
  if (!rootEl) return;
  const host = getMountHost();
  if (host && rootEl.parentNode !== host) {
    host.appendChild(rootEl);
  }
}

function updateFabVisualState() {
  if (!fabBtn) return;
  fabBtn.classList.toggle('yousub-fab-active', Boolean(isTranslationActive));
  fabBtn.style.top = `${clamp(fabTopPct, FAB_MIN_TOP_PCT, FAB_MAX_TOP_PCT)}%`;
  if (badgeEl) {
    badgeEl.textContent = badgeText || '';
    badgeEl.classList.toggle('hidden', !badgeText);
  }
}

async function updateAppearancePatch(patch) {
  const storage = getStorageApi();
  let existing = { ...DEFAULT_APPEARANCE };
  if (storage) {
    try {
      const res = await storage.local.get(['yousub_appearance']);
      if (res?.yousub_appearance) {
        existing = { ...existing, ...res.yousub_appearance };
      }
    } catch {
      /* keep local fallback */
    }
  }
  const next = { ...existing, ...patch };
  currentAppearance = next;
  if (storage) {
    await Promise.resolve(storage.local.set({ yousub_appearance: next })).catch(() => {});
  }
  if (typeof Overlay?.applyStyles === 'function') {
    Overlay.applyStyles(next);
  }
  return next;
}

function saveFabPosition(topPct) {
  const safeTop = Math.round(clamp(topPct, FAB_MIN_TOP_PCT, FAB_MAX_TOP_PCT) * 10) / 10;
  fabTopPct = safeTop;
  const storage = getStorageApi();
  if (storage) {
    Promise.resolve(storage.local.set({ [MOBILE_FAB_POS_KEY]: { topPct: safeTop } })).catch(
      () => {}
    );
  }
}

function stopTouchThrough(el) {
  if (!el) return;
  ['click', 'pointerdown', 'touchstart'].forEach((evt) => {
    el.addEventListener(evt, (e) => e.stopPropagation());
  });
}

function navigateToVideo(videoId, timeSec) {
  if (!videoId || typeof window === 'undefined') return;
  const safeSec = Math.max(0, Math.floor(Number(timeSec) || 0));
  const suffix = safeSec > 0 ? `&t=${safeSec}s` : '';
  const url = `${window.location.origin}/watch?v=${encodeURIComponent(videoId)}${suffix}`;
  window.location.assign(url);
}

async function renderDrawerContent() {
  if (!drawerEl || !isDrawerOpen) return;
  drawerEl.replaceChildren();

  drawerEl.appendChild(makeEl('div', 'yousub-drawer-grab'));

  // Header
  const header = makeEl('div', 'yousub-drawer-header');
  header.appendChild(makeEl('h3', 'yousub-drawer-title', 'YouSub'));
  const hdrActions = makeEl('div', 'yousub-drawer-header-actions');

  const settingsIconBtn = makeEl(
    'button',
    'yousub-drawer-icon-btn',
    msg('popupSettingsBtn', 'Settings')
  );
  settingsIconBtn.type = 'button';
  settingsIconBtn.id = 'ys-drawer-settings-btn';
  settingsIconBtn.addEventListener('click', () => {
    openSettingsPage();
  });

  const closeBtn = makeEl('button', 'yousub-drawer-icon-btn', '✕');
  closeBtn.type = 'button';
  closeBtn.id = 'ys-drawer-close-btn';
  closeBtn.setAttribute('aria-label', msg('mobileDrawerClose', 'Close controls'));
  closeBtn.addEventListener('click', () => MobileDrawer.close());

  hdrActions.appendChild(settingsIconBtn);
  hdrActions.appendChild(closeBtn);
  header.appendChild(hdrActions);
  drawerEl.appendChild(header);

  // Card 1: Subtitle Controls
  const subCard = makeEl('div', 'yousub-drawer-card');
  subCard.id = 'ys-drawer-subs';
  subCard.appendChild(
    makeEl('div', 'yousub-drawer-section-title', msg('mobileDrawerSubtitlesTitle', 'Subtitles'))
  );

  const langObj = YOUSUB_PROVIDERS.languages.find((l) => l.code === currentTargetLang);
  const langName = langObj ? langObj.name : currentTargetLang.toUpperCase();
  const translateBtn = makeEl(
    'button',
    `yousub-drawer-primary-btn${isTranslationActive ? ' yousub-btn-active' : ''}`,
    isTranslationActive
      ? msg('mobileDrawerStopTranslation', 'Stop Subtitles')
      : msg('popupTranslateTo', `Translate to ${langName}`)
  );
  translateBtn.type = 'button';
  translateBtn.id = 'ys-drawer-translate-btn';
  translateBtn.addEventListener('click', () => {
    const nextState = !isTranslationActive;
    isTranslationActive = nextState;
    updateFabVisualState();
    if (typeof callbacks.onToggleTranslation === 'function') {
      callbacks.onToggleTranslation(nextState, currentTargetLang, activeVideoId);
    }
    renderDrawerContent().catch(() => {});
  });
  subCard.appendChild(translateBtn);

  const rowModeLang = makeEl('div', 'yousub-drawer-row');
  const dualBtn = makeEl(
    'button',
    `yousub-drawer-btn${isDualMode ? ' yousub-btn-on' : ''}`,
    `${msg('popupDualSubtitles', 'Dual Subtitles')}: ${isDualMode ? 'ON' : 'OFF'}`
  );
  dualBtn.type = 'button';
  dualBtn.id = 'ys-drawer-dual-btn';
  dualBtn.setAttribute('aria-pressed', isDualMode ? 'true' : 'false');
  dualBtn.addEventListener('click', () => {
    isDualMode = !isDualMode;
    const storage = getStorageApi();
    if (storage) {
      Promise.resolve(storage.local.set({ yousub_dual_mode: isDualMode })).catch(() => {});
    }
    if (typeof callbacks.onToggleDualMode === 'function') {
      callbacks.onToggleDualMode(isDualMode);
    }
    renderDrawerContent().catch(() => {});
  });

  const langSelect = makeEl('select', 'yousub-drawer-select');
  langSelect.id = 'ys-drawer-lang-select';
  langSelect.setAttribute('aria-label', msg('optionsTargetLanguage', 'Target Language'));
  YOUSUB_PROVIDERS.languages
    .filter((l) => l.code !== 'auto')
    .forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.name;
      langSelect.appendChild(opt);
    });
  langSelect.value = currentTargetLang;
  langSelect.addEventListener('change', () => {
    currentTargetLang = langSelect.value;
    const storage = getStorageApi();
    if (storage) {
      Promise.resolve(storage.local.set({ targetLang: currentTargetLang })).catch(() => {});
    }
    if (typeof callbacks.onChangeTargetLang === 'function') {
      callbacks.onChangeTargetLang(currentTargetLang);
    }
    renderDrawerContent().catch(() => {});
  });

  rowModeLang.appendChild(dualBtn);
  rowModeLang.appendChild(langSelect);
  subCard.appendChild(rowModeLang);

  // Font size controls
  const fontRow = makeEl('div', 'yousub-drawer-row');
  const fontVal = Number(currentAppearance.fontSize) || 1.5;
  fontRow.appendChild(makeEl('span', '', msg('optionsFontSize', 'Font Size')));
  const fontControls = makeEl('div', 'yousub-drawer-chips');
  const fontDec = makeEl('button', 'yousub-drawer-btn', 'A-');
  fontDec.type = 'button';
  fontDec.id = 'ys-drawer-font-dec';
  const fontBadge = makeEl('span', 'yousub-drawer-btn', `${fontVal.toFixed(1)}em`);
  fontBadge.id = 'ys-drawer-font-val';
  const fontInc = makeEl('button', 'yousub-drawer-btn', 'A+');
  fontInc.type = 'button';
  fontInc.id = 'ys-drawer-font-inc';

  fontDec.addEventListener('click', async () => {
    const nextSize = Math.round(clamp(fontVal - 0.1, 1.0, 3.0) * 10) / 10;
    await updateAppearancePatch({ fontSize: nextSize });
    renderDrawerContent().catch(() => {});
  });
  fontInc.addEventListener('click', async () => {
    const nextSize = Math.round(clamp(fontVal + 0.1, 1.0, 3.0) * 10) / 10;
    await updateAppearancePatch({ fontSize: nextSize });
    renderDrawerContent().catch(() => {});
  });

  fontControls.appendChild(fontDec);
  fontControls.appendChild(fontBadge);
  fontControls.appendChild(fontInc);
  fontRow.appendChild(fontControls);
  subCard.appendChild(fontRow);

  // Position & touch drag controls
  const posRow = makeEl('div', 'yousub-drawer-row');
  const curBottom = Number(currentAppearance.posBottom) || 20;
  posRow.appendChild(makeEl('span', '', msg('mobileDrawerPosition', 'Position')));
  const posSlider = document.createElement('input');
  posSlider.type = 'range';
  posSlider.id = 'ys-drawer-pos-slider';
  posSlider.className = 'yousub-drawer-range';
  posSlider.min = '20';
  posSlider.max = '400';
  posSlider.step = '10';
  posSlider.value = String(clamp(curBottom, 20, 400));
  posSlider.addEventListener('input', () => {
    updateAppearancePatch({ posBottom: parseInt(posSlider.value, 10) }).catch(() => {});
  });
  posRow.appendChild(posSlider);

  const handlesVisible =
    typeof Overlay?.areTouchHandlesVisible === 'function'
      ? Overlay.areTouchHandlesVisible()
      : false;
  const dragToggleBtn = makeEl(
    'button',
    `yousub-drawer-btn${handlesVisible ? ' yousub-btn-on' : ''}`,
    msg('mobileDrawerDragHandles', 'Drag Handles')
  );
  dragToggleBtn.type = 'button';
  dragToggleBtn.id = 'ys-drawer-touch-handles-btn';
  dragToggleBtn.addEventListener('click', () => {
    if (typeof Overlay?.setTouchHandlesVisible === 'function') {
      Overlay.setTouchHandlesVisible(!Overlay.areTouchHandlesVisible());
    }
    renderDrawerContent().catch(() => {});
  });

  const resetPosBtn = makeEl(
    'button',
    'yousub-drawer-btn',
    msg('mobileDrawerResetPos', 'Reset Position')
  );
  resetPosBtn.type = 'button';
  resetPosBtn.id = 'ys-drawer-reset-layout-btn';
  resetPosBtn.addEventListener('click', () => {
    if (typeof Overlay?.resetLayout === 'function') {
      Overlay.resetLayout();
    }
    if (typeof Overlay?.setTouchHandlesVisible === 'function') {
      Overlay.setTouchHandlesVisible(false);
    }
    updateAppearancePatch({ posBottom: DEFAULT_APPEARANCE.posBottom }).catch(() => {});
    renderDrawerContent().catch(() => {});
  });

  posRow.appendChild(dragToggleBtn);
  posRow.appendChild(resetPosBtn);
  subCard.appendChild(posRow);
  drawerEl.appendChild(subCard);

  // Card 2: Playback & Auto-Resume
  const resumeCard = makeEl('div', 'yousub-drawer-card');
  resumeCard.id = 'ys-drawer-resume';

  const resumeState = await Promise.resolve(PlaybackResume?.getCurrentState?.()).catch(() => null);
  const resumeEnabled = resumeState?.settings?.enabled !== false;
  const record = resumeState?.record || null;

  const resumeHeader = makeEl('div', 'yousub-drawer-row');
  resumeHeader.appendChild(
    makeEl('div', 'yousub-drawer-section-title', msg('popupResumeTitle', 'Playback Resume'))
  );

  const resumeHdrBtns = makeEl('div', 'yousub-drawer-chips');
  const resumeToggleBtn = makeEl(
    'button',
    `yousub-drawer-btn${resumeEnabled ? ' yousub-btn-on' : ''}`,
    resumeEnabled ? 'Auto: ON' : 'Auto: OFF'
  );
  resumeToggleBtn.type = 'button';
  resumeToggleBtn.id = 'ys-drawer-resume-toggle';
  resumeToggleBtn.addEventListener('click', async () => {
    await PlaybackResumeStore.saveSettings({ enabled: !resumeEnabled });
    renderDrawerContent().catch(() => {});
  });
  resumeHdrBtns.appendChild(resumeToggleBtn);

  if (!isShortsPath() && activeVideoId) {
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.id = 'ys-drawer-bookmark-note';
    noteInput.className = 'yousub-drawer-select';
    noteInput.maxLength = 80;
    noteInput.placeholder = msg('popupResumeBookmarkNotePlaceholder', 'Note (optional)...');
    resumeHdrBtns.appendChild(noteInput);

    const bookmarkBtn = makeEl(
      'button',
      'yousub-drawer-btn yousub-pill-primary',
      msg('popupResumeBookmarkBtn', '+ Bookmark')
    );
    bookmarkBtn.type = 'button';
    bookmarkBtn.id = 'ys-drawer-bookmark-btn';
    bookmarkBtn.addEventListener('click', async () => {
      const customNote = (noteInput.value || '').trim();
      await PlaybackResume.addCurrentBookmark(customNote);
      noteInput.value = '';
      renderDrawerContent().catch(() => {});
    });
    resumeHdrBtns.appendChild(bookmarkBtn);
  }
  resumeHeader.appendChild(resumeHdrBtns);
  resumeCard.appendChild(resumeHeader);

  if (!isShortsPath() && activeVideoId) {
    if (resumeState?.playbackRate && Math.abs(resumeState.playbackRate - 1) >= 0.01) {
      resumeCard.appendChild(
        makeEl(
          'div',
          'yousub-drawer-chips',
          `${msg('popupResumeSpeedLabel', 'Speed')}: ${resumeState.playbackRate}x`
        )
      );
    }
    const pills = buildQuickJumpPills(record, msg);
    if (pills.length > 0) {
      const pillRow = makeEl('div', 'yousub-drawer-chips');
      pillRow.id = 'ys-drawer-quick-pills';
      pills.forEach((p) => {
        const pillBtn = makeEl(
          'button',
          `yousub-drawer-btn${p.primary ? ' yousub-pill-primary' : ''}`,
          `${p.label} ${formatTimestamp(p.timeSec)}`
        );
        pillBtn.type = 'button';
        pillBtn.addEventListener('click', async () => {
          await PlaybackResume.seekTo(p.timeSec, { allowResetToZero: p.timeSec === 0 });
          renderDrawerContent().catch(() => {});
        });
        pillRow.appendChild(pillBtn);
      });
      resumeCard.appendChild(pillRow);
    }

    const bookmarks = Array.isArray(record?.bookmarks) ? record.bookmarks : [];
    if (bookmarks.length > 0) {
      const bmRow = makeEl('div', 'yousub-drawer-chips');
      bmRow.id = 'ys-drawer-bookmarks';
      bookmarks.forEach((bm) => {
        const chip = makeEl('span', 'yousub-drawer-bookmark-chip');
        const jumpBtn = makeEl(
          'button',
          'yousub-drawer-bookmark-jump',
          `${formatTimestamp(bm.timeSec)} ${bm.label || ''}`.trim()
        );
        jumpBtn.type = 'button';
        jumpBtn.addEventListener('click', async () => {
          await PlaybackResume.seekTo(bm.timeSec);
          renderDrawerContent().catch(() => {});
        });
        const editBtn = makeEl('button', 'yousub-drawer-bookmark-jump', '✎');
        editBtn.type = 'button';
        editBtn.setAttribute('aria-label', `Edit bookmark ${bm.label || ''}`.trim());
        editBtn.addEventListener('click', () => {
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.className = 'yousub-drawer-select';
          inp.maxLength = 80;
          inp.value = bm.label || '';
          const saveEdit = async () => {
            await PlaybackResumeStore.updateBookmarkLabel(activeVideoId, bm.id, inp.value);
            renderDrawerContent().catch(() => {});
          };
          inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveEdit();
          });
          const saveBtn = makeEl('button', 'yousub-drawer-bookmark-jump', '✓');
          saveBtn.type = 'button';
          saveBtn.addEventListener('click', saveEdit);
          chip.replaceChildren(inp, saveBtn);
          inp.focus();
        });

        const delBtn = makeEl('button', 'yousub-drawer-bookmark-del', '×');
        delBtn.type = 'button';
        delBtn.setAttribute('aria-label', `Remove bookmark ${bm.label || ''}`.trim());
        delBtn.addEventListener('click', async () => {
          await PlaybackResumeStore.removeBookmark(activeVideoId, bm.id);
          renderDrawerContent().catch(() => {});
        });
        chip.appendChild(jumpBtn);
        chip.appendChild(editBtn);
        chip.appendChild(delBtn);
        bmRow.appendChild(chip);
      });
      resumeCard.appendChild(bmRow);
    }

    const checkpoints = Array.isArray(record?.checkpoints) ? record.checkpoints : [];
    if (checkpoints.length > 0) {
      const cpRow = makeEl('div', 'yousub-drawer-chips');
      cpRow.id = 'ys-drawer-checkpoints';
      cpRow.appendChild(
        makeEl('span', '', `${msg('popupResumeCheckpointsLabel', 'Checkpoints')}:`)
      );
      checkpoints.forEach((cp) => {
        const cpBtn = makeEl('button', 'yousub-drawer-btn', formatTimestamp(cp.timeSec));
        cpBtn.type = 'button';
        cpBtn.addEventListener('click', async () => {
          await PlaybackResume.seekTo(cp.timeSec);
          renderDrawerContent().catch(() => {});
        });
        cpRow.appendChild(cpBtn);
      });
      resumeCard.appendChild(cpRow);
    }
  }

  // Extension slot for subsequent Audiobook/Mobile addons (Phases 87–88)
  if (addons.size > 0) {
    const addonHost = makeEl('div', 'yousub-drawer-row');
    addonHost.id = 'ys-drawer-addons';
    for (const renderFn of addons.values()) {
      try {
        await Promise.resolve(
          renderFn(addonHost, {
            videoId: activeVideoId,
            record,
            refresh: () => renderDrawerContent().catch(() => {}),
          })
        );
      } catch {
        /* isolate addon errors */
      }
    }
    if (addonHost.children.length > 0) {
      resumeCard.appendChild(addonHost);
    }
  }

  // Recent Audio/Videos list
  const recents = await PlaybackResumeStore.listRecentVideos(6);
  const recentHeader = makeEl('div', 'yousub-drawer-row');
  recentHeader.appendChild(
    makeEl(
      'span',
      'yousub-drawer-section-title',
      `${msg('popupResumeRecentTitle', 'Recent Audio / Videos')} (${recents.length})`
    )
  );
  resumeCard.appendChild(recentHeader);

  if (recents.length === 0) {
    resumeCard.appendChild(
      makeEl('div', '', msg('popupResumeNoRecent', 'No saved playback positions yet.'))
    );
  } else {
    recents.forEach((rec) => {
      const row = makeEl('div', 'yousub-drawer-recent-row');
      const mainBtn = makeEl('button', 'yousub-drawer-recent-main');
      mainBtn.type = 'button';
      mainBtn.appendChild(makeEl('div', 'yousub-drawer-recent-title', rec.title || rec.videoId));
      const curSec = Math.floor(Number(rec.lastTimeSec || rec.furthestTimeSec) || 0);
      const durSec = Math.floor(Number(rec.durationSec) || 0);
      mainBtn.appendChild(
        makeEl(
          'div',
          'yousub-drawer-recent-meta',
          durSec > 0
            ? `${formatTimestamp(curSec)} / ${formatTimestamp(durSec)}`
            : formatTimestamp(curSec)
        )
      );
      if (durSec > 0) {
        const bar = makeEl('div', 'yousub-drawer-progress');
        const fill = makeEl('div', 'yousub-drawer-progress-fill');
        fill.style.width = `${clamp(Math.round((curSec / durSec) * 100), 0, 100)}%`;
        bar.appendChild(fill);
        mainBtn.appendChild(bar);
      }
      mainBtn.addEventListener('click', () => {
        if (rec.videoId === activeVideoId) {
          PlaybackResume.seekTo(curSec).then(() => renderDrawerContent().catch(() => {}));
        } else {
          navigateToVideo(rec.videoId, curSec);
        }
      });

      const delBtn = makeEl('button', 'yousub-drawer-bookmark-del', '×');
      delBtn.type = 'button';
      delBtn.setAttribute('aria-label', `Remove ${rec.title || rec.videoId}`);
      delBtn.addEventListener('click', async () => {
        await PlaybackResumeStore.clearVideoRecord(rec.videoId);
        renderDrawerContent().catch(() => {});
      });

      row.appendChild(mainBtn);
      row.appendChild(delBtn);
      resumeCard.appendChild(row);
    });
  }

  drawerEl.appendChild(resumeCard);

  // Footer
  const footer = makeEl('div', 'yousub-drawer-footer');
  const hideBtn = makeEl(
    'button',
    'yousub-drawer-btn',
    msg('mobileDrawerHidePill', 'Hide Floating Pill')
  );
  hideBtn.type = 'button';
  hideBtn.id = 'ys-drawer-hide-fab-btn';
  hideBtn.addEventListener('click', () => {
    sessionHidden = true;
    MobileDrawer.close();
    teardownDom();
  });

  const fullOptBtn = makeEl(
    'button',
    'yousub-drawer-btn',
    msg('mobileDrawerOpenOptions', 'Full Settings')
  );
  fullOptBtn.type = 'button';
  fullOptBtn.id = 'ys-drawer-footer-settings-btn';
  fullOptBtn.addEventListener('click', () => openSettingsPage());

  footer.appendChild(hideBtn);
  footer.appendChild(fullOptBtn);
  drawerEl.appendChild(footer);
}

function openSettingsPage() {
  if (typeof callbacks.onOpenSettings === 'function') {
    callbacks.onOpenSettings();
    return;
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'YOUSUB_OPEN_SETTINGS' });
    }
  } catch {
    /* ignore */
  }
}

function attachFabPointerHandlers(btn) {
  let dragStartY = 0;
  let dragStartTopPct = fabTopPct;
  let moved = false;
  let activePointerId = null;

  btn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    clearDimTimer();
    btn.classList.remove('yousub-fab-dimmed');
    dragStartY = Number(e.clientY) || 0;
    dragStartTopPct = fabTopPct;
    moved = false;
    activePointerId = e.pointerId ?? null;
    if (activePointerId !== null && typeof btn.setPointerCapture === 'function') {
      try {
        btn.setPointerCapture(activePointerId);
      } catch {
        /* ignore in jsdom */
      }
    }
  });

  btn.addEventListener('pointermove', (e) => {
    if (activePointerId === null && e.buttons === 0) return;
    const dy = (Number(e.clientY) || 0) - dragStartY;
    if (!moved && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    moved = true;
    e.preventDefault();
    e.stopPropagation();
    const vh = (typeof window !== 'undefined' ? window.innerHeight : 0) || 800;
    fabTopPct = clamp(dragStartTopPct + (dy / vh) * 100, FAB_MIN_TOP_PCT, FAB_MAX_TOP_PCT);
    btn.style.top = `${fabTopPct}%`;
  });

  const endPointer = (e) => {
    e.stopPropagation();
    if (activePointerId !== null && typeof btn.releasePointerCapture === 'function') {
      try {
        btn.releasePointerCapture(activePointerId);
      } catch {
        /* ignore */
      }
    }
    activePointerId = null;
    lastPointerHandledAt = Date.now();
    if (moved) {
      moved = false;
      saveFabPosition(fabTopPct);
      scheduleFabDim();
      return;
    }
    MobileDrawer.toggle();
  };

  btn.addEventListener('pointerup', endPointer);
  btn.addEventListener('pointercancel', endPointer);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Avoid double-toggling after pointerup already handled the tap, while
    // supporting synthetic element.click() and keyboard Enter/Space activation.
    if (Date.now() - lastPointerHandledAt < 350) return;
    MobileDrawer.toggle();
  });
}

function mountDom() {
  if (rootEl || typeof document === 'undefined') return;
  const host = getMountHost();
  if (!host) return;

  rootEl = document.createElement('div');
  rootEl.id = 'yousub-mobile-fab-root';

  fabBtn = makeEl('button', '');
  fabBtn.type = 'button';
  fabBtn.id = 'yousub-mobile-fab';
  fabBtn.setAttribute('aria-label', msg('mobileDrawerOpen', 'Open YouSub controls'));

  const dot = makeEl('span', 'yousub-fab-dot');
  const label = makeEl('span', 'yousub-fab-label', 'YS');
  badgeEl = makeEl('span', 'yousub-fab-badge hidden', '');
  fabBtn.appendChild(dot);
  fabBtn.appendChild(label);
  fabBtn.appendChild(badgeEl);
  attachFabPointerHandlers(fabBtn);

  backdropEl = makeEl('div', 'hidden');
  backdropEl.id = 'yousub-mobile-backdrop';
  backdropEl.addEventListener('click', (e) => {
    e.stopPropagation();
    MobileDrawer.close();
  });

  drawerEl = makeEl('div', 'hidden');
  drawerEl.id = 'yousub-mobile-drawer';
  drawerEl.setAttribute('role', 'dialog');
  drawerEl.setAttribute('aria-modal', 'true');
  drawerEl.setAttribute('aria-label', msg('mobileDrawerAriaLabel', 'YouSub Mobile Controls'));
  stopTouchThrough(drawerEl);

  rootEl.appendChild(backdropEl);
  rootEl.appendChild(drawerEl);
  rootEl.appendChild(fabBtn);
  host.appendChild(rootEl);

  updateFabVisualState();
  scheduleFabDim();
}

function teardownDom() {
  clearDimTimer();
  isDrawerOpen = false;
  if (rootEl && rootEl.parentNode) {
    rootEl.parentNode.removeChild(rootEl);
  }
  rootEl = null;
  fabBtn = null;
  badgeEl = null;
  backdropEl = null;
  drawerEl = null;
}

function evaluateVisibility() {
  if (!activeVideoId || sessionHidden) {
    teardownDom();
    return false;
  }
  const visible = shouldShowMobileFab({
    showDesktopFab: Boolean(currentAppearance?.showDesktopFab),
  });
  if (visible) {
    mountDom();
  } else {
    teardownDom();
  }
  return visible;
}

function detachListeners() {
  const storage = getStorageApi();
  if (storageListener && storage?.onChanged?.removeListener) {
    try {
      storage.onChanged.removeListener(storageListener);
    } catch {
      /* ignore */
    }
  }
  storageListener = null;

  if (fullscreenListener && typeof document !== 'undefined') {
    document.removeEventListener('fullscreenchange', fullscreenListener);
    document.removeEventListener('webkitfullscreenchange', fullscreenListener);
  }
  fullscreenListener = null;

  if (resizeListener && typeof window !== 'undefined') {
    window.removeEventListener('resize', resizeListener);
  }
  resizeListener = null;

  if (keydownListener && typeof document !== 'undefined') {
    document.removeEventListener('keydown', keydownListener);
  }
  keydownListener = null;
}

export const MobileDrawer = {
  init(cb = {}) {
    callbacks = { ...cb };
  },

  async onEnter(videoId) {
    this.onLeave();
    if (!videoId) return;

    activeVideoId = videoId;
    const storage = getStorageApi();
    if (storage) {
      try {
        const res = await storage.local.get([
          'yousub_appearance',
          'targetLang',
          'yousub_dual_mode',
          MOBILE_FAB_POS_KEY,
        ]);
        if (activeVideoId !== videoId) return;
        currentAppearance = { ...DEFAULT_APPEARANCE, ...(res?.yousub_appearance || {}) };
        currentTargetLang = res?.targetLang || 'vi';
        isDualMode = Boolean(res?.yousub_dual_mode);
        if (typeof res?.[MOBILE_FAB_POS_KEY]?.topPct === 'number') {
          fabTopPct = clamp(res[MOBILE_FAB_POS_KEY].topPct, FAB_MIN_TOP_PCT, FAB_MAX_TOP_PCT);
        }
      } catch {
        /* keep defaults */
      }
    }

    if (typeof callbacks.getTranslationState === 'function') {
      const st = callbacks.getTranslationState();
      if (st) {
        isTranslationActive = Boolean(st.isTranslationActive);
        if (typeof st.isDualMode === 'boolean') isDualMode = st.isDualMode;
      }
    }

    evaluateVisibility();

    storageListener = (changes, area) => {
      if (area !== 'local' && area !== 'sync') return;
      if (changes.yousub_appearance?.newValue) {
        currentAppearance = { ...DEFAULT_APPEARANCE, ...changes.yousub_appearance.newValue };
        evaluateVisibility();
      }
      if (changes.targetLang?.newValue) {
        currentTargetLang = changes.targetLang.newValue;
      }
      if (changes.yousub_dual_mode !== undefined) {
        isDualMode = Boolean(changes.yousub_dual_mode.newValue);
      }
      const relevantResume =
        RESUME_STORAGE_KEY in changes ||
        RESUME_SYNC_KEY in changes ||
        RESUME_SETTINGS_KEY in changes;
      if (
        isDrawerOpen &&
        (changes.yousub_appearance ||
          changes.targetLang ||
          changes.yousub_dual_mode ||
          relevantResume)
      ) {
        renderDrawerContent().catch(() => {});
      }
    };
    if (storage?.onChanged?.addListener) {
      storage.onChanged.addListener(storageListener);
    }

    fullscreenListener = () => syncMountHost();
    if (typeof document !== 'undefined') {
      document.addEventListener('fullscreenchange', fullscreenListener);
      document.addEventListener('webkitfullscreenchange', fullscreenListener);
    }

    resizeListener = () => evaluateVisibility();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', resizeListener);
    }

    keydownListener = (e) => {
      if (e.key === 'Escape' && isDrawerOpen) {
        MobileDrawer.close();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', keydownListener);
    }
  },

  onLeave() {
    activeVideoId = null;
    detachListeners();
    teardownDom();
  },

  destroy() {
    this.onLeave();
    callbacks = {};
    addons = new Map();
    sessionHidden = false;
    isTranslationActive = false;
    isDualMode = false;
    currentTargetLang = 'vi';
    currentAppearance = { ...DEFAULT_APPEARANCE };
    fabTopPct = DEFAULT_FAB_TOP_PCT;
    badgeText = '';
    lastPointerHandledAt = 0;
  },

  open() {
    if (!rootEl) mountDom();
    if (!drawerEl || !backdropEl) return;
    isDrawerOpen = true;
    clearDimTimer();
    if (fabBtn) fabBtn.classList.remove('yousub-fab-dimmed');
    backdropEl.classList.remove('hidden');
    drawerEl.classList.remove('hidden');
    renderDrawerContent().catch(() => {});
  },

  close() {
    isDrawerOpen = false;
    if (backdropEl) backdropEl.classList.add('hidden');
    if (drawerEl) drawerEl.classList.add('hidden');
    scheduleFabDim();
  },

  toggle() {
    if (isDrawerOpen) {
      this.close();
    } else {
      this.open();
    }
  },

  setTranslationActive(active) {
    isTranslationActive = Boolean(active);
    updateFabVisualState();
    if (isDrawerOpen) renderDrawerContent().catch(() => {});
  },

  setDualMode(dual) {
    isDualMode = Boolean(dual);
    if (isDrawerOpen) renderDrawerContent().catch(() => {});
  },

  setBadgeText(text) {
    badgeText = text ? String(text) : '';
    updateFabVisualState();
  },

  refresh() {
    if (isDrawerOpen) renderDrawerContent().catch(() => {});
  },

  registerAddon(key, renderFn) {
    if (!key || typeof renderFn !== 'function') return;
    addons.set(key, renderFn);
    if (isDrawerOpen) renderDrawerContent().catch(() => {});
  },

  isOpen() {
    return isDrawerOpen;
  },

  isVisible() {
    return Boolean(rootEl && fabBtn);
  },
};

if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.MobileDrawer = MobileDrawer;
}
