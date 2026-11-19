import { jest } from '@jest/globals';
import { Cache } from '../../src/background/cache.js';

describe('Cache Module', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await chrome.storage.local.clear();
  });

  test('should return null for non-existent video', async () => {
    const data = await Cache.get('nonexistent', 'en', 'vi');
    expect(data).toBeNull();
  });

  test('should set and get cache correctly', async () => {
    const videoId = 'test123';
    const translated = [{ text: 'Hello', startMs: 0, endMs: 1000 }];

    await Cache.set(videoId, 'en', 'vi', translated);
    const cached = await Cache.get(videoId, 'en', 'vi');

    expect(cached).toEqual(translated);
    expect(chrome.storage.local.set).toHaveBeenCalled();
  });

  test('invalidates legacy unversioned cache entries predating alignment fixes', async () => {
    const key = 'yousub_vcache_vid_old_en_vi';
    await chrome.storage.local.set({
      [key]: {
        videoId: 'vid_old',
        sl: 'en',
        tl: 'vi',
        timestamp: Date.now(),
        translated: ['shifted legacy line'],
      },
    });

    const cached = await Cache.get('vid_old', 'en', 'vi');
    expect(cached).toBeNull();
    const stored = await chrome.storage.local.get(key);
    expect(stored[key]).toBeUndefined();
  });

  test('should respect TTL (expiration)', async () => {
    const videoId = 'test_ttl';
    const translated = [{ text: 'Old' }];
    const sl = 'en',
      tl = 'vi';

    const now = Date.now();
    const key = `yousub_vcache_${videoId}_${sl}_${tl}`;

    // Manually inject expired entry
    await chrome.storage.local.set({
      [key]: {
        videoId,
        sl,
        tl,
        translated,
        timestamp: now - 31 * 24 * 60 * 60 * 1000, // 31 days ago (TTL is 30)
      },
    });

    const cached = await Cache.get(videoId, sl, tl);
    expect(cached).toBeNull();
    // Verify it was removed
    const stored = await chrome.storage.local.get(key);
    expect(stored[key]).toBeUndefined();
  });

  test('should evict oldest entries when MAX_ENTRIES is exceeded (LRU)', async () => {
    const translated = [{ text: 'data' }];

    // Fill cache to limit (100)
    for (let i = 1; i <= 100; i++) {
      await Cache.set(`vid_${i}`, 'en', 'vi', translated);
    }

    // Verify 100 items + 1 metadata
    let storeKeys = Object.keys(chrome.storage.local.store).filter((k) => k !== 'yousub_logs');
    expect(storeKeys.length).toBe(101);

    // Add 101st item
    await Cache.set('vid_new', 'en', 'vi', translated);

    // Metadata should still be 100 keys (1 item evicted)
    const res = await chrome.storage.local.get('yousub_vcache_metadata');
    expect(res.yousub_vcache_metadata.keys.length).toBe(100);

    // The oldest one (vid_1) should be gone
    const evicted = await chrome.storage.local.get('yousub_vcache_vid_1_en_vi');
    expect(evicted['yousub_vcache_vid_1_en_vi']).toBeUndefined();
  });

  test('clearAll should remove all cache entries and metadata', async () => {
    await Cache.set('v1', 'en', 'vi', [{ text: 'hi' }]);
    await Cache.clearAll();

    const store = chrome.storage.local.store;
    const cacheKeys = Object.keys(store).filter((k) => k.startsWith('yousub_vcache_'));
    expect(cacheKeys.length).toBe(0);
  });

  // ─── hasAnyForVideoTarget (source-language-agnostic auto-start probe) ───
  describe('hasAnyForVideoTarget', () => {
    test('true when an entry exists under the legacy "auto" source key', async () => {
      await Cache.set('vid_a', 'auto', 'vi', [{ text: 'hi' }]);
      expect(await Cache.hasAnyForVideoTarget('vid_a', 'vi')).toBe(true);
    });

    test('true when an entry exists under a CONCRETE source key (B-c regression case)', async () => {
      // The regression: probe used to pin "auto" and miss the single-track "en" entry.
      await Cache.set('vid_b', 'en', 'vi', [{ text: 'hi' }]);
      expect(await Cache.hasAnyForVideoTarget('vid_b', 'vi')).toBe(true);
    });

    test('false when no entry exists for that video+target', async () => {
      await Cache.set('vid_c', 'en', 'vi', [{ text: 'hi' }]);
      expect(await Cache.hasAnyForVideoTarget('vid_missing', 'vi')).toBe(false);
    });

    test('false when the target language differs', async () => {
      await Cache.set('vid_d', 'en', 'vi', [{ text: 'hi' }]);
      expect(await Cache.hasAnyForVideoTarget('vid_d', 'ja')).toBe(false);
    });

    test('ignores TTL at the probe (defers expiry to the serve-time Cache.get)', async () => {
      await Cache.set('vid_e', 'en', 'vi', [{ text: 'old' }]);
      // Age the stored data entry past the TTL. The probe reads metadata only, so it
      // still reports existence; the actual serve (Cache.get) re-checks TTL and misses.
      const key = 'yousub_vcache_vid_e_en_vi';
      const stored = await chrome.storage.local.get(key);
      stored[key].timestamp = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days (TTL is 30)
      await chrome.storage.local.set({ [key]: stored[key] });

      expect(await Cache.hasAnyForVideoTarget('vid_e', 'vi')).toBe(true);
      expect(await Cache.get('vid_e', 'en', 'vi')).toBeNull(); // serve-time TTL enforced
    });

    test('does not false-match a videoId that is a prefix of another', async () => {
      // Matches on the structured metadata videoId field (not string prefixes), so
      // 'ab' must not match an entry stored for 'ab_cd'.
      await Cache.set('ab_cd', 'en', 'vi', [{ text: 'hi' }]);
      expect(await Cache.hasAnyForVideoTarget('ab_cd', 'vi')).toBe(true);
      expect(await Cache.hasAnyForVideoTarget('ab', 'vi')).toBe(false);
    });

    test('returns false for a falsy videoId', async () => {
      expect(await Cache.hasAnyForVideoTarget('', 'vi')).toBe(false);
      expect(await Cache.hasAnyForVideoTarget(null, 'vi')).toBe(false);
    });
  });

  describe('generated & incremental batch cache (Phase 78)', () => {
    test('mergeGeneratedBatch accumulates out-of-order windows and integrates with probe & clear', async () => {
      await Cache.mergeGeneratedBatch('vid_gen', 'vi', {
        windowSec: 240,
        durationSec: 1500,
        batchIndex: 5,
        entries: [{ startMs: 1200000, endMs: 1203000, original: 'Six', text: 'Sau' }],
      });
      await Cache.mergeGeneratedBatch('vid_gen', 'vi', {
        windowSec: 240,
        durationSec: 1500,
        batchIndex: 0,
        entries: [{ startMs: 1000, endMs: 4000, original: 'One', text: 'Mot' }],
      });

      expect(await Cache.hasAnyForVideoTarget('vid_gen', 'vi')).toBe(true);

      const cached = await Cache.getGenerated('vid_gen', 'vi');
      expect(cached.windowSec).toBe(240);
      expect(cached.completedBatches).toEqual([0, 5]);
      expect(cached.entries.map((e) => e.text)).toEqual(['Mot', 'Sau']);

      await Cache.removeByVideoId('vid_gen');
      expect(await Cache.getGenerated('vid_gen', 'vi')).toBeNull();
    });

    test('setGenerated stores full imported SRT entries and enforces 30-day TTL', async () => {
      await Cache.setGenerated('vid_srt', 'ja', {
        entries: [{ startMs: 500, endMs: 1500, original: 'Hi', text: 'こんにちは' }],
        completedBatches: ['all'],
      });
      const hit = await Cache.getGenerated('vid_srt', 'ja');
      expect(hit.completedBatches).toEqual(['all']);
      expect(hit.entries).toHaveLength(1);

      const key = 'yousub_vcache_vid_srt_gen_ja';
      const stored = await chrome.storage.local.get(key);
      stored[key].timestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
      await chrome.storage.local.set({ [key]: stored[key] });
      expect(await Cache.getGenerated('vid_srt', 'ja')).toBeNull();
    });
  });
});
