import '../shared/libs/browser-polyfill.js';
import { RESUME_STORAGE_KEY, RESUME_SYNC_KEY, RESUME_SETTINGS_KEY } from '../shared/constants.js';
import {
  PlaybackResumeStore,
  buildQuickJumpPills,
  formatTimestamp,
  formatCountdown,
  SLEEP_TIMER_PRESETS,
} from '../shared/playback-resume-store.js';
import { Logger } from '../shared/logger.js';

export { buildQuickJumpPills };

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
      bookmarkNoteInput: document.getElementById('resume-bookmark-note'),
      speedBadge: document.getElementById('resume-speed-badge'),
      quickPills: document.getElementById('resume-quick-pills'),
      bookmarksList: document.getElementById('resume-bookmarks-list'),
      checkpointsWrap: document.getElementById('resume-checkpoints-wrap'),
      checkpointsList: document.getElementById('resume-checkpoints-list'),
      abBadge: document.getElementById('resume-ab-badge'),
      abSetABtn: document.getElementById('resume-ab-set-a-btn'),
      abSetBBtn: document.getElementById('resume-ab-set-b-btn'),
      abClearBtn: document.getElementById('resume-ab-clear-btn'),
      sleepBadge: document.getElementById('resume-sleep-badge'),
      sleepPresets: document.getElementById('resume-sleep-presets'),
      sleepCustomInput: document.getElementById('resume-sleep-custom-min'),
      sleepCustomBtn: document.getElementById('resume-sleep-custom-btn'),
      sleepOffBtn: document.getElementById('resume-sleep-off-btn'),
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
    let sleepCountdownInterval = null;

    function stopSleepCountdown() {
      if (sleepCountdownInterval) {
        clearInterval(sleepCountdownInterval);
        sleepCountdownInterval = null;
      }
    }

    function renderSleepTimerState(sleepState) {
      if (!els.sleepBadge) return;
      const st = sleepState || {};
      const active = Boolean(st.active);
      if (active) {
        const rem =
          st.endAt && st.endAt > Date.now()
            ? Math.max(0, Math.ceil((st.endAt - Date.now()) / 1000))
            : Math.max(0, Number(st.remainingSec) || 0);
        els.sleepBadge.textContent = st.isFading
          ? msg('popupResumeSleepFading', 'Fading...')
          : formatCountdown(rem);
        els.sleepBadge.classList.add('is-active');
        if (els.sleepOffBtn) els.sleepOffBtn.classList.remove('hidden');
      } else {
        els.sleepBadge.textContent = msg('popupResumeSleepOff', 'Off');
        els.sleepBadge.classList.remove('is-active');
        if (els.sleepOffBtn) els.sleepOffBtn.classList.add('hidden');
      }

      if (els.sleepPresets) {
        const activeMins = active ? Math.round((Number(st.totalSec) || 0) / 60) : 0;
        els.sleepPresets.querySelectorAll('button[data-minutes]').forEach((btn) => {
          btn.classList.toggle(
            'resume-pill-primary',
            active && Number(btn.dataset.minutes) === activeMins
          );
        });
      }
    }

    function syncSleepTicker(sleepState) {
      stopSleepCountdown();
      renderSleepTimerState(sleepState);
      if (sleepState?.active && !sleepState.isFading) {
        sleepCountdownInterval = setInterval(() => {
          if (!liveState?.sleepTimer?.active) {
            stopSleepCountdown();
            return;
          }
          renderSleepTimerState(liveState.sleepTimer);
        }, 1000);
      }
    }

    async function setSleepMinutes(minutes) {
      if (!tabInfo.isWatch || !tabInfo.videoId) return;
      const res = await sendToActiveTab({
        type: 'YOUSUB_RESUME_SET_SLEEP_TIMER',
        minutes,
      });
      if (res && res.sleepTimer) {
        liveState = { ...(liveState || {}), sleepTimer: res.sleepTimer };
        syncSleepTicker(res.sleepTimer);
      }
    }

    if (els.sleepPresets) {
      els.sleepPresets.replaceChildren();
      for (const mins of SLEEP_TIMER_PRESETS) {
        const btn = createEl('button', 'resume-pill', `${mins}m`);
        btn.type = 'button';
        btn.dataset.minutes = String(mins);
        btn.addEventListener('click', () => {
          setSleepMinutes(mins);
        });
        els.sleepPresets.appendChild(btn);
      }
    }
    if (els.sleepCustomBtn && els.sleepCustomInput) {
      els.sleepCustomBtn.addEventListener('click', () => {
        const mins = Number(els.sleepCustomInput.value);
        if (Number.isFinite(mins) && mins > 0) {
          setSleepMinutes(mins);
        }
      });
    }
    if (els.sleepOffBtn) {
      els.sleepOffBtn.addEventListener('click', () => {
        setSleepMinutes(0);
      });
    }

    function renderAbLoopState(loopState) {
      if (!els.abBadge) return;
      const st = loopState || {};
      if (st.active && st.pointA !== null && st.pointB !== null) {
        els.abBadge.textContent = `${formatTimestamp(st.pointA)} - ${formatTimestamp(st.pointB)}`;
        els.abBadge.classList.add('is-active');
        if (els.abClearBtn) els.abClearBtn.classList.remove('hidden');
      } else if (st.pointA !== null) {
        els.abBadge.textContent = `A: ${formatTimestamp(st.pointA)}`;
        els.abBadge.classList.add('is-active');
        if (els.abClearBtn) els.abClearBtn.classList.remove('hidden');
      } else {
        els.abBadge.textContent = msg('popupResumeSleepOff', 'Off');
        els.abBadge.classList.remove('is-active');
        if (els.abClearBtn) els.abClearBtn.classList.add('hidden');
      }
    }

    async function sendAbLoopAction(action) {
      if (!tabInfo.isWatch || !tabInfo.videoId) return;
      const res = await sendToActiveTab({ type: 'YOUSUB_RESUME_SET_AB_LOOP', action });
      if (res && res.abLoop) {
        liveState = { ...(liveState || {}), abLoop: res.abLoop };
        renderAbLoopState(res.abLoop);
      }
    }

    if (els.abSetABtn) {
      els.abSetABtn.addEventListener('click', () => sendAbLoopAction('setA'));
    }
    if (els.abSetBBtn) {
      els.abSetBBtn.addEventListener('click', () => sendAbLoopAction('setB'));
    }
    if (els.abClearBtn) {
      els.abClearBtn.addEventListener('click', () => sendAbLoopAction('clear'));
    }

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
        els.quickPills.classList.toggle('hidden', pills.length === 0);
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

            const editBtn = createEl('button', 'resume-bookmark-edit', '✎');
            editBtn.type = 'button';
            editBtn.setAttribute('aria-label', `Edit bookmark ${bm.label || ''}`.trim());
            editBtn.addEventListener('click', () => {
              const inp = document.createElement('input');
              inp.type = 'text';
              inp.className = 'resume-bookmark-edit-input';
              inp.maxLength = 80;
              inp.value = bm.label || '';
              const commitEdit = async () => {
                await PlaybackResumeStore.updateBookmarkLabel(tabInfo.videoId, bm.id, inp.value);
                await refresh();
              };
              inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') commitEdit();
              });
              const saveBtn = createEl('button', 'resume-bookmark-del', '✓');
              saveBtn.type = 'button';
              saveBtn.addEventListener('click', commitEdit);
              chip.replaceChildren(inp, saveBtn);
              inp.focus();
            });

            const delBtn = createEl('button', 'resume-bookmark-del', '×');
            delBtn.type = 'button';
            delBtn.setAttribute('aria-label', `Remove bookmark ${bm.label || ''}`.trim());
            delBtn.addEventListener('click', async () => {
              await PlaybackResumeStore.removeBookmark(tabInfo.videoId, bm.id);
              await refresh();
            });

            chip.appendChild(jumpBtn);
            chip.appendChild(editBtn);
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

      if (els.speedBadge) {
        const rate = Number(liveState?.playbackRate || record?.playbackRate || 1);
        if (rate && Math.abs(rate - 1) >= 0.01) {
          els.speedBadge.textContent = `${rate}x`;
          els.speedBadge.classList.remove('hidden');
          els.speedBadge.classList.add('is-active');
        } else {
          els.speedBadge.classList.add('hidden');
        }
      }

      els.activePanel.classList.remove('hidden');
      renderAbLoopState(liveState?.abLoop || null);
      syncSleepTicker(liveState?.sleepTimer || null);
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
        const customLabel = (els.bookmarkNoteInput?.value || '').trim();
        els.addBookmarkBtn.disabled = true;
        try {
          const tabRes = await sendToActiveTab({
            type: 'YOUSUB_RESUME_ADD_BOOKMARK',
            label: customLabel,
          });
          if (!tabRes || !tabRes.ok) {
            await PlaybackResumeStore.addBookmark(tabInfo.videoId, {
              timeSec: Number(liveState?.currentTimeSec) || 0,
              label: customLabel,
              title: liveState?.title || '',
              durationSec: Number(liveState?.durationSec) || 0,
            });
          }
          if (els.bookmarkNoteInput) els.bookmarkNoteInput.value = '';
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
        stopSleepCountdown();
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
