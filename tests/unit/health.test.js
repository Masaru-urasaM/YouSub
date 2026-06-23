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
});
