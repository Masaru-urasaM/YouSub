import './libs/browser-polyfill.js';
import { USAGE_STATS_KEY } from './constants.js';

export const DEFAULT_USAGE_STATS = Object.freeze({
  videosTranslated: 0,
  cacheHits: 0,
  apiRuns: 0,
  apiBatches: 0,
  tokensUsed: 0,
  estimatedTokensSaved: 0,
  estimatedRequestsSaved: 0,
  lastUpdatedAt: 0,
});

const AVG_TOKENS_PER_CUE = 35;
const AVG_LINES_PER_BATCH = 50;

let statsWriteQueue = Promise.resolve();

function sanitizeNonNegInt(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Normalize persisted local usage stats object into safe non-negative integers.
 * @param {object} [raw]
 * @returns {object}
 */
export function normalizeUsageStats(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_USAGE_STATS };
  }
  return {
    videosTranslated: sanitizeNonNegInt(raw.videosTranslated),
    cacheHits: sanitizeNonNegInt(raw.cacheHits),
    apiRuns: sanitizeNonNegInt(raw.apiRuns),
    apiBatches: sanitizeNonNegInt(raw.apiBatches),
    tokensUsed: sanitizeNonNegInt(raw.tokensUsed),
    estimatedTokensSaved: sanitizeNonNegInt(raw.estimatedTokensSaved),
    estimatedRequestsSaved: sanitizeNonNegInt(raw.estimatedRequestsSaved),
    lastUpdatedAt: sanitizeNonNegInt(raw.lastUpdatedAt),
  };
}

/**
 * Estimate how many tokens and API requests a cached translation saved.
 * @param {number} cueCount
 * @returns {{ tokensSaved: number, requestsSaved: number }}
 */
export function estimateSavedUsage(cueCount) {
  const count = sanitizeNonNegInt(cueCount);
  if (count <= 0) {
    return { tokensSaved: 50, requestsSaved: 1 };
  }
  return {
    tokensSaved: Math.max(50, Math.round(count * AVG_TOKENS_PER_CUE)),
    requestsSaved: Math.max(1, Math.ceil(count / AVG_LINES_PER_BATCH)),
  };
}

/**
 * Return updated stats snapshot after a 30-day cache hit.
 * @param {object} current
 * @param {{ cueCount?: number }} [opts]
 * @returns {object}
 */
export function applyCacheHitStats(current, { cueCount = 0 } = {}) {
  const base = normalizeUsageStats(current);
  const { tokensSaved, requestsSaved } = estimateSavedUsage(cueCount);
  return {
    ...base,
    videosTranslated: base.videosTranslated + 1,
    cacheHits: base.cacheHits + 1,
    estimatedTokensSaved: base.estimatedTokensSaved + tokensSaved,
    estimatedRequestsSaved: base.estimatedRequestsSaved + requestsSaved,
    lastUpdatedAt: Date.now(),
  };
}

/**
 * Return updated stats snapshot after a live API / Gemini video run.
 * @param {object} current
 * @param {{ batchCount?: number, totalTokens?: number, incrementVideo?: boolean }} [opts]
 * @returns {object}
 */
export function applyApiRunStats(
  current,
  { batchCount = 1, totalTokens = 0, incrementVideo = true } = {}
) {
  const base = normalizeUsageStats(current);
  return {
    ...base,
    videosTranslated: base.videosTranslated + (incrementVideo ? 1 : 0),
    apiRuns: base.apiRuns + (incrementVideo ? 1 : 0),
    apiBatches: base.apiBatches + Math.max(1, sanitizeNonNegInt(batchCount)),
    tokensUsed: base.tokensUsed + sanitizeNonNegInt(totalTokens),
    lastUpdatedAt: Date.now(),
  };
}

function getStorageArea() {
  if (typeof browser !== 'undefined' && browser.storage?.local) return browser.storage.local;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) return chrome.storage.local;
  return null;
}

/**
 * Read current local usage stats from storage.local.
 * @returns {Promise<object>}
 */
export async function readUsageStats() {
  const storage = getStorageArea();
  if (!storage) return { ...DEFAULT_USAGE_STATS };
  try {
    const res = await storage.get([USAGE_STATS_KEY]);
    return normalizeUsageStats(res?.[USAGE_STATS_KEY]);
  } catch {
    return { ...DEFAULT_USAGE_STATS };
  }
}

function enqueueStatsMutation(mutator) {
  statsWriteQueue = statsWriteQueue
    .catch(() => {})
    .then(async () => {
      const storage = getStorageArea();
      if (!storage) return { ...DEFAULT_USAGE_STATS };
      try {
        const current = await readUsageStats();
        const next = mutator(current);
        await storage.set({ [USAGE_STATS_KEY]: next });
        return next;
      } catch {
        return { ...DEFAULT_USAGE_STATS };
      }
    });
  return statsWriteQueue;
}

export function recordCacheHitUsage(opts = {}) {
  return enqueueStatsMutation((current) => applyCacheHitStats(current, opts));
}

export function recordApiRunUsage(opts = {}) {
  return enqueueStatsMutation((current) => applyApiRunStats(current, opts));
}

export function resetUsageStats() {
  return enqueueStatsMutation(() => ({ ...DEFAULT_USAGE_STATS, lastUpdatedAt: Date.now() }));
}
