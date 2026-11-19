/**
 * cache.js — Translation Cache Module (ES Module)
 *
 * Manages local storage of translated subtitles to minimize API calls and latency.
 * Strategy: LRU (Least Recently Used) with a 100-video limit and 30-day TTL.
 */

import '../shared/libs/browser-polyfill.js';
import { Logger } from '../shared/logger.js';

const CACHE_PREFIX = 'yousub_vcache_';
const META_KEY = 'yousub_vcache_metadata';
const MAX_ENTRIES = 100;
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const CACHE_SCHEMA_VERSION = 2;

export const Cache = {
  /**
   * Retrieve translated entries from cache.
   * @param {string} videoId
   * @param {string} sl Source Language
   * @param {string} tl Target Language
   * @returns {Promise<Array|null>}
   */
  async get(videoId, sl, tl) {
    if (!videoId) return null;
    const key = `${CACHE_PREFIX}${videoId}_${sl}_${tl}`;

    try {
      const res = await browser.storage.local.get([key, META_KEY]);
      const data = res[key];
      const meta = res[META_KEY] || { keys: [] };

      if (!data) return null;

      // Check TTL
      const now = Date.now();
      if (now - data.timestamp > TTL_MS) {
        Logger.info('Cache', `Cache EXPIRED for ${videoId} (${sl}->${tl})`);
        await this.remove(videoId, sl, tl);
        return null;
      }

      // Invalidate legacy pre-v2 cache entries written before alignment fixes
      if ((data.version || 1) < CACHE_SCHEMA_VERSION) {
        Logger.info(
          'Cache',
          `Cache STALE schema (v${data.version || 1} < v${CACHE_SCHEMA_VERSION}) for ${videoId} (${sl}->${tl})`
        );
        await this.remove(videoId, sl, tl);
        return null;
      }

      // Cache HIT — Update lastUsed in metadata
      Logger.info('Cache', `Cache HIT for ${videoId} (${sl}->${tl})`);
      await this._updateMetadata(videoId, sl, tl, meta, key);

      return data.translated;
    } catch (e) {
      Logger.error('Cache', `Error reading cache: ${e.message}`);
      return null;
    }
  },

  /**
   * Source-language-agnostic existence check: is there any cached translation for
   * (videoId, tl), regardless of source language?
   *
   * The auto-start cache probe (YOUSUB_CHECK_CACHE) fires on page enter — BEFORE
   * extraction — so the concrete source language is not yet known. Since source
   * languages began participating in the per-entry cache key (Decision 16 / Phase
   * B-c), a probe pinned to 'auto' would miss entries stored under a concrete code
   * (e.g. 'en' for a single-track video) and silently stop auto-starting.
   *
   * Reads ONLY the metadata index (a single storage key). This runs on every page
   * enter, so it must NOT deserialize the whole cache (get(null) would pull every
   * cached subtitle payload). TTL is intentionally not checked here: a match only
   * triggers auto-start, and the subsequent stream/request serve re-checks TTL via
   * Cache.get (expired => miss => re-translate). So a stale metadata entry costs at
   * most one correct re-translation, never a wrong serve.
   *
   * @param {string} videoId
   * @param {string} tl Target Language
   * @returns {Promise<boolean>}
   */
  async hasAnyForVideoTarget(videoId, tl) {
    if (!videoId) return false;
    try {
      const res = await browser.storage.local.get(META_KEY);
      const keys = (res[META_KEY] && res[META_KEY].keys) || [];
      // Structured match (not string-prefix) on the metadata index, so videoIds that
      // are prefixes of one another cannot collide.
      return keys.some((k) => k.videoId === videoId && k.tl === tl);
    } catch (e) {
      Logger.error('Cache', `Error scanning cache existence: ${e.message}`);
      return false;
    }
  },

  /**
   * Save translated entries to cache.
   * @param {string} videoId
   * @param {string} sl
   * @param {string} tl
   * @param {Array} translated
   */
  async set(videoId, sl, tl, translated) {
    if (!videoId || !translated || translated.length === 0) return;

    const key = `${CACHE_PREFIX}${videoId}_${sl}_${tl}`;
    const now = Date.now();
    const entry = {
      videoId,
      sl,
      tl,
      version: CACHE_SCHEMA_VERSION,
      timestamp: now,
      translated,
    };

    try {
      const res = await browser.storage.local.get([META_KEY]);
      let meta = res[META_KEY] || { keys: [] };

      // Phase 52.2: Inline metadata update — no separate _updateMetadata call
      meta.keys = meta.keys.filter((k) => k.key !== key);
      meta.keys.unshift({ key, videoId, sl, tl, lastUsed: now });

      // Phase 52.2: Atomic write — data + metadata in single storage.set()
      await browser.storage.local.set({ [key]: entry, [META_KEY]: meta });

      // Phase 52.2: Evict using same metadata snapshot (no re-read)
      await this._evictIfNeeded(meta);

      Logger.info(
        'Cache',
        `Cache SET for ${videoId} (${sl}->${tl}) - ${translated.length} entries`
      );
    } catch (e) {
      Logger.error('Cache', `Error writing cache: ${e.message}`);
    }
  },

  /**
   * Remove specific entry.
   */
  async remove(videoId, sl, tl) {
    const key = `${CACHE_PREFIX}${videoId}_${sl}_${tl}`;
    await browser.storage.local.remove(key);

    const res = await browser.storage.local.get([META_KEY]);
    let meta = res[META_KEY];
    if (meta && meta.keys) {
      meta.keys = meta.keys.filter((k) => k.key !== key);
      await browser.storage.local.set({ [META_KEY]: meta });
    }
  },

  /**
   * Clear all translation variants for a specific video.
   * @param {string} videoId
   */
  async removeByVideoId(videoId) {
    if (!videoId) return;
    const res = await browser.storage.local.get(null);
    const keysToRemove = Object.keys(res).filter((k) => k.startsWith(`${CACHE_PREFIX}${videoId}_`));

    if (keysToRemove.length > 0) {
      await browser.storage.local.remove(keysToRemove);

      const metaRes = await browser.storage.local.get([META_KEY]);
      let meta = metaRes[META_KEY];
      if (meta && meta.keys) {
        meta.keys = meta.keys.filter((k) => !keysToRemove.includes(k.key));
        await browser.storage.local.set({ [META_KEY]: meta });
      }
      Logger.info('Cache', `Removed ${keysToRemove.length} cache items for video ${videoId}`);
    }
  },

  /**
   * Clear all translation cache.
   * @returns {Promise<number>} Number of keys removed
   */
  async clearAll() {
    const res = await browser.storage.local.get(null);
    const keysToRemove = Object.keys(res).filter(
      (k) => k.startsWith(CACHE_PREFIX) || k === META_KEY
    );
    await browser.storage.local.remove(keysToRemove);
    Logger.info('Cache', `Cache CLEARED completely. Removed ${keysToRemove.length} items.`);
    return keysToRemove.length;
  },

  /**
   * Update lastUsed and ensure unique keys in metadata.
   */
  async _updateMetadata(videoId, sl, tl, meta, key) {
    const now = Date.now();
    // Remove if exists
    meta.keys = meta.keys.filter((k) => k.key !== key);
    // Add to top (most recent)
    meta.keys.unshift({
      key,
      videoId,
      sl,
      tl,
      lastUsed: now,
    });

    await browser.storage.local.set({ [META_KEY]: meta });
  },

  /**
   * Remove oldest items if limit exceeded.
   * Phase 52.2: Accept metadata snapshot to avoid stale re-read.
   */
  async _evictIfNeeded(meta) {
    if (!meta || meta.keys.length <= MAX_ENTRIES) return;

    const toRemove = meta.keys.slice(MAX_ENTRIES);
    meta.keys = meta.keys.slice(0, MAX_ENTRIES);

    const keysToRemove = toRemove.map((k) => k.key);
    await browser.storage.local.remove(keysToRemove);
    await browser.storage.local.set({ [META_KEY]: meta });

    Logger.info('Cache', `LRU Eviction: Removed ${keysToRemove.length} oldest entries.`);
  },

  /**
   * Retrieve cached AI-generated or user-imported full subtitle entries.
   * Stored under sl='gen' so hasAnyForVideoTarget, removeByVideoId, clearAll,
   * and LRU eviction work automatically.
   */
  async getGenerated(videoId, tl) {
    if (!videoId) return null;
    const key = `${CACHE_PREFIX}${videoId}_gen_${tl}`;

    try {
      const res = await browser.storage.local.get([key, META_KEY]);
      const data = res[key];
      const meta = res[META_KEY] || { keys: [] };

      if (!data) return null;

      if (Date.now() - data.timestamp > TTL_MS) {
        Logger.info('Cache', `Generated cache EXPIRED for ${videoId} (${tl})`);
        await this.remove(videoId, 'gen', tl);
        return null;
      }

      await this._updateMetadata(videoId, 'gen', tl, meta, key);
      return {
        entries: Array.isArray(data.entries) ? data.entries : [],
        completedBatches: Array.isArray(data.completedBatches) ? data.completedBatches : [],
        windowSec: data.windowSec ?? null,
        durationSec: data.durationSec ?? null,
      };
    } catch (e) {
      Logger.error('Cache', `Error reading generated cache: ${e.message}`);
      return null;
    }
  },

  /**
   * Save full generated or imported subtitle entries (with startMs/endMs/original/text).
   */
  async setGenerated(videoId, tl, payload = {}) {
    if (!videoId || !Array.isArray(payload.entries) || payload.entries.length === 0) return;

    const key = `${CACHE_PREFIX}${videoId}_gen_${tl}`;
    const now = Date.now();
    const record = {
      videoId,
      sl: 'gen',
      tl,
      timestamp: now,
      windowSec: payload.windowSec ?? null,
      durationSec: payload.durationSec ?? null,
      completedBatches: Array.isArray(payload.completedBatches)
        ? payload.completedBatches
        : ['all'],
      entries: payload.entries,
    };

    try {
      const res = await browser.storage.local.get([META_KEY]);
      const meta = res[META_KEY] || { keys: [] };
      meta.keys = meta.keys.filter((k) => k.key !== key);
      meta.keys.unshift({ key, videoId, sl: 'gen', tl, lastUsed: now });

      await browser.storage.local.set({ [key]: record, [META_KEY]: meta });
      await this._evictIfNeeded(meta);

      Logger.info(
        'Cache',
        `Generated cache SET for ${videoId} (${tl}) - ${record.entries.length} entries`
      );
    } catch (e) {
      Logger.error('Cache', `Error writing generated cache: ${e.message}`);
    }
  },

  /**
   * Incrementally merge a completed Gemini video window batch into the cache.
   */
  async mergeGeneratedBatch(videoId, tl, { windowSec, durationSec, batchIndex, entries }) {
    if (!videoId || typeof batchIndex !== 'number') return;

    const key = `${CACHE_PREFIX}${videoId}_gen_${tl}`;
    const now = Date.now();

    try {
      const res = await browser.storage.local.get([key, META_KEY]);
      const existing = res[key];
      const meta = res[META_KEY] || { keys: [] };

      const canReuse =
        existing &&
        now - existing.timestamp <= TTL_MS &&
        (existing.windowSec === windowSec || existing.windowSec == null);

      const byRange = new Map();
      if (canReuse && Array.isArray(existing.entries)) {
        for (const item of existing.entries) {
          if (item && typeof item.startMs === 'number' && typeof item.endMs === 'number') {
            byRange.set(`${item.startMs}_${item.endMs}`, item);
          }
        }
      }
      if (Array.isArray(entries)) {
        for (const item of entries) {
          if (item && typeof item.startMs === 'number' && typeof item.endMs === 'number') {
            byRange.set(`${item.startMs}_${item.endMs}`, item);
          }
        }
      }

      const mergedEntries = Array.from(byRange.values()).sort(
        (a, b) => a.startMs - b.startMs || a.endMs - b.endMs
      );

      const batchSet = new Set(
        canReuse && Array.isArray(existing.completedBatches)
          ? existing.completedBatches.filter((b) => typeof b === 'number')
          : []
      );
      batchSet.add(batchIndex);
      const completedBatches = Array.from(batchSet).sort((a, b) => a - b);

      const record = {
        videoId,
        sl: 'gen',
        tl,
        timestamp: now,
        windowSec,
        durationSec: durationSec ?? (canReuse ? existing.durationSec : null),
        completedBatches,
        entries: mergedEntries,
      };

      meta.keys = meta.keys.filter((k) => k.key !== key);
      meta.keys.unshift({ key, videoId, sl: 'gen', tl, lastUsed: now });

      await browser.storage.local.set({ [key]: record, [META_KEY]: meta });
      await this._evictIfNeeded(meta);

      Logger.info(
        'Cache',
        `Merged generated batch #${batchIndex} for ${videoId} (${tl}) - ${mergedEntries.length} total entries`
      );
    } catch (e) {
      Logger.error('Cache', `Error merging generated batch cache: ${e.message}`);
    }
  },
};
