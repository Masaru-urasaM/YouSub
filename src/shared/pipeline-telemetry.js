import '../shared/libs/browser-polyfill.js';
import { Logger } from './logger.js';

export const PIPELINE_KEY_PREFIX = 'yousub_pipeline_';
export const PIPELINE_LATEST_KEY = 'yousub_pipeline_latest_video';
export const PIPELINE_INDEX_KEY = 'yousub_pipeline_index';
export const MAX_STORED_PIPELINES = 5;

export const PIPELINE_STAGES = Object.freeze([
  'EXTRACT',
  'COALESCE',
  'ROUTE',
  'VERIFY',
  'SYNC_CACHE',
]);

const memorySnapshots = new Map();
const writeQueues = new Map();

function getStorageRoots() {
  const root =
    typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;
  if (!root || !root.storage) return { session: null, local: null };
  return {
    session: root.storage.session || null,
    local: root.storage.local || null,
  };
}

export function formatTimeShort(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function maskApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return '';
  const clean = apiKey.trim();
  if (clean.length <= 4) return clean ? `...${clean}` : '';
  return `...${clean.slice(-4)}`;
}

export function createInitialSnapshot(videoId, patch = {}) {
  const base = {
    videoId: videoId || '',
    runId: '',
    updatedAt: Date.now(),
    mode: 'transcript',
    stage: 'IDLE',
    extraction: {
      source: 'unknown',
      sourceLang: 'auto',
      targetLang: 'vi',
      steps: [],
    },
    coalescer: {
      rawCount: 0,
      coalescedCount: 0,
      mergedCues: 0,
    },
    router: {
      activeProvider: '',
      activeModel: '',
      keyMask: '',
      latencyMs: 0,
      routes: [],
      failovers: [],
    },
    verification: {
      status: 'idle',
      mergeFixes: 0,
      cascadeShifts: 0,
      retranslatedLines: 0,
      foreignScriptFixes: 0,
      untranslatedFixes: 0,
    },
    batches: [],
    playheadMs: 0,
    playheadBatchIndex: 0,
    seekEvents: [],
    sink: {
      syncedCues: 0,
      totalCues: 0,
      cached: false,
      cacheType: 'none',
    },
    metrics: {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 0,
      batchCount: 0,
      completedBatches: 0,
    },
    error: null,
    horizons: {
      past: 'Waiting to start',
      present: 'Idle',
      future: 'Standing by',
    },
  };

  const merged = deepMergeSnapshot(base, patch);
  merged.horizons = computeHorizons(merged);
  return merged;
}

function deepMergeSnapshot(target, patch) {
  if (!patch || typeof patch !== 'object') return target;
  const out = { ...target };

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === 'object' &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMergeSnapshot(out[k], v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (item && typeof item === 'object' ? { ...item } : item));
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function findBatchForTime(batches, playheadMs) {
  if (!Array.isArray(batches) || batches.length === 0) return 0;
  const targetMs = typeof playheadMs === 'number' && Number.isFinite(playheadMs) ? playheadMs : 0;
  let found = 0;
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    if (!b) continue;
    if (typeof b.startMs === 'number' && b.startMs <= targetMs) {
      found = i;
    }
    if (
      typeof b.startMs === 'number' &&
      typeof b.endMs === 'number' &&
      targetMs >= b.startMs &&
      targetMs < b.endMs
    ) {
      return i;
    }
  }
  return found;
}

export function computeHorizons(snapshot) {
  if (!snapshot) {
    return {
      past: 'No history yet',
      present: 'Idle',
      future: 'Standing by',
    };
  }

  const batches = Array.isArray(snapshot.batches) ? snapshot.batches : [];
  const totalBatches = batches.length || snapshot.metrics?.batchCount || 0;
  const doneBatches = batches.filter((b) => b.status === 'DONE').length;
  const inFlightBatch = batches.find((b) => b.status === 'IN_FLIGHT');
  const prefetchBatch = batches.find((b) => b.status === 'PREFETCH');
  const pendingBatches = batches.filter((b) => b.status === 'PENDING' || b.status === 'PREFETCH');
  const failovers = snapshot.router?.failovers || [];

  // Past summary
  const pastParts = [];
  if (snapshot.mode === 'cache') {
    pastParts.push(
      `Cache HIT (${snapshot.sink?.totalCues || snapshot.coalescer?.coalescedCount || 0} cues)`
    );
  } else {
    const srcLabel =
      snapshot.extraction?.source && snapshot.extraction.source !== 'unknown'
        ? snapshot.extraction.source
        : snapshot.mode === 'gemini-video'
          ? 'gemini-url'
          : 'transcript';
    pastParts.push(`Source: ${srcLabel}`);
    if (snapshot.coalescer?.rawCount > 0) {
      pastParts.push(`${snapshot.coalescer.rawCount}→${snapshot.coalescer.coalescedCount} cues`);
    }
    if (totalBatches > 0) {
      pastParts.push(`${doneBatches}/${totalBatches} batches done`);
    }
    if (failovers.length > 0) {
      pastParts.push(`${failovers.length} failover`);
    }
  }
  const past = pastParts.join(' · ') || 'Initialized';

  // Present summary
  let present;
  const modelLabel = snapshot.router?.activeModel || '';
  const providerLabel = snapshot.router?.activeProvider || '';
  const routeName = [providerLabel, modelLabel].filter(Boolean).join(' · ');
  const keyTag = snapshot.router?.keyMask ? ` [${snapshot.router.keyMask}]` : '';

  if (snapshot.stage === 'COMPLETE') {
    const synced = snapshot.sink?.syncedCues || snapshot.coalescer?.coalescedCount || 0;
    const tok = snapshot.metrics?.totalTokens
      ? ` · ${snapshot.metrics.totalTokens.toLocaleString()} tok`
      : '';
    present = `Complete · ${synced} cues synced${routeName ? ` (${routeName})` : ''}${tok}`;
  } else if (snapshot.stage === 'ERROR') {
    present = `Error · ${snapshot.error?.failureReason || snapshot.error?.message || 'Failed'}`;
  } else if (inFlightBatch) {
    const num = (inFlightBatch.batchIndex ?? 0) + 1;
    const seekTag = inFlightBatch.isSeekTarget ? ' ⚡Seek' : '';
    const windowStr =
      typeof inFlightBatch.startMs === 'number' && typeof inFlightBatch.endMs === 'number'
        ? ` (${formatTimeShort(inFlightBatch.startMs)}–${formatTimeShort(inFlightBatch.endMs)})`
        : '';
    present = `${routeName || snapshot.stage}${keyTag} · Batch #${num}/${totalBatches || '?'}${windowStr}${seekTag}`;
  } else if (snapshot.stage === 'EXTRACT' || snapshot.stage === 'COALESCE') {
    present =
      `${snapshot.stage === 'COALESCE' ? 'Coalescing' : 'Extracting'} ${snapshot.extraction?.targetLang || ''}`.trim();
  } else if (routeName) {
    present = `${snapshot.stage} · ${routeName}${keyTag}`;
  } else {
    present = snapshot.stage || 'Idle';
  }

  // Future summary
  let future;
  if (snapshot.stage === 'COMPLETE') {
    future = snapshot.sink?.cached ? 'Saved in LRU Cache · Ready' : 'Playback active';
  } else if (snapshot.stage === 'ERROR') {
    const failedCount = batches.filter((b) => b.status === 'FAILED').length;
    future = failedCount > 0 ? `${failedCount} batch(es) pending retry` : 'Check Settings / Retry';
  } else if (prefetchBatch) {
    const pNum = (prefetchBatch.batchIndex ?? 0) + 1;
    const wStr =
      typeof prefetchBatch.startMs === 'number' && typeof prefetchBatch.endMs === 'number'
        ? ` (${formatTimeShort(prefetchBatch.startMs)}–${formatTimeShort(prefetchBatch.endMs)})`
        : '';
    future = `Lookahead: Batch #${pNum}${wStr}`;
  } else if (pendingBatches.length > 0) {
    const nextB = pendingBatches[0];
    const nNum = (nextB.batchIndex ?? 0) + 1;
    future = `Next: Batch #${nNum} · ${pendingBatches.length} queued`;
  } else if (doneBatches > 0 && totalBatches > 0 && doneBatches >= totalBatches) {
    future = 'Finalizing overlay & LRU cache';
  } else {
    future = 'Queued: Route -> Verify -> Sync';
  }

  return { past, present, future };
}

async function persistSnapshot(videoId, snapshot) {
  if (!videoId) return snapshot;
  const key = `${PIPELINE_KEY_PREFIX}${videoId}`;
  memorySnapshots.set(videoId, snapshot);

  const { session, local } = getStorageRoots();
  const tasks = [];

  if (session) {
    tasks.push(
      Promise.resolve(session.set({ [key]: snapshot, [PIPELINE_LATEST_KEY]: videoId })).catch(
        () => {}
      )
    );
  }

  if (local) {
    tasks.push(
      (async () => {
        try {
          const res = await local.get([PIPELINE_INDEX_KEY]);
          const prevIdx = Array.isArray(res?.[PIPELINE_INDEX_KEY]) ? res[PIPELINE_INDEX_KEY] : [];
          const nextIdx = [key, ...prevIdx.filter((k) => k !== key)];
          const toRemove = nextIdx.slice(MAX_STORED_PIPELINES);
          const keepIdx = nextIdx.slice(0, MAX_STORED_PIPELINES);

          await local.set({
            [key]: snapshot,
            [PIPELINE_LATEST_KEY]: videoId,
            [PIPELINE_INDEX_KEY]: keepIdx,
          });
          if (toRemove.length > 0) {
            await local.remove(toRemove);
          }
        } catch {
          /* ignore */
        }
      })()
    );
  }

  await Promise.all(tasks);
  return snapshot;
}

async function readSnapshotFromStorage(videoId) {
  if (!videoId) return null;
  const key = `${PIPELINE_KEY_PREFIX}${videoId}`;
  const { session, local } = getStorageRoots();

  // Content scripts cannot access storage.session in Chrome MV3 (TRUSTED_CONTEXTS only),
  // so they write storage.local exclusively. Read BOTH areas in parallel and pick the freshest
  // snapshot so neither side merges onto stale state.
  const readArea = async (area) => {
    if (!area) return null;
    try {
      const res = await area.get([key]);
      return res && res[key] ? res[key] : null;
    } catch {
      return null;
    }
  };

  const [sessionSnap, localSnap] = await Promise.all([readArea(session), readArea(local)]);

  const freshest = pickFreshestSnapshot(sessionSnap, localSnap);
  if (freshest) {
    memorySnapshots.set(videoId, freshest);
    return freshest;
  }

  return memorySnapshots.get(videoId) || null;
}

export function pickFreshestSnapshot(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ta = typeof a.updatedAt === 'number' ? a.updatedAt : 0;
  const tb = typeof b.updatedAt === 'number' ? b.updatedAt : 0;
  if (tb !== ta) return tb > ta ? b : a;
  // Same-millisecond tie-break: if same run, prefer further stage (or ERROR)
  if (a.runId && a.runId === b.runId) {
    if (b.stage === 'ERROR' && a.stage !== 'ERROR') return b;
    if (getStageRank(b.stage) > getStageRank(a.stage)) return b;
  }
  return a;
}

const STAGE_ORDER = Object.freeze({
  IDLE: -1,
  EXTRACT: 0,
  COALESCE: 1,
  ROUTE: 2,
  VERIFY: 3,
  SYNC_CACHE: 4,
  COMPLETE: 5,
});

export function getStageRank(stage) {
  return STAGE_ORDER[stage] ?? -1;
}

/**
 * A reset() for the SAME runId must never move the stage backwards (e.g. a delayed
 * content-script COALESCE write landing after the service worker already wrote COMPLETE).
 * New runs (different/missing runId) and ERROR transitions are always allowed.
 */
export function isStaleStageRegression(existing, next) {
  if (!existing || !next) return false;
  if (!existing.runId || !next.runId || existing.runId !== next.runId) return false;
  if (next.stage === 'ERROR' || existing.stage === 'ERROR') return false;
  return getStageRank(next.stage) < getStageRank(existing.stage);
}

export const PipelineTelemetry = {
  async reset(videoId, initialPatch = {}) {
    if (!videoId) return null;
    const prev = writeQueues.get(videoId) || Promise.resolve();
    const next = prev.then(async () => {
      const snap = createInitialSnapshot(videoId, initialPatch);
      if (initialPatch.runId) {
        const existing = await readSnapshotFromStorage(videoId);
        if (isStaleStageRegression(existing, snap)) {
          Logger.warn('Telemetry', '[STAGE_GUARD] Ignored stale stage regression on reset', {
            videoId,
            runId: snap.runId,
            existingStage: existing.stage,
            attemptedStage: snap.stage,
          });
          return existing;
        }
      }
      return persistSnapshot(videoId, snap);
    });
    writeQueues.set(
      videoId,
      next.catch(() => {})
    );
    return next;
  },

  async update(videoId, updaterOrPatch) {
    if (!videoId) return null;
    const prev = writeQueues.get(videoId) || Promise.resolve();
    const next = prev.then(async () => {
      const existing = (await readSnapshotFromStorage(videoId)) || createInitialSnapshot(videoId);
      const updated =
        typeof updaterOrPatch === 'function'
          ? updaterOrPatch(deepMergeSnapshot({}, existing))
          : deepMergeSnapshot(existing, updaterOrPatch);

      if (!updated) return existing;
      updated.videoId = videoId;
      updated.updatedAt = Date.now();
      updated.horizons = computeHorizons(updated);
      return persistSnapshot(videoId, updated);
    });
    writeQueues.set(
      videoId,
      next.catch(() => {})
    );
    return next;
  },

  async getSnapshot(videoId) {
    if (!videoId) return null;
    return readSnapshotFromStorage(videoId);
  },

  async getLatestSnapshot() {
    const { session, local } = getStorageRoots();
    let latestId = null;

    if (session) {
      try {
        const res = await session.get([PIPELINE_LATEST_KEY]);
        if (res && res[PIPELINE_LATEST_KEY]) latestId = res[PIPELINE_LATEST_KEY];
      } catch {}
    }
    if (!latestId && local) {
      try {
        const res = await local.get([PIPELINE_LATEST_KEY]);
        if (res && res[PIPELINE_LATEST_KEY]) latestId = res[PIPELINE_LATEST_KEY];
      } catch {}
    }

    if (latestId) {
      const snap = await readSnapshotFromStorage(latestId);
      if (snap) return snap;
    }

    for (const [, snap] of memorySnapshots) {
      if (snap) return snap;
    }
    return null;
  },

  async recordSeek(videoId, playheadMs) {
    if (!videoId) return null;
    const safeMs =
      typeof playheadMs === 'number' && Number.isFinite(playheadMs) ? Math.max(0, playheadMs) : 0;

    Logger.info('Telemetry', `[SEEK_PRIORITY] Seek event recorded`, {
      videoId,
      playheadMs: safeMs,
    });

    return this.update(videoId, (snap) => {
      const batches = Array.isArray(snap.batches) ? snap.batches : [];
      const targetIdx = findBatchForTime(batches, safeMs);
      const updatedBatches = batches.map((b, idx) => ({
        ...b,
        isSeekTarget: idx === targetIdx && b.status !== 'DONE',
      }));
      const seekEvents = Array.isArray(snap.seekEvents) ? snap.seekEvents.slice(-9) : [];
      seekEvents.push({ ts: Date.now(), playheadMs: safeMs, targetBatchIndex: targetIdx });

      return {
        ...snap,
        playheadMs: safeMs,
        playheadBatchIndex: targetIdx,
        batches: updatedBatches,
        seekEvents,
      };
    });
  },

  async clear(videoId) {
    if (videoId) {
      memorySnapshots.delete(videoId);
      const key = `${PIPELINE_KEY_PREFIX}${videoId}`;
      const { session, local } = getStorageRoots();
      if (session) await session.remove([key]).catch(() => {});
      if (local) await local.remove([key]).catch(() => {});
      return;
    }
    memorySnapshots.clear();
  },

  _resetMemoryForTests() {
    memorySnapshots.clear();
    writeQueues.clear();
  },
};

if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.PipelineTelemetry = PipelineTelemetry;
}
