import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { HealthManager } from '../../src/background/health.js';

describe('HealthManager Module', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await chrome.storage.local.clear();
  });

  test('should hashing correctly', () => {
    const hash = HealthManager.getHash('google', 'AIza_very_long_key_123456');
    expect(hash).toBe('google_123456');
  });

  test('should report success and calculate score', async () => {
    const provider = 'google';
    const key = 'key1';

    await HealthManager.report(provider, key, true, 500); // 500ms

    const score = await HealthManager.getScore(provider, key);
    expect(score).toBeGreaterThan(0.5);

    const stats = await chrome.storage.local.get('yousub_health_stats');
    const hash = HealthManager.getHash(provider, key);
    expect(stats.yousub_health_stats[hash].successCount).toBe(1);
    expect(stats.yousub_health_stats[hash].avgTime).toBe(500);
  });

  test('should open circuit breaker after 10 consecutive failures', async () => {
    const provider = 'openai';
    const key = 'key2';

    await HealthManager.report(provider, key, false);
    await HealthManager.report(provider, key, false);

    let isOpen = await HealthManager.isCircuitOpen(provider, key);
    expect(isOpen).toBe(false);

    // 8 more failures (10 total) — the breaker opens at consecutiveFails >= 10 (health.js:65)
    for (let i = 0; i < 8; i++) {
      await HealthManager.report(provider, key, false);
    }
    isOpen = await HealthManager.isCircuitOpen(provider, key);
    expect(isOpen).toBe(true);

    const stats = await chrome.storage.local.get('yousub_health_stats');
    const hash = HealthManager.getHash(provider, key);
    expect(stats.yousub_health_stats[hash].circuitBreakerUntil).toBeGreaterThan(Date.now());
  });

  test('should reset consecutive failures on success', async () => {
    const provider = 'openai';
    const key = 'key2';

    await HealthManager.report(provider, key, false);
    await HealthManager.report(provider, key, false);
    await HealthManager.report(provider, key, true); // Success resets counter

    const stats = await chrome.storage.local.get('yousub_health_stats');
    const hash = HealthManager.getHash(provider, key);
    expect(stats.yousub_health_stats[hash].consecutiveFails).toBe(0);
  });

  test('should return default score for new keys', async () => {
    const score = await HealthManager.getScore('new', 'key');
    expect(score).toBe(0.5);
  });

  describe('computeScore (Phase 75a — unified scoring formula)', () => {
    test('returns the neutral 0.5 for missing or zero-sample entries', () => {
      expect(HealthManager.computeScore(undefined)).toBe(0.5);
      expect(HealthManager.computeScore(null)).toBe(0.5);
      expect(HealthManager.computeScore({ successCount: 0, failCount: 0 })).toBe(0.5);
    });

    test('weights success-rate by a 10s-capped speed multiplier', () => {
      // successRate 0.5, speedMult max(0.1, 1 - 2000/10000) = 0.8 -> 0.4
      expect(
        HealthManager.computeScore({ successCount: 1, failCount: 1, avgTime: 2000 })
      ).toBeCloseTo(0.4, 5);
      // successRate 1.0, speedMult max(0.1, 1 - 500/10000) = 0.95 -> 0.95
      expect(
        HealthManager.computeScore({ successCount: 10, failCount: 0, avgTime: 500 })
      ).toBeCloseTo(0.95, 5);
    });

    test('floors the speed multiplier at 0.1 for very slow keys (>10s)', () => {
      // avgTime 50000 -> 1 - 5 = -4, floored to 0.1; successRate 1 -> 0.1
      expect(
        HealthManager.computeScore({ successCount: 1, failCount: 0, avgTime: 50000 })
      ).toBeCloseTo(0.1, 5);
    });

    test('applies no speed penalty when avgTime is 0 (untimed)', () => {
      // successRate 1.0, speedMult stays 1.0 -> 1.0
      expect(HealthManager.computeScore({ successCount: 3, failCount: 0, avgTime: 0 })).toBe(1.0);
    });
  });

  describe('getSummary (Phase 80a model normalization)', () => {
    test('resolves deprecated model IDs and auto-detected providers cleanly', async () => {
      await HealthManager.report('groq', 'gsk_demo_key_1234', true, 400);
      const summary = await HealthManager.getSummary([
        { provider: 'auto', model: 'llama-3.3-70b-versatile', apiKey: 'gsk_demo_key_1234' },
        { provider: 'google', model: 'auto', apiKey: 'AIzaDemoKey5678' },
      ]);

      expect(summary[0]).toMatchObject({
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        status: 'healthy',
      });
      expect(summary[1]).toMatchObject({
        provider: 'google',
        model: 'gemini-2.5-flash',
        status: 'healthy',
      });
    });
  });
});
