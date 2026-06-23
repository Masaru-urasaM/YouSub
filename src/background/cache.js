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
      timestamp: now,
      translated
    };

    try {
      const res = await browser.storage.local.get([META_KEY]);
      let meta = res[META_KEY] || { keys: [] };

      // Phase 52.2: Inline metadata update — no separate _updateMetadata call
      meta.keys = meta.keys.filter(k => k.key !== key);
      meta.keys.unshift({ key, videoId, sl, tl, lastUsed: now });

      // Phase 52.2: Atomic write — data + metadata in single storage.set()
      await browser.storage.local.set({ [key]: entry, [META_KEY]: meta });

      // Phase 52.2: Evict using same metadata snapshot (no re-read)
      await this._evictIfNeeded(meta);

      Logger.info('Cache', `Cache SET for ${videoId} (${sl}->${tl}) - ${translated.length} entries`);
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
      meta.keys = meta.keys.filter(k => k.key !== key);
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
    const keysToRemove = Object.keys(res).filter(k => k.startsWith(`${CACHE_PREFIX}${videoId}_`));

    if (keysToRemove.length > 0) {
      await browser.storage.local.remove(keysToRemove);

      const metaRes = await browser.storage.local.get([META_KEY]);
      let meta = metaRes[META_KEY];
      if (meta && meta.keys) {
        meta.keys = meta.keys.filter(k => !keysToRemove.includes(k.key));
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
    const keysToRemove = Object.keys(res).filter(k => k.startsWith(CACHE_PREFIX) || k === META_KEY);
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
    meta.keys = meta.keys.filter(k => k.key !== key);
    // Add to top (most recent)
    meta.keys.unshift({
      key,
      videoId,
      sl,
      tl,
      lastUsed: now
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

    const keysToRemove = toRemove.map(k => k.key);
    await browser.storage.local.remove(keysToRemove);
    await browser.storage.local.set({ [META_KEY]: meta });

    Logger.info('Cache', `LRU Eviction: Removed ${keysToRemove.length} oldest entries.`);
  }
};
