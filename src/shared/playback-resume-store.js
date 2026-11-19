import '../shared/libs/browser-polyfill.js';
import {
  devWarn,
  RESUME_STORAGE_KEY,
  RESUME_SYNC_KEY,
  RESUME_SETTINGS_KEY,
  DEFAULT_RESUME_SETTINGS,
} from './constants.js';
import { Logger } from './logger.js';

export const MAX_LOCAL_VIDEOS = 500;
export const MAX_SYNC_VIDEOS = 40;
export const MAX_SYNC_BYTES = 7500;
export const MAX_CHECKPOINTS = 6;
export const CHECKPOINT_INTERVAL_SEC = 1800;
export const MAX_BOOKMARKS_PER_VIDEO = 20;
export const SYNC_FLUSH_MIN_INTERVAL_MS = 60000;

let writeQueue = Promise.resolve();
let lastSyncFlushAt = 0;

function enqueueWrite(task) {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => {});
  return next;
}

function getStorageRoots() {
  const root =
    typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;
  if (!root || !root.storage) return { local: null, sync: null };
  return {
    local: root.storage.local || null,
    sync: root.storage.sync || null,
  };
}

function toFiniteNonNegative(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function measureUtf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  return encodeURIComponent(String(str || '')).replace(/%[A-F\d]{2}/gi, 'U').length;
}

/**
 * Format seconds as M:SS or H:MM:SS for display.
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatTimestamp(totalSeconds) {
  const sec = Number(totalSeconds);
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const whole = Math.floor(sec);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Normalize either a full local record or compact sync record ({t, f, i, ia, d, u, n})
 * into the canonical local record schema.
 * @param {Object|null} raw
 * @param {string} [videoId]
 * @returns {Object|null}
 */
export function normalizeVideoRecord(raw, videoId) {
  if (!raw || typeof raw !== 'object') return null;
  const resolvedId = String(raw.videoId || videoId || '').trim();
  if (!resolvedId) return null;

  const isCompact = raw.t !== undefined || raw.u !== undefined || raw.n !== undefined;
  const lastTimeSec = toFiniteNonNegative(isCompact ? raw.t : raw.lastTimeSec, 0);
  const furthestTimeSec = Math.max(
    lastTimeSec,
    toFiniteNonNegative(isCompact ? raw.f : raw.furthestTimeSec, 0)
  );
  const lastInteractionTimeSec = toFiniteNonNegative(
    isCompact ? raw.i : raw.lastInteractionTimeSec,
    0
  );
  const lastInteractionAt = toFiniteNonNegative(isCompact ? raw.ia : raw.lastInteractionAt, 0);
  const durationSec = toFiniteNonNegative(isCompact ? raw.d : raw.durationSec, 0);
  const updatedAt = toFiniteNonNegative(isCompact ? raw.u : raw.updatedAt, 0);
  const createdAt = toFiniteNonNegative(raw.createdAt, updatedAt);
  const rawTitle = isCompact ? raw.n : raw.title;
  const title = typeof rawTitle === 'string' ? rawTitle.slice(0, 120) : '';

  const checkpoints = Array.isArray(raw.checkpoints)
    ? raw.checkpoints
        .filter((c) => c && Number.isFinite(Number(c.timeSec)) && Number(c.timeSec) >= 0)
        .map((c) => ({
          timeSec: Math.round(Number(c.timeSec)),
          savedAt: toFiniteNonNegative(c.savedAt, updatedAt),
        }))
        .slice(-MAX_CHECKPOINTS)
    : [];

  const bookmarks = Array.isArray(raw.bookmarks)
    ? raw.bookmarks
        .filter((b) => b && Number.isFinite(Number(b.timeSec)) && Number(b.timeSec) >= 0)
        .map((b, idx) => ({
          id: String(b.id || `bm_${Math.round(Number(b.timeSec))}_${idx}`),
          timeSec: Math.round(Number(b.timeSec)),
          label: typeof b.label === 'string' ? b.label.slice(0, 80) : '',
          createdAt: toFiniteNonNegative(b.createdAt, updatedAt),
        }))
        .slice(-MAX_BOOKMARKS_PER_VIDEO)
    : [];

  return {
    videoId: resolvedId,
    title,
    durationSec,
    lastTimeSec,
    furthestTimeSec,
    lastInteractionTimeSec,
    lastInteractionAt,
    checkpoints,
    bookmarks,
    updatedAt,
    createdAt,
  };
}

function mergeArrayByKey(listA, listB, getKey, sortFn, cap) {
  const map = new Map();
  for (const item of [...(listA || []), ...(listB || [])]) {
    if (!item) continue;
    const key = getKey(item);
    const prev = map.get(key);
    if (!prev || (item.savedAt || item.createdAt || 0) >= (prev.savedAt || prev.createdAt || 0)) {
      map.set(key, item);
    }
  }
  const merged = Array.from(map.values()).sort(sortFn);
  return merged.length > cap ? merged.slice(-cap) : merged;
}

/**
 * Merge local and sync records for the same videoId cleanly.
 * @param {Object|null} localRec
 * @param {Object|null} syncRec
 * @param {string} [videoId]
 * @returns {Object|null}
 */
export function mergeRecords(localRec, syncRec, videoId = '') {
  const fallbackId = videoId || localRec?.videoId || syncRec?.videoId || '';
  const a = normalizeVideoRecord(localRec, fallbackId);
  const b = normalizeVideoRecord(syncRec, fallbackId);
  if (!a) return b;
  if (!b) return a;

  const preferB = b.updatedAt > a.updatedAt;
  const primary = preferB ? b : a;
  const secondary = preferB ? a : b;

  let interactionSource = a;
  if (
    b.lastInteractionAt > a.lastInteractionAt ||
    (b.lastInteractionAt === a.lastInteractionAt &&
      b.lastInteractionTimeSec > a.lastInteractionTimeSec)
  ) {
    interactionSource = b;
  }

  return {
    videoId: primary.videoId,
    title: primary.title || secondary.title || '',
    durationSec: Math.max(a.durationSec, b.durationSec),
    lastTimeSec: primary.lastTimeSec,
    furthestTimeSec: Math.max(a.furthestTimeSec, b.furthestTimeSec),
    lastInteractionTimeSec: interactionSource.lastInteractionTimeSec,
    lastInteractionAt: interactionSource.lastInteractionAt,
    checkpoints: mergeArrayByKey(
      a.checkpoints,
      b.checkpoints,
      (c) => String(Math.round(c.timeSec)),
      (x, y) => x.savedAt - y.savedAt || x.timeSec - y.timeSec,
      MAX_CHECKPOINTS
    ),
    bookmarks: mergeArrayByKey(
      a.bookmarks,
      b.bookmarks,
      (bm) => bm.id || `${Math.round(bm.timeSec)}_${bm.label}`,
      (x, y) => x.timeSec - y.timeSec || x.createdAt - y.createdAt,
      MAX_BOOKMARKS_PER_VIDEO
    ),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    createdAt:
      a.createdAt && b.createdAt ? Math.min(a.createdAt, b.createdAt) : a.createdAt || b.createdAt,
  };
}

/**
 * Deterministically resolve which timestamp to auto-seek to on video open,
 * defending against YouTube's 0:00 overwrite bug, accidental seeks, and sleep playback.
 */
export function resolveResumeTarget({
  localRecord = null,
  syncRecord = null,
  accountStartSec = 0,
  durationSec = 0,
  rewindSec = DEFAULT_RESUME_SETTINGS.rewindSec,
  minDurationSec = DEFAULT_RESUME_SETTINGS.minDurationSec,
} = {}) {
  const normLocal = normalizeVideoRecord(localRecord);
  const normSync = normalizeVideoRecord(syncRecord);
  const merged = mergeRecords(normLocal, normSync);

  const effectiveDuration = Math.max(
    toFiniteNonNegative(durationSec, 0),
    merged ? merged.durationSec : 0
  );
  const safeRewind = toFiniteNonNegative(rewindSec, DEFAULT_RESUME_SETTINGS.rewindSec);
  const safeMinDur = toFiniteNonNegative(minDurationSec, DEFAULT_RESUME_SETTINGS.minDurationSec);

  const emptyResult = (mergedRec) => ({
    shouldResume: false,
    targetSec: 0,
    rawTargetSec: 0,
    source: 'none',
    mergedRecord: mergedRec,
    alternatives: {
      furthestSec: null,
      lastInteractionSec: null,
      accountSec: null,
    },
  });

  if (effectiveDuration > 0 && effectiveDuration < safeMinDur) {
    return emptyResult(merged);
  }

  const acct =
    Number.isFinite(Number(accountStartSec)) && Number(accountStartSec) > 0
      ? Number(accountStartSec)
      : 0;
  const localSec = merged ? merged.lastTimeSec : 0;

  let rawTargetSec = 0;
  let source = 'none';

  if (localSec >= 5 && acct > localSec + 15) {
    rawTargetSec = acct;
    source = 'youtube-account';
  } else if (localSec >= 5) {
    rawTargetSec = localSec;
    if (normLocal && (!normSync || normLocal.updatedAt >= normSync.updatedAt)) {
      source = 'local';
    } else {
      source = 'sync';
    }
  } else if (acct >= 5) {
    rawTargetSec = acct;
    source = 'youtube-account';
  } else {
    return emptyResult(merged);
  }

  if (effectiveDuration > 10 && rawTargetSec >= effectiveDuration - 5) {
    rawTargetSec = Math.max(0, effectiveDuration - safeRewind);
  }

  const targetSec = Math.max(0, Math.floor(rawTargetSec - safeRewind));
  const shouldResume = rawTargetSec >= 5 && targetSec >= 0;

  const furthestSec =
    merged && merged.furthestTimeSec - rawTargetSec >= 30
      ? Math.floor(merged.furthestTimeSec)
      : null;

  const lastInteractionSec =
    merged &&
    merged.lastInteractionTimeSec >= 5 &&
    rawTargetSec - merged.lastInteractionTimeSec >= 1800
      ? Math.floor(merged.lastInteractionTimeSec)
      : null;

  const accountSec = acct >= 5 && Math.abs(acct - rawTargetSec) >= 15 ? Math.floor(acct) : null;

  return {
    shouldResume,
    targetSec,
    rawTargetSec: Math.floor(rawTargetSec),
    source,
    mergedRecord: merged,
    alternatives: {
      furthestSec,
      lastInteractionSec,
      accountSec,
    },
  };
}

/**
 * Keep only the most recently updated records up to maxEntries.
 * @param {Object} mapObj
 * @param {number} [maxEntries]
 * @returns {Object}
 */
export function pruneRecordsMap(mapObj, maxEntries = MAX_LOCAL_VIDEOS) {
  if (!mapObj || typeof mapObj !== 'object') return {};
  const entries = Object.entries(mapObj)
    .map(([id, rec]) => [id, normalizeVideoRecord(rec, id)])
    .filter(([, rec]) => Boolean(rec));

  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const kept = entries.slice(0, Math.max(0, maxEntries));
  const out = {};
  for (const [id, rec] of kept) {
    out[id] = rec;
  }
  return out;
}

/**
 * Build a quota-safe compact sync payload (<= MAX_SYNC_VIDEOS and <= MAX_SYNC_BYTES).
 * @param {Object} localMap
 * @param {number} [maxEntries]
 * @returns {Object}
 */
export function buildCompactSyncMap(localMap, maxEntries = MAX_SYNC_VIDEOS) {
  const pruned = pruneRecordsMap(localMap, maxEntries);
  const sortedIds = Object.keys(pruned).sort(
    (a, b) => (pruned[b].updatedAt || 0) - (pruned[a].updatedAt || 0)
  );

  const compact = {};
  for (const id of sortedIds) {
    const rec = pruned[id];
    compact[id] = {
      t: Math.round(rec.lastTimeSec),
      f: Math.round(rec.furthestTimeSec),
      i: Math.round(rec.lastInteractionTimeSec),
      ia: Math.round(rec.lastInteractionAt),
      d: Math.round(rec.durationSec),
      u: Math.round(rec.updatedAt),
      n: (rec.title || '').slice(0, 50),
    };
  }

  // Enforce strict per-item quota margin for storage.sync (~8 KB cap)
  while (sortedIds.length > 0 && measureUtf8Bytes(JSON.stringify(compact)) > MAX_SYNC_BYTES) {
    const oldestId = sortedIds.pop();
    delete compact[oldestId];
  }

  return compact;
}

async function readMaps() {
  const { local, sync } = getStorageRoots();
  let localMap = {};
  let syncMap = {};

  if (local) {
    try {
      const res = await local.get([RESUME_STORAGE_KEY]);
      if (res && res[RESUME_STORAGE_KEY] && typeof res[RESUME_STORAGE_KEY] === 'object') {
        localMap = res[RESUME_STORAGE_KEY];
      }
    } catch (e) {
      Logger.warn('ResumeStore', 'Failed reading local resume map', { error: e?.message });
      devWarn('[YouSub] ResumeStore: Failed reading local map:', e);
    }
  }

  if (sync) {
    try {
      const res = await sync.get([RESUME_SYNC_KEY]);
      if (res && res[RESUME_SYNC_KEY] && typeof res[RESUME_SYNC_KEY] === 'object') {
        syncMap = res[RESUME_SYNC_KEY];
      }
    } catch (e) {
      Logger.warn('ResumeStore', 'Failed reading sync resume map', { error: e?.message });
    }
  }

  return { localMap, syncMap };
}

async function persistMaps(
  localMap,
  syncMap = {},
  { forceSyncFlush = false, syncEnabled = true, excludeVideoId = null } = {}
) {
  const { local, sync } = getStorageRoots();
  const prunedLocal = pruneRecordsMap(localMap, MAX_LOCAL_VIDEOS);

  if (local) {
    await local.set({ [RESUME_STORAGE_KEY]: prunedLocal });
  }

  const now = Date.now();
  if (
    sync &&
    syncEnabled &&
    (forceSyncFlush || now - lastSyncFlushAt >= SYNC_FLUSH_MIN_INTERVAL_MS)
  ) {
    try {
      // Preserve records synced from other devices before pruning top-N for storage.sync
      const combinedForSync = {};
      const allIds = new Set([...Object.keys(syncMap || {}), ...Object.keys(prunedLocal)]);
      for (const id of allIds) {
        if (excludeVideoId && id === excludeVideoId) continue;
        const merged = mergeRecords(
          normalizeVideoRecord(prunedLocal[id], id),
          normalizeVideoRecord(syncMap?.[id], id)
        );
        if (merged) combinedForSync[id] = merged;
      }
      const compactSync = buildCompactSyncMap(combinedForSync, MAX_SYNC_VIDEOS);
      await sync.set({ [RESUME_SYNC_KEY]: compactSync });
      lastSyncFlushAt = now;
    } catch (e) {
      Logger.warn('ResumeStore', 'storage.sync flush failed (continuing with local)', {
        error: e?.message,
      });
    }
  }

  return prunedLocal;
}

export const PlaybackResumeStore = {
  async getSettings() {
    const { local } = getStorageRoots();
    if (!local) return { ...DEFAULT_RESUME_SETTINGS };
    try {
      const res = await local.get([RESUME_SETTINGS_KEY]);
      const saved = res && res[RESUME_SETTINGS_KEY];
      return {
        ...DEFAULT_RESUME_SETTINGS,
        ...(saved && typeof saved === 'object' ? saved : {}),
      };
    } catch (e) {
      Logger.warn('ResumeStore', 'Failed loading resume settings', { error: e?.message });
      return { ...DEFAULT_RESUME_SETTINGS };
    }
  },

  async saveSettings(partial) {
    const current = await this.getSettings();
    const next = {
      ...current,
      ...(partial && typeof partial === 'object' ? partial : {}),
    };
    next.enabled = next.enabled !== false;
    next.syncEnabled = next.syncEnabled !== false;
    next.preventCompletionReset = next.preventCompletionReset !== false;
    next.rewindSec = toFiniteNonNegative(next.rewindSec, DEFAULT_RESUME_SETTINGS.rewindSec);
    next.minDurationSec = toFiniteNonNegative(
      next.minDurationSec,
      DEFAULT_RESUME_SETTINGS.minDurationSec
    );

    const { local } = getStorageRoots();
    if (local) {
      await local.set({ [RESUME_SETTINGS_KEY]: next });
    }
    return next;
  },

  async getVideoRecord(videoId) {
    if (!videoId) return { localRecord: null, syncRecord: null, mergedRecord: null };
    const { localMap, syncMap } = await readMaps();
    const localRecord = normalizeVideoRecord(localMap[videoId], videoId);
    const syncRecord = normalizeVideoRecord(syncMap[videoId], videoId);
    const mergedRecord = mergeRecords(localRecord, syncRecord);
    return { localRecord, syncRecord, mergedRecord };
  },

  async updateProgress(
    videoId,
    {
      currentTimeSec = 0,
      durationSec = 0,
      title = '',
      isUserInteraction = false,
      allowResetToZero = false,
      forceSyncFlush = false,
      syncEnabled = true,
    } = {}
  ) {
    if (!videoId) return null;

    return enqueueWrite(async () => {
      const { localMap, syncMap } = await readMaps();
      const prev = mergeRecords(
        normalizeVideoRecord(localMap[videoId], videoId),
        normalizeVideoRecord(syncMap[videoId], videoId)
      );

      const safeCurrent = toFiniteNonNegative(currentTimeSec, 0);
      const safeDuration = toFiniteNonNegative(durationSec, prev?.durationSec || 0);

      // Anti-zero-overwrite guard: block accidental 0:00..4s overwrites when substantial progress exists
      if (!allowResetToZero && prev && prev.lastTimeSec >= 15 && safeCurrent < 5) {
        Logger.debug('ResumeStore', '[ANTI_ZERO_LOCK] Preserved saved position against <5s write', {
          videoId,
          preservedSec: prev.lastTimeSec,
          ignoredSec: safeCurrent,
        });
        return prev;
      }

      const now = Date.now();
      const base = prev || {
        videoId,
        title: '',
        durationSec: 0,
        lastTimeSec: 0,
        furthestTimeSec: 0,
        lastInteractionTimeSec: 0,
        lastInteractionAt: 0,
        checkpoints: [],
        bookmarks: [],
        updatedAt: now,
        createdAt: now,
      };

      const nextTitle =
        typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : base.title;
      const nextDuration = Math.max(base.durationSec || 0, safeDuration);
      const nextFurthest = Math.max(base.furthestTimeSec || 0, safeCurrent);

      let nextInteractionTimeSec = base.lastInteractionTimeSec || 0;
      let nextInteractionAt = base.lastInteractionAt || 0;
      if (isUserInteraction && (safeCurrent >= 5 || allowResetToZero)) {
        nextInteractionTimeSec = safeCurrent;
        nextInteractionAt = now;
      }

      const checkpoints = Array.isArray(base.checkpoints) ? base.checkpoints.slice() : [];
      const lastCp = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
      if (
        safeCurrent >= 60 &&
        (!lastCp || Math.abs(safeCurrent - lastCp.timeSec) >= CHECKPOINT_INTERVAL_SEC)
      ) {
        checkpoints.push({ timeSec: Math.round(safeCurrent), savedAt: now });
        while (checkpoints.length > MAX_CHECKPOINTS) {
          checkpoints.shift();
        }
      }

      const updated = {
        ...base,
        videoId,
        title: nextTitle,
        durationSec: nextDuration,
        lastTimeSec: safeCurrent,
        furthestTimeSec: nextFurthest,
        lastInteractionTimeSec: nextInteractionTimeSec,
        lastInteractionAt: nextInteractionAt,
        checkpoints,
        bookmarks: Array.isArray(base.bookmarks) ? base.bookmarks.slice() : [],
        updatedAt: now,
        createdAt: base.createdAt || now,
      };

      localMap[videoId] = updated;
      await persistMaps(localMap, syncMap, { forceSyncFlush, syncEnabled });
      return updated;
    });
  },

  async addBookmark(videoId, { timeSec = 0, label = '', title = '', durationSec = 0 } = {}) {
    if (!videoId) return null;

    return enqueueWrite(async () => {
      const { localMap, syncMap } = await readMaps();
      const prev = mergeRecords(
        normalizeVideoRecord(localMap[videoId], videoId),
        normalizeVideoRecord(syncMap[videoId], videoId)
      );

      const now = Date.now();
      const safeTime = Math.round(toFiniteNonNegative(timeSec, 0));
      const cleanLabel =
        typeof label === 'string' && label.trim()
          ? label.trim().slice(0, 80)
          : `Bookmark ${formatTimestamp(safeTime)}`;

      const base = prev || {
        videoId,
        title: typeof title === 'string' ? title.trim().slice(0, 120) : '',
        durationSec: toFiniteNonNegative(durationSec, 0),
        lastTimeSec: safeTime,
        furthestTimeSec: safeTime,
        lastInteractionTimeSec: safeTime,
        lastInteractionAt: now,
        checkpoints: [],
        bookmarks: [],
        updatedAt: now,
        createdAt: now,
      };

      const bookmarks = Array.isArray(base.bookmarks) ? base.bookmarks.slice() : [];
      bookmarks.push({
        id: `bm_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        timeSec: safeTime,
        label: cleanLabel,
        createdAt: now,
      });
      bookmarks.sort((a, b) => a.timeSec - b.timeSec || a.createdAt - b.createdAt);
      while (bookmarks.length > MAX_BOOKMARKS_PER_VIDEO) {
        bookmarks.shift();
      }

      const updated = {
        ...base,
        title:
          (typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : base.title) ||
          '',
        durationSec: Math.max(base.durationSec || 0, toFiniteNonNegative(durationSec, 0)),
        bookmarks,
        updatedAt: now,
      };

      localMap[videoId] = updated;
      await persistMaps(localMap, syncMap, { forceSyncFlush: true, syncEnabled: true });
      Logger.info('ResumeStore', 'Bookmark added', {
        videoId,
        timeSec: safeTime,
        label: cleanLabel,
      });
      return updated;
    });
  },

  async removeBookmark(videoId, bookmarkId) {
    if (!videoId || !bookmarkId) return null;

    return enqueueWrite(async () => {
      const { localMap, syncMap } = await readMaps();
      const prev = mergeRecords(
        normalizeVideoRecord(localMap[videoId], videoId),
        normalizeVideoRecord(syncMap[videoId], videoId)
      );
      if (!prev) return null;

      const updated = {
        ...prev,
        bookmarks: prev.bookmarks.filter((b) => b.id !== bookmarkId),
        updatedAt: Date.now(),
      };
      localMap[videoId] = updated;
      await persistMaps(localMap, syncMap, { forceSyncFlush: true, syncEnabled: true });
      return updated;
    });
  },

  async listRecentVideos(limit = 20) {
    const { localMap, syncMap } = await readMaps();
    const allIds = new Set([...Object.keys(localMap), ...Object.keys(syncMap)]);
    const records = [];

    for (const id of allIds) {
      const merged = mergeRecords(
        normalizeVideoRecord(localMap[id], id),
        normalizeVideoRecord(syncMap[id], id)
      );
      if (merged) records.push(merged);
    }

    records.sort((a, b) => b.updatedAt - a.updatedAt);
    return records.slice(0, Math.max(0, limit));
  },

  async clearVideoRecord(videoId) {
    if (!videoId) return;
    return enqueueWrite(async () => {
      const { localMap, syncMap } = await readMaps();
      delete localMap[videoId];
      delete syncMap[videoId];
      await persistMaps(localMap, syncMap, {
        forceSyncFlush: true,
        syncEnabled: true,
        excludeVideoId: videoId,
      });
    });
  },

  async clearAllRecords() {
    return enqueueWrite(async () => {
      const { local, sync } = getStorageRoots();
      if (local) await local.remove([RESUME_STORAGE_KEY]).catch(() => {});
      if (sync) await sync.remove([RESUME_SYNC_KEY]).catch(() => {});
      lastSyncFlushAt = 0;
    });
  },

  resolveResumeTarget,
  formatTimestamp,

  _resetInternalForTests() {
    writeQueue = Promise.resolve();
    lastSyncFlushAt = 0;
  },
};

if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.PlaybackResumeStore = PlaybackResumeStore;
}
