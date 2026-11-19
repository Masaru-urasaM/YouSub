import { Overlay } from './overlay.js';
import { devLog, devWarn } from '../shared/constants.js';

let subtitles = [];
let videoElement = null;
let currentIndex = -1;
let onTimeUpdateBound = null;
let isRunning = false;
let isDualMode = false;
let translatedIndices = new Set();

// Binary search implementation to accurately and efficiently find matching subtitle
function findSubtitleAt(subs, timeMs) {
  let low = 0;
  let high = subs.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const entry = subs[mid];

    if (timeMs < entry.startMs) {
      high = mid - 1;
    } else if (timeMs >= entry.endMs) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

function onTimeUpdate() {
  if (!isRunning || !videoElement || !subtitles.length) return;

  // Phase 50.7: Safety check - if video element became invisible or detached,
  // we might be bound to a stale element (especially on Shorts swiping).
  if (videoElement.offsetWidth === 0 && videoElement.offsetHeight === 0) {
    // We don't stop, but we skip rendering to avoid sticking a UI element
    // to a hidden video's timestamp.
    return;
  }

  const timeMs = videoElement.currentTime * 1000;
  let foundIndex = -1;

  // Optimization: Temporal Locality
  // Check if we are still in the current subtitle
  if (currentIndex !== -1 && currentIndex < subtitles.length) {
    const current = subtitles[currentIndex];
    if (timeMs >= current.startMs && timeMs < current.endMs) {
      foundIndex = currentIndex;
    }
    // Check if it's the next subtitle (most common case during playback)
    else if (currentIndex + 1 < subtitles.length) {
      const next = subtitles[currentIndex + 1];
      if (timeMs >= next.startMs && timeMs < next.endMs) {
        foundIndex = currentIndex + 1;
      }
    }
  }

  // Fallback to Binary Search if temporal locality failed
  if (foundIndex === -1) {
    foundIndex = findSubtitleAt(subtitles, timeMs);
  }

  if (foundIndex !== currentIndex) {
    currentIndex = foundIndex;
    if (currentIndex !== -1) {
      const entry = subtitles[currentIndex];
      const isTranslated = translatedIndices.has(currentIndex);
      Overlay.renderSubtitles(
        entry.text || entry.original,
        entry.original,
        isDualMode,
        isTranslated
      );
      Overlay.show();
    } else {
      Overlay.hide();
    }
  }
}

function isEntryTranslated(entry) {
  return Boolean(
    entry &&
    entry.text &&
    (entry.isAiGenerated || (entry.original !== undefined && entry.text !== entry.original))
  );
}

export const SyncEngine = {
  start: function (subs, video, options = {}) {
    this.stop();

    subtitles = Array.isArray(subs) ? subs.slice() : [];
    videoElement = video;
    currentIndex = -1;
    translatedIndices = new Set();
    for (let i = 0; i < subtitles.length; i++) {
      if (isEntryTranslated(subtitles[i])) {
        translatedIndices.add(i);
      }
    }

    if ((!subtitles.length && !options.allowEmpty) || !videoElement) {
      subtitles = [];
      videoElement = null;
      translatedIndices = new Set();
      devWarn('[YouSub] SyncEngine: Missing subtitles or video element.');
      return;
    }

    // Load Dual Mode preference
    chrome.storage.local.get(['yousub_dual_mode']).then((res) => {
      // Phase 66 (B2): guard the start() -> stop() race. If stop() ran while this
      // async storage read was pending, videoElement is now null — bail out so we
      // neither throw on addEventListener(null) nor re-arm a torn-down engine.
      // (Arrow callback also gives onTimeUpdate.bind() the correct lexical `this`.)
      if (!videoElement) {
        devLog('[YouSub] SyncEngine: start() canceled before storage resolved.');
        return;
      }

      isDualMode = !!res.yousub_dual_mode;

      onTimeUpdateBound = onTimeUpdate.bind(this);
      videoElement.addEventListener('timeupdate', onTimeUpdateBound);
      isRunning = true;
      devLog('[YouSub] SyncEngine: Started (Dual Mode: ' + isDualMode + ')');

      // Force initial render in case video is currently paused
      onTimeUpdateBound();
    });
  },

  stop: function () {
    isRunning = false;
    if (videoElement && onTimeUpdateBound) {
      videoElement.removeEventListener('timeupdate', onTimeUpdateBound);
    }
    subtitles = [];
    videoElement = null;
    currentIndex = -1;
    onTimeUpdateBound = null;
    translatedIndices = new Set();

    Overlay.hide();
    devLog('[YouSub] SyncEngine: Stopped.');
  },

  setDualMode: function (enabled) {
    isDualMode = enabled;
    if (isRunning && currentIndex !== -1) {
      const entry = subtitles[currentIndex];
      const isTranslated = translatedIndices.has(currentIndex);
      Overlay.renderSubtitles(
        entry.text || entry.original,
        entry.original,
        isDualMode,
        isTranslated
      );
    }
  },

  pause: function () {
    isRunning = false;
  },

  resume: function () {
    isRunning = true;
    if (onTimeUpdateBound) {
      onTimeUpdateBound();
    }
  },

  /**
   * Update the subtitle data for a full result (Phase 35).
   */
  updateSubtitles: function (newSubs) {
    if (!Array.isArray(newSubs)) return;

    // Safety: If the count changed, reset current index
    if (newSubs.length !== subtitles.length) {
      currentIndex = -1;
    }

    subtitles = newSubs;
    for (let i = 0; i < newSubs.length; i++) {
      if (isEntryTranslated(newSubs[i])) {
        translatedIndices.add(i);
      }
    }
    devLog('[YouSub] SyncEngine: Full subtitles updated. Count: ' + subtitles.length);

    if (isRunning && onTimeUpdateBound) {
      onTimeUpdateBound();
    }
  },

  /**
   * Update a specific batch of subtitles (Phase 35.7).
   * @param {Array} batch New translated strings
   * @param {number} startIndex Starting index in the master array
   */
  updatePartial: function (batch, startIndex) {
    if (!subtitles.length || !Array.isArray(batch)) {
      devWarn('[YouSub] SyncEngine: updatePartial ignored (empty state or batch)');
      return;
    }

    // Phase 54.2: Validate startIndex bounds
    if (typeof startIndex !== 'number' || startIndex < 0 || startIndex >= subtitles.length) {
      devWarn('[YouSub] SyncEngine: updatePartial ignored (invalid startIndex:', startIndex, ')');
      return;
    }

    for (let i = 0; i < batch.length; i++) {
      const globalIndex = startIndex + i;
      if (globalIndex >= subtitles.length) break;
      const newItem = batch[i];

      if (subtitles[globalIndex]) {
        let newText;
        if (typeof newItem === 'string') {
          newText = newItem;
        } else if (newItem && typeof newItem === 'object' && newItem.text) {
          newText = newItem.text;
        }
        if (newText !== undefined) {
          subtitles[globalIndex].text = newText;
          if (newText !== subtitles[globalIndex].original) {
            translatedIndices.add(globalIndex);
          }
        }
      }
    }

    devLog(`[YouSub] SyncEngine: Merged partial batch of ${batch.length} at index ${startIndex}`);

    if (isRunning && onTimeUpdateBound) {
      const endIndex = startIndex + batch.length - 1;
      if (currentIndex >= startIndex && currentIndex <= endIndex) {
        currentIndex = -1;
      }
      onTimeUpdateBound();
    }
  },

  /**
   * Convenience wrapper to start SyncEngine with an empty buffer while
   * streaming/windowed entries arrive incrementally.
   */
  startDynamic: function (video) {
    this.start([], video, { allowEmpty: true });
  },

  /**
   * Merge out-of-order subtitle entries (e.g. seek-jump windows) into the active
   * timeline, keeping entries sorted by startMs with non-overlapping boundaries.
   * @param {Array<{startMs:number, endMs:number, original?:string, text:string, isAiGenerated?:boolean}>} newEntries
   */
  mergeBatchEntries: function (newEntries) {
    if (!Array.isArray(newEntries) || newEntries.length === 0) return;

    const byRange = new Map();
    for (const existing of subtitles) {
      if (existing && typeof existing.startMs === 'number' && typeof existing.endMs === 'number') {
        byRange.set(`${existing.startMs}_${existing.endMs}`, existing);
      }
    }

    for (const item of newEntries) {
      if (!item || typeof item.startMs !== 'number' || typeof item.endMs !== 'number') continue;
      if (item.endMs <= item.startMs) continue;
      const text = item.text || item.original || '';
      const original = item.original !== undefined ? item.original : text;
      if (!text && !original) continue;

      byRange.set(`${item.startMs}_${item.endMs}`, {
        startMs: item.startMs,
        endMs: item.endMs,
        original,
        text,
        ...(item.isAiGenerated ? { isAiGenerated: true } : {}),
      });
    }

    const sorted = Array.from(byRange.values()).sort(
      (a, b) => a.startMs - b.startMs || a.endMs - b.endMs
    );

    const normalized = [];
    for (const entry of sorted) {
      if (normalized.length > 0) {
        const prev = normalized[normalized.length - 1];
        if (prev.endMs > entry.startMs) {
          prev.endMs = entry.startMs;
          if (prev.endMs <= prev.startMs) {
            normalized.pop();
          }
        }
      }
      normalized.push(entry);
    }

    subtitles = normalized;
    currentIndex = -1;
    translatedIndices = new Set();
    for (let i = 0; i < subtitles.length; i++) {
      if (isEntryTranslated(subtitles[i])) {
        translatedIndices.add(i);
      }
    }

    devLog(`[YouSub] SyncEngine: Merged dynamic batch. Total entries: ${subtitles.length}`);

    if (isRunning && onTimeUpdateBound) {
      onTimeUpdateBound();
    }
  },

  isActive: function () {
    return isRunning;
  },

  // Phase 64 (b): number of lines currently holding a translation (vs original).
  // Used by the failure path to decide whether to preserve partial results
  // instead of tearing down the overlay.
  getTranslatedCount: function () {
    return translatedIndices.size;
  },

  isDualModeActive: function () {
    return isDualMode;
  },
};

// Compatibility for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.SyncEngine = SyncEngine;
}
