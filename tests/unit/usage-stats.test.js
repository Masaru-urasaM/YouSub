import { describe, test, expect, beforeEach } from '@jest/globals';
import {
  DEFAULT_USAGE_STATS,
  normalizeUsageStats,
  estimateSavedUsage,
  applyCacheHitStats,
  applyApiRunStats,
  readUsageStats,
  recordCacheHitUsage,
  recordApiRunUsage,
  resetUsageStats,
} from '../../src/shared/usage-stats.js';
import { USAGE_STATS_KEY } from '../../src/shared/constants.js';

describe('usage-stats.js local token & 30-day cache savings store (Phase 91)', () => {
  beforeEach(() => {
    chrome.storage.local.store = {};
  });

  test('normalizeUsageStats and estimateSavedUsage handle invalid/missing values safely', () => {
    expect(normalizeUsageStats(null)).toEqual(DEFAULT_USAGE_STATS);
    expect(
      normalizeUsageStats({
        videosTranslated: -5,
        cacheHits: '3',
        tokensUsed: 1200.6,
        estimatedTokensSaved: NaN,
      })
    ).toMatchObject({
      videosTranslated: 0,
      cacheHits: 3,
      tokensUsed: 1201,
      estimatedTokensSaved: 0,
    });

    expect(estimateSavedUsage(0)).toEqual({ tokensSaved: 50, requestsSaved: 1 });
    expect(estimateSavedUsage(120)).toEqual({ tokensSaved: 4200, requestsSaved: 3 });
  });

  test('applyCacheHitStats & applyApiRunStats accumulate monotonically', () => {
    const afterApi = applyApiRunStats(DEFAULT_USAGE_STATS, { batchCount: 2, totalTokens: 850 });
    expect(afterApi.videosTranslated).toBe(1);
    expect(afterApi.apiRuns).toBe(1);
    expect(afterApi.apiBatches).toBe(2);
    expect(afterApi.tokensUsed).toBe(850);

    const afterCache = applyCacheHitStats(afterApi, { cueCount: 60 });
    expect(afterCache.videosTranslated).toBe(2);
    expect(afterCache.cacheHits).toBe(1);
    expect(afterCache.estimatedRequestsSaved).toBe(2);
    expect(afterCache.estimatedTokensSaved).toBe(2100);
  });

  test('serialized recordCacheHitUsage, recordApiRunUsage, readUsageStats, and resetUsageStats work without races', async () => {
    const [r1, r2, r3] = await Promise.all([
      recordApiRunUsage({ batchCount: 2, totalTokens: 500 }),
      recordCacheHitUsage({ cueCount: 40 }),
      recordCacheHitUsage({ cueCount: 100 }),
    ]);

    expect(r1.apiRuns).toBe(1);
    expect(r2.cacheHits).toBe(1);
    expect(r3).toMatchObject({
      videosTranslated: 3,
      apiRuns: 1,
      apiBatches: 2,
      tokensUsed: 500,
      cacheHits: 2,
      estimatedRequestsSaved: 3,
      estimatedTokensSaved: 1400 + 3500,
    });

    const persisted = await readUsageStats();
    expect(persisted).toEqual(chrome.storage.local.store[USAGE_STATS_KEY]);

    const cleared = await resetUsageStats();
    expect(cleared).toMatchObject({
      videosTranslated: 0,
      cacheHits: 0,
      tokensUsed: 0,
      estimatedTokensSaved: 0,
    });
  });
});
