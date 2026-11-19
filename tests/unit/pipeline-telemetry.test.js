import { describe, test, expect, beforeEach } from '@jest/globals';
import {
  PipelineTelemetry,
  createInitialSnapshot,
  computeHorizons,
  findBatchForTime,
  formatTimeShort,
  maskApiKey,
  PIPELINE_KEY_PREFIX,
  MAX_STORED_PIPELINES,
} from '../../src/shared/pipeline-telemetry.js';

describe('PipelineTelemetry store (Phase 80a)', () => {
  beforeEach(() => {
    chrome.storage.local.store = {};
    chrome.storage.session.store = {};
    PipelineTelemetry._resetMemoryForTests();
  });

  test('formatTimeShort and maskApiKey format telemetry metadata cleanly', () => {
    expect(formatTimeShort(0)).toBe('00:00');
    expect(formatTimeShort(245000)).toBe('04:05');
    expect(formatTimeShort(3665000)).toBe('1:01:05');
    expect(maskApiKey('AIzaSySecretKey9876')).toBe('...9876');
    expect(maskApiKey('')).toBe('');
  });

  test('reset, update, getSnapshot, and getLatestSnapshot persist and compute Past/Present/Future horizons', async () => {
    await PipelineTelemetry.reset('vid-1', {
      mode: 'transcript',
      stage: 'COALESCE',
      extraction: { source: 'dom-transcript', sourceLang: 'en', targetLang: 'vi' },
      coalescer: { rawCount: 120, coalescedCount: 48, mergedCues: 72 },
      batches: [
        { batchIndex: 0, startLine: 1, endLine: 48, startMs: 0, endMs: 120000, status: 'DONE' },
        {
          batchIndex: 1,
          startLine: 49,
          endLine: 90,
          startMs: 120000,
          endMs: 240000,
          status: 'IN_FLIGHT',
          isSeekTarget: true,
        },
        {
          batchIndex: 2,
          startLine: 91,
          endLine: 120,
          startMs: 240000,
          endMs: 360000,
          status: 'PREFETCH',
        },
      ],
      router: { activeProvider: 'google', activeModel: 'gemini-2.5-flash', keyMask: '...1234' },
    });

    const snap = await PipelineTelemetry.getSnapshot('vid-1');
    expect(snap.horizons.past).toContain('120→48 cues');
    expect(snap.horizons.past).toContain('1/3 batches done');
    expect(snap.horizons.present).toContain('gemini-2.5-flash');
    expect(snap.horizons.present).toContain('⚡Seek');
    expect(snap.horizons.future).toContain('Lookahead: Batch #3');

    const latest = await PipelineTelemetry.getLatestSnapshot();
    expect(latest.videoId).toBe('vid-1');
  });

  test('recordSeek updates playheadMs, playheadBatchIndex, and marks target batch', async () => {
    await PipelineTelemetry.reset('vid-seek', {
      batches: [
        { batchIndex: 0, startMs: 0, endMs: 60000, status: 'PENDING' },
        { batchIndex: 1, startMs: 60000, endMs: 120000, status: 'PENDING' },
        { batchIndex: 2, startMs: 120000, endMs: 180000, status: 'PENDING' },
      ],
    });

    const updated = await PipelineTelemetry.recordSeek('vid-seek', 135000);
    expect(updated.playheadMs).toBe(135000);
    expect(updated.playheadBatchIndex).toBe(2);
    expect(updated.batches[2].isSeekTarget).toBe(true);
    expect(updated.seekEvents).toHaveLength(1);
    expect(findBatchForTime(updated.batches, 70000)).toBe(1);
  });

  test('prunes old pipeline snapshots in storage.local beyond MAX_STORED_PIPELINES', async () => {
    for (let i = 0; i < MAX_STORED_PIPELINES + 2; i++) {
      await PipelineTelemetry.reset(`vid-${i}`, { stage: 'COMPLETE' });
    }

    const storedKeys = Object.keys(chrome.storage.local.store).filter((k) =>
      k.startsWith(`${PIPELINE_KEY_PREFIX}vid-`)
    );
    expect(storedKeys.length).toBeLessThanOrEqual(MAX_STORED_PIPELINES);
    expect(chrome.storage.local.store[`${PIPELINE_KEY_PREFIX}vid-6`]).toBeDefined();
    expect(chrome.storage.local.store[`${PIPELINE_KEY_PREFIX}vid-0`]).toBeUndefined();
  });

  test('reads updated storage written from another context over stale memory cache and handles clear()', async () => {
    await PipelineTelemetry.reset('vid-cross', { stage: 'EXTRACT' });
    const crossSnap = createInitialSnapshot('vid-cross', { stage: 'COMPLETE' });
    chrome.storage.session.store[`${PIPELINE_KEY_PREFIX}vid-cross`] = crossSnap;

    const loaded = await PipelineTelemetry.getSnapshot('vid-cross');
    expect(loaded.stage).toBe('COMPLETE');

    const errorHorizons = computeHorizons(
      createInitialSnapshot('v-err', { stage: 'ERROR', error: { failureReason: 'NO_API_KEYS' } })
    );
    expect(errorHorizons.present).toContain('NO_API_KEYS');

    await PipelineTelemetry.clear('vid-cross');
    expect(chrome.storage.session.store[`${PIPELINE_KEY_PREFIX}vid-cross`]).toBeUndefined();
  });

  test('blocks delayed COALESCE reset from overwriting COMPLETE on the same runId across session/local storage', async () => {
    const runId = 'vid-race:run-1';

    // Simulate content script starting EXTRACT (written only to storage.local in MV3)
    const extractSnap = createInitialSnapshot('vid-race', {
      runId,
      stage: 'EXTRACT',
      updatedAt: 1000,
    });
    chrome.storage.local.store[`${PIPELINE_KEY_PREFIX}vid-race`] = extractSnap;

    // Service worker hits cache and marks COMPLETE in session & local storage before content's COALESCE fires
    const completeSnap = createInitialSnapshot('vid-race', {
      runId,
      mode: 'cache',
      stage: 'COMPLETE',
      sink: { syncedCues: 229, totalCues: 229, cached: true },
      updatedAt: 1001,
    });
    chrome.storage.session.store[`${PIPELINE_KEY_PREFIX}vid-race`] = completeSnap;
    chrome.storage.local.store[`${PIPELINE_KEY_PREFIX}vid-race`] = completeSnap;

    // Delayed COALESCE reset arrives from content script with the SAME runId -> must be ignored!
    const result = await PipelineTelemetry.reset('vid-race', {
      runId,
      stage: 'COALESCE',
      coalescer: { rawCount: 229, coalescedCount: 229, mergedCues: 0 },
    });

    expect(result.stage).toBe('COMPLETE');
    const persistedLocal = chrome.storage.local.store[`${PIPELINE_KEY_PREFIX}vid-race`];
    expect(persistedLocal.stage).toBe('COMPLETE');
    expect(persistedLocal.sink.syncedCues).toBe(229);

    // A brand-new run (new runId) resets back to EXTRACT cleanly
    const nextRun = await PipelineTelemetry.reset('vid-race', {
      runId: 'vid-race:run-2',
      stage: 'EXTRACT',
    });
    expect(nextRun.stage).toBe('EXTRACT');
    expect(nextRun.runId).toBe('vid-race:run-2');
  });

  test('pickFreshestSnapshot prefers newer content-script local write over stale session snapshot', async () => {
    const olderSession = createInitialSnapshot('vid-fresh', {
      runId: 'r1',
      stage: 'EXTRACT',
      updatedAt: 1000,
    });
    const newerLocal = createInitialSnapshot('vid-fresh', {
      runId: 'r1',
      stage: 'COALESCE',
      coalescer: { rawCount: 229, coalescedCount: 180, mergedCues: 49 },
      updatedAt: 1005,
    });
    chrome.storage.session.store[`${PIPELINE_KEY_PREFIX}vid-fresh`] = olderSession;
    chrome.storage.local.store[`${PIPELINE_KEY_PREFIX}vid-fresh`] = newerLocal;

    const updated = await PipelineTelemetry.update('vid-fresh', { stage: 'ROUTE' });
    expect(updated.coalescer.rawCount).toBe(229);
    expect(updated.coalescer.coalescedCount).toBe(180);
    expect(updated.stage).toBe('ROUTE');
  });
});
