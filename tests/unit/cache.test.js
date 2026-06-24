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
});
