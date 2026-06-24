import { describe, test, expect, beforeEach } from '@jest/globals';
import { SyncEngine } from '../../src/content/sync-engine.js';

/**
 * Phase 64 (b) — Partial-result preservation support.
 * Verifies SyncEngine.getTranslatedCount(), the signal the content-script
 * failure path uses to decide between preserving partials and tearing down.
 */
describe('SyncEngine.getTranslatedCount (Phase 64b)', () => {
  beforeEach(() => {
    // stop() resets the module-level translatedIndices set.
    SyncEngine.stop();
  });

  test('returns 0 when nothing has been translated', () => {
    expect(SyncEngine.getTranslatedCount()).toBe(0);
  });

  test('counts only lines whose text differs from the original', () => {
    SyncEngine.updateSubtitles([
      { startMs: 0, endMs: 1000, original: 'a', text: 'a' }, // untranslated
      { startMs: 1000, endMs: 2000, original: 'b', text: 'translated-b' },
      { startMs: 2000, endMs: 3000, original: 'c', text: 'translated-c' },
    ]);
    expect(SyncEngine.getTranslatedCount()).toBe(2);
  });

  test('updatePartial increments the translated count for streamed batches', () => {
    SyncEngine.updateSubtitles([
      { startMs: 0, endMs: 1000, original: 'a', text: 'a' },
      { startMs: 1000, endMs: 2000, original: 'b', text: 'b' },
    ]);
    expect(SyncEngine.getTranslatedCount()).toBe(0);

    SyncEngine.updatePartial(['translated-a'], 0);
    expect(SyncEngine.getTranslatedCount()).toBe(1);

    SyncEngine.updatePartial(['translated-b'], 1);
    expect(SyncEngine.getTranslatedCount()).toBe(2);
  });

  test('count is reset to 0 after stop()', () => {
    SyncEngine.updateSubtitles([{ startMs: 0, endMs: 1000, original: 'a', text: 'translated-a' }]);
    expect(SyncEngine.getTranslatedCount()).toBe(1);
    SyncEngine.stop();
    expect(SyncEngine.getTranslatedCount()).toBe(0);
  });
});
