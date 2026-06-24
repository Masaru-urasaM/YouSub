import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { APIManager } from '../../src/background/api-manager.js';
import { HealthManager } from '../../src/background/health.js';

describe('APIManager Module', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await chrome.storage.local.clear();
  });

  const mockKeys = [
    { provider: 'google', apiKey: 'key1' },
    { provider: 'openai', apiKey: 'key2' },
    { provider: 'anthropic', apiKey: 'key3' },
  ];

  test('should return all healthy keys when failover is enabled', async () => {
    await chrome.storage.local.set({
      yousub_api_keys: mockKeys,
      yousub_failover_enabled: true,
      yousub_model_rotation: false, // isolate failover logic from model-rotation expansion
    });

    const keys = await APIManager.getValidKeys();
    expect(keys).toHaveLength(3);
    expect(keys[0].provider).toBe('google'); // Primary remains first
  });

  test('should return only primary key when failover is disabled', async () => {
    await chrome.storage.local.set({
      yousub_api_keys: mockKeys,
      yousub_failover_enabled: false,
      yousub_model_rotation: false,
    });

    const keys = await APIManager.getValidKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].provider).toBe('google');
  });

  test('should filter out keys with open circuit breaker', async () => {
    await chrome.storage.local.set({
      yousub_api_keys: mockKeys,
      yousub_failover_enabled: true,
      yousub_model_rotation: false,
    });

    // Manually trip circuit breaker for OpenAI (key2)
    const hash = HealthManager.getHash('openai', 'key2');
    await chrome.storage.local.set({
      yousub_health_stats: {
        [hash]: { circuitBreakerUntil: Date.now() + 10000, consecutiveFails: 3 },
      },
    });

    const keys = await APIManager.getValidKeys();
    expect(keys).toHaveLength(2);
    expect(keys.find((k) => k.provider === 'openai')).toBeUndefined();
  });

  test('should sort backups by health score', async () => {
    await chrome.storage.local.set({
      yousub_api_keys: mockKeys,
      yousub_failover_enabled: true,
      yousub_model_rotation: false,
    });

    // key3 (Anthropic) is very healthy, key2 (OpenAI) is meh
    const hash2 = HealthManager.getHash('openai', 'key2');
    const hash3 = HealthManager.getHash('anthropic', 'key3');

    await chrome.storage.local.set({
      yousub_health_stats: {
        [hash2]: { successCount: 1, failCount: 1, avgTime: 2000 }, // Score ~0.3
        [hash3]: { successCount: 10, failCount: 0, avgTime: 500 }, // Score ~0.9
      },
    });

    const keys = await APIManager.getValidKeys();
    expect(keys).toHaveLength(3);
    expect(keys[1].provider).toBe('anthropic'); // Anthropic moved up in backups
    expect(keys[2].provider).toBe('openai');
  });

  test('should expand each key into per-model rotation clones when rotation is enabled', async () => {
    await chrome.storage.local.set({
      yousub_api_keys: mockKeys,
      yousub_failover_enabled: true,
      yousub_model_rotation: true, // default-on path: each key fans out across its models
    });

    const keys = await APIManager.getValidKeys();

    // Rotation must produce strictly more entries than the 3 base keys.
    expect(keys.length).toBeGreaterThan(3);
    // The first entry of each provider is the base (no clone flag); the extras are clones.
    expect(keys.some((k) => k.isRotationClone === true)).toBe(true);
    // Base keys (one per provider) are still present and not flagged as clones.
    const baseKeys = keys.filter((k) => !k.isRotationClone);
    expect(baseKeys.map((k) => k.provider)).toEqual(['google', 'openai', 'anthropic']);
  });

  test('should mark key as failed in storage', async () => {
    await chrome.storage.local.set({ yousub_api_keys: mockKeys });

    await APIManager.markKeyFailed('google', 'key1', 'Quota Exceeded');

    const res = await chrome.storage.local.get('yousub_api_keys');
    const key = res.yousub_api_keys.find((k) => k.provider === 'google');
    expect(key.status).toBe('failed');
    expect(key.statusMessage).toBe('Quota Exceeded');
  });
});
