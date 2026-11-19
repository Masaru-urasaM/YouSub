import '../shared/libs/browser-polyfill.js';
import { RESUME_STORAGE_KEY, RESUME_SYNC_KEY, RESUME_SETTINGS_KEY } from '../shared/constants.js';
import { PlaybackResumeStore, formatTimestamp } from '../shared/playback-resume-store.js';
import { Logger } from '../shared/logger.js';

const RESUME_CHANGE_KEYS = new Set([RESUME_STORAGE_KEY, RESUME_SYNC_KEY, RESUME_SETTINGS_KEY]);

/**
 * Parse a tab URL to determine whether it is a YouTube `/watch` page
 * (eligible for long-video bookmarks & resume) or `/shorts/` / other.
 * @param {string} urlStr
 * @returns {{ videoId: string | null, isWatch: boolean, isShorts: boolean }}
 */
export function parseWatchUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    return { videoId: null, isWatch: false, isShorts: false };
  }
  try {
    const url = new URL(urlStr);
    const host = (url.hostname || '').toLowerCase();
    const isYoutubeHost = host === 'youtube.com' || host.endsWith('.youtube.com');
    if (!isYoutubeHost) {
      return { videoId: null, isWatch: false, isShorts: false };
    }
    if (url.pathname === '/watch') {
      const videoId = url.searchParams.get('v') || null;
      return { videoId, isWatch: Boolean(videoId), isShorts: false };
    }
    if (url.pathname.startsWith('/shorts/')) {
      const videoId = url.pathname.split('/')[2] || null;
      return { videoId, isWatch: false, isShorts: true };
    }
  } catch {
    // Ignore malformed URLs
  }
  return { videoId: null, isWatch: false, isShorts: false };
}

/**
 * Build deduplicated quick-jump pill descriptors for the current video record.
 * @param {object | null} record
 * @param {(key: string, fallback?: string) => string} msgFn
 * @returns {Array<{ id: string, label: string, timeSec: number, primary: boolean }>}
 */
export function buildQuickJumpPills(record, msgFn = (_k, fb) => fb || '') {
  if (!record || typeof record !== 'object') return [];
  const pills = [];
  const lastSec = Math.floor(Number(record.lastTimeSec) || 0);
  const activeSec = Math.floor(Number(record.lastInteractionTimeSec) || 0);
  const furthestSec = Math.floor(Number(record.furthestTimeSec) || 0);

  if (lastSec > 0) {
    pills.push({
      id: 'last',
      label: msgFn('popupResumeLastLabel', 'Last'),
      timeSec: lastSec,
      primary: true,
    });
  }
  if (activeSec > 0 && Math.abs(activeSec - lastSec) >= 3) {
    pills.push({
      id: 'active',
      label: msgFn('popupResumeActiveLabel', 'Last Active'),
      timeSec: activeSec,
      primary: false,
    });
  }
  if (furthestSec > 0 && Math.abs(furthestSec - lastSec) >= 3) {
    pills.push({
      id: 'furthest',
      label: msgFn('popupResumeFurthestLabel', 'Furthest'),
      timeSec: furthestSec,
      primary: false,
    });
  }
  return pills;
}

function defaultMsgFn(i18nFn) {
  return (key, fallback = '') => {
    if (typeof i18nFn === 'function') {
      const val = i18nFn(key, fallback);
      if (val) return val;
    }
    try {
      if (typeof browser !== 'undefined' && browser.i18n?.getMessage) {
        return browser.i18n.getMessage(key) || fallback;
      }
    } catch {
      // Ignore outside extension context
    }
    return fallback;
  };
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (typeof text === 'string') el.textContent = text;
  return el;
}

let activeStorageListener = null;

export const PopupResumeView = {
  /**
   * Initialize the Playback Resume card inside popup.html.
   * @param {{ activeTab?: { id?: number, url?: string }, i18n?: Function }} [opts]
   */
  async init(opts = {}) {
    const section = document.getElementById('resume-section');
    if (!section) return null;

    const msg = defaultMsgFn(opts.i18n);
    const els = {
      section,
      autoToggle: document.getElementById('resume-auto-toggle'),
      addBookmarkBtn: document.getElementById('resume-add-bookmark-btn'),
      activePanel: document.getElementById('resume-active-panel'),
      quickPills: document.getElementById('resume-quick-pills'),
      bookmarksList: document.getElementById('resume-bookmarks-list'),
      checkpointsWrap: document.getElementById('resume-checkpoints-wrap'),
      checkpointsList: document.getElementById('resume-checkpoints-list'),
      recentToggle: document.getElementById('resume-recent-toggle'),
      recentCount: document.getElementById('resume-recent-count'),
      recentList: document.getElementById('resume-recent-list'),
    };

    let activeTab = opts.activeTab || null;
    if (!activeTab) {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        activeTab = tabs?.[0] || null;
      } catch {
        activeTab = null;
      }
    }

    const tabInfo = parseWatchUrl(activeTab?.url || '');
    let liveState = null;

    async function sendToActiveTab(payload) {
      if (!activeTab || activeTab.id == null) return null;
      try {
        return await browser.tabs.sendMessage(activeTab.id, payload);
      } catch {
        return null;
      }
    }

    async function seekCurrentOrOpen(videoId, timeSec) {
      const targetSec = Math.max(0, Math.floor(Number(timeSec) || 0));
      if (tabInfo.isWatch && tabInfo.videoId === videoId && activeTab?.id != null) {
        const res = await sendToActiveTab({
          type: 'YOUSUB_RESUME_SEEK_TO',
          timeSec: targetSec,
          allowResetToZero: targetSec === 0,
        });
        if (res?.ok) {
          await refresh();
          return true;
        }
      }

      const suffix = targetSec > 0 ? `&t=${targetSec}s` : '';
      const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}${suffix}`;
      try {
        await browser.tabs.create({ url });
        return true;
      } catch (err) {
        Logger.warn('PopupResume', 'Failed to open video tab', {
          videoId,
          error: err?.message,
        });
        return false;
      }
    }

    function renderActiveVideo(record) {
      if (!els.activePanel || !els.addBookmarkBtn) return;

      if (!tabInfo.isWatch || !tabInfo.videoId) {
        els.addBookmarkBtn.classList.add('hidden');
        els.activePanel.classList.add('hidden');
        return;
      }

      els.addBookmarkBtn.classList.remove('hidden');

      const pills = buildQuickJumpPills(record, msg);
      const bookmarks = Array.isArray(record?.bookmarks) ? record.bookmarks : [];
      const checkpoints = Array.isArray(record?.checkpoints) ? record.checkpoints : [];

      if (els.quickPills) {
        els.quickPills.replaceChildren();
        for (const pill of pills) {
          const btn = createEl(
            'button',
            pill.primary ? 'resume-pill resume-pill-primary' : 'resume-pill',
            `${pill.label} ${formatTimestamp(pill.timeSec)}`
          );
          btn.type = 'button';
          btn.dataset.timeSec = String(pill.timeSec);
          btn.addEventListener('click', () => {
            seekCurrentOrOpen(tabInfo.videoId, pill.timeSec);
          });
          els.quickPills.appendChild(btn);
        }
      }

      if (els.bookmarksList) {
        els.bookmarksList.replaceChildren();
        if (bookmarks.length > 0) {
          els.bookmarksList.classList.remove('hidden');
          for (const bm of bookmarks) {
            const chip = createEl('span', 'resume-bookmark-chip');
            const jumpBtn = createEl(
              'button',
              'resume-bookmark-jump',
              `${formatTimestamp(bm.timeSec)} ${bm.label || ''}`.trim()
            );
            jumpBtn.type = 'button';
            jumpBtn.title = bm.label || formatTimestamp(bm.timeSec);
            jumpBtn.addEventListener('click', () => {
              seekCurrentOrOpen(tabInfo.videoId, bm.timeSec);
            });

            const delBtn = createEl('button', 'resume-bookmark-del', '×');
            delBtn.type = 'button';
            delBtn.setAttribute('aria-label', `Remove bookmark ${bm.label || ''}`.trim());
            delBtn.addEventListener('click', async () => {
              await PlaybackResumeStore.removeBookmark(tabInfo.videoId, bm.id);
              await refresh();
            });

            chip.appendChild(jumpBtn);
            chip.appendChild(delBtn);
            els.bookmarksList.appendChild(chip);
          }
        } else {
          els.bookmarksList.classList.add('hidden');
        }
      }

      if (els.checkpointsWrap && els.checkpointsList) {
        els.checkpointsList.replaceChildren();
        if (checkpoints.length > 0) {
          els.checkpointsWrap.classList.remove('hidden');
          for (const cp of checkpoints) {
            const cpBtn = createEl('button', 'resume-pill', formatTimestamp(cp.timeSec));
            cpBtn.type = 'button';
            cpBtn.addEventListener('click', () => {
              seekCurrentOrOpen(tabInfo.videoId, cp.timeSec);
            });
            els.checkpointsList.appendChild(cpBtn);
          }
        } else {
          els.checkpointsWrap.classList.add('hidden');
        }
      }

      const hasContent = pills.length > 0 || bookmarks.length > 0 || checkpoints.length > 0;
      els.activePanel.classList.toggle('hidden', !hasContent);
    }

    function renderRecentVideos(recents) {
      if (els.recentCount) {
        els.recentCount.textContent = String(recents.length);
      }
      if (!els.recentList) return;
      els.recentList.replaceChildren();

      if (recents.length === 0) {
        const empty = createEl(
          'div',
          'resume-empty',
          msg('popupResumeNoRecent', 'No saved playback positions yet.')
        );
        els.recentList.appendChild(empty);
        return;
      }

      for (const rec of recents) {
        const row = createEl('div', 'resume-recent-row');
        const mainBtn = createEl('button', 'resume-recent-main');
        mainBtn.type = 'button';

        const titleEl = createEl('div', 'resume-recent-title', rec.title || rec.videoId);
        const curSec = Math.floor(Number(rec.lastTimeSec || rec.furthestTimeSec) || 0);
        const durSec = Math.floor(Number(rec.durationSec) || 0);
        const metaText =
          durSec > 0
            ? `${formatTimestamp(curSec)} / ${formatTimestamp(durSec)}`
            : formatTimestamp(curSec);
        const metaEl = createEl('div', 'resume-recent-meta', metaText);

        mainBtn.appendChild(titleEl);
        mainBtn.appendChild(metaEl);

        if (durSec > 0) {
          const pct = Math.max(0, Math.min(100, Math.round((curSec / durSec) * 100)));
          const bar = createEl('div', 'resume-progress-bar');
          const fill = createEl('div', 'resume-progress-fill');
          fill.style.width = `${pct}%`;
          bar.appendChild(fill);
          mainBtn.appendChild(bar);
        }

        mainBtn.addEventListener('click', () => {
          seekCurrentOrOpen(rec.videoId, curSec);
        });

        const delBtn = createEl('button', 'resume-recent-del', '×');
        delBtn.type = 'button';
        delBtn.setAttribute('aria-label', `Remove ${rec.title || rec.videoId}`);
        delBtn.addEventListener('click', async () => {
          await PlaybackResumeStore.clearVideoRecord(rec.videoId);
          await refresh();
        });

        row.appendChild(mainBtn);
        row.appendChild(delBtn);
        els.recentList.appendChild(row);
      }
    }

    async function refresh() {
      const settings = await PlaybackResumeStore.getSettings();
      if (els.autoToggle) {
        els.autoToggle.checked = settings.enabled !== false;
      }

      let activeRecord = null;
      if (tabInfo.isWatch && tabInfo.videoId) {
        const [tabRes, stored] = await Promise.all([
          sendToActiveTab({ type: 'YOUSUB_RESUME_GET_STATE' }),
          PlaybackResumeStore.getVideoRecord(tabInfo.videoId),
        ]);
        liveState = tabRes || null;
        activeRecord = liveState?.record || stored?.mergedRecord || null;
      }
      renderActiveVideo(activeRecord);

      const recents = await PlaybackResumeStore.listRecentVideos(10);
      renderRecentVideos(recents);
    }

    if (els.autoToggle) {
      els.autoToggle.addEventListener('change', async () => {
        await PlaybackResumeStore.saveSettings({ enabled: Boolean(els.autoToggle.checked) });
      });
    }

    if (els.addBookmarkBtn) {
      els.addBookmarkBtn.addEventListener('click', async () => {
        if (!tabInfo.isWatch || !tabInfo.videoId) return;
        els.addBookmarkBtn.disabled = true;
        try {
          const tabRes = await sendToActiveTab({
            type: 'YOUSUB_RESUME_ADD_BOOKMARK',
            label: '',
          });
          if (!tabRes || !tabRes.ok) {
            await PlaybackResumeStore.addBookmark(tabInfo.videoId, {
              timeSec: Number(liveState?.currentTimeSec) || 0,
              label: '',
              title: liveState?.title || '',
              durationSec: Number(liveState?.durationSec) || 0,
            });
          }
          await refresh();
        } finally {
          els.addBookmarkBtn.disabled = false;
        }
      });
    }

    if (els.recentToggle && els.recentList) {
      els.recentToggle.addEventListener('click', () => {
        const willExpand = els.recentList.classList.contains('hidden');
        els.recentList.classList.toggle('hidden', !willExpand);
        els.recentToggle.setAttribute('aria-expanded', willExpand ? 'true' : 'false');
      });
    }

    if (activeStorageListener && browser.storage?.onChanged?.removeListener) {
      try {
        browser.storage.onChanged.removeListener(activeStorageListener);
      } catch {
        // Ignore
      }
    }

    activeStorageListener = (changes, area) => {
      if (area !== 'local' && area !== 'sync') return;
      const relevant = Object.keys(changes || {}).some((key) => RESUME_CHANGE_KEYS.has(key));
      if (relevant) {
        refresh().catch(() => {});
      }
    };
    if (browser.storage?.onChanged?.addListener) {
      browser.storage.onChanged.addListener(activeStorageListener);
    }

    await refresh();

    return {
      refresh,
      destroy() {
        if (activeStorageListener && browser.storage?.onChanged?.removeListener) {
          try {
            browser.storage.onChanged.removeListener(activeStorageListener);
          } catch {
            // Ignore
          }
          activeStorageListener = null;
        }
      },
    };
  },
};
