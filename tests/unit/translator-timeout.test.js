import { describe, test, expect } from '@jest/globals';
import { _internals } from '../../src/background/translator.js';

const {
  computeForceTimeoutMs,
  soonestCooldownWaitMs,
  getCooldownKey,
  BASE_FORCE_TIMEOUT_MS,
  MAX_FORCE_TIMEOUT_MS,
  SWEEP_MAX_WAIT_MS,
} = _internals;

// ─── Phase 64 (c): force-timeout scaling ──────────────────────────────

describe('computeForceTimeoutMs', () => {
  test('uses the floor for short transcripts', () => {
    expect(computeForceTimeoutMs(0)).toBe(BASE_FORCE_TIMEOUT_MS); // 180000
    expect(computeForceTimeoutMs(50)).toBe(BASE_FORCE_TIMEOUT_MS); // 50*2500=125000 < floor
    expect(computeForceTimeoutMs(72)).toBe(BASE_FORCE_TIMEOUT_MS); // 72*2500=180000 == floor
  });

  test('scales with line count above the floor', () => {
    expect(computeForceTimeoutMs(100)).toBe(250000); // 100*2500
    expect(computeForceTimeoutMs(73)).toBe(182500); // just above the floor
  });

  test('never exceeds the hard ceiling', () => {
    expect(computeForceTimeoutMs(1000)).toBe(MAX_FORCE_TIMEOUT_MS); // 2.5M capped to 600000
    expect(computeForceTimeoutMs(100000)).toBe(MAX_FORCE_TIMEOUT_MS);
  });

  test('handles missing/invalid input as 0', () => {
    expect(computeForceTimeoutMs(undefined)).toBe(BASE_FORCE_TIMEOUT_MS);
  });
});

// ─── Phase 64 (sweep): cooldown-aware pacing ──────────────────────────

describe('soonestCooldownWaitMs', () => {
  const keys = [
    { apiKey: 'k1', model: 'm1' },
    { apiKey: 'k2', model: 'm2' },
  ];
  const NOW = 1_000_000;

  function cooldownMap(entries) {
    const m = new Map();
    for (const [key, until] of entries) m.set(key, until);
    return m;
  }

  test('returns 0 when no keys are cooling down', () => {
    expect(soonestCooldownWaitMs(keys, new Map(), NOW)).toBe(0);
  });

  test('returns 0 when at least one key is free', () => {
    const m = cooldownMap([[getCooldownKey('k1', 'm1'), NOW + 9000]]); // k2 still free
    expect(soonestCooldownWaitMs(keys, m, NOW)).toBe(0);
  });

  test('waits for the soonest expiry when all keys are cooled', () => {
    const m = cooldownMap([
      [getCooldownKey('k1', 'm1'), NOW + 8000],
      [getCooldownKey('k2', 'm2'), NOW + 3000],
    ]);
    expect(soonestCooldownWaitMs(keys, m, NOW)).toBe(3000); // soonest = k2
  });

  test('caps the wait at SWEEP_MAX_WAIT_MS', () => {
    const m = cooldownMap([
      [getCooldownKey('k1', 'm1'), NOW + 60000],
      [getCooldownKey('k2', 'm2'), NOW + 45000],
    ]);
    expect(soonestCooldownWaitMs(keys, m, NOW)).toBe(SWEEP_MAX_WAIT_MS); // 15000
  });

  test('returns 0 for an empty key list', () => {
    expect(soonestCooldownWaitMs([], new Map(), NOW)).toBe(0);
    expect(soonestCooldownWaitMs(undefined, new Map(), NOW)).toBe(0);
  });
});
