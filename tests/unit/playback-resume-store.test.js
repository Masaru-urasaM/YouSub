import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { TextEncoder } from 'util';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

jest.unstable_mockModule('../../src/shared/logger.js', () => ({
  Logger: mockLogger,
}));

const { RESUME_STORAGE_KEY, RESUME_SYNC_KEY, RESUME_SETTINGS_KEY, DEFAULT_RESUME_SETTINGS } =
  await import('../../src/shared/constants.js');

const {
  PlaybackResumeStore,
  formatTimestamp,
  normalizeVideoRecord,
  mergeRecords,
  resolveResumeTarget,
  pruneRecordsMap,
  buildCompactSyncMap,
  MAX_LOCAL_VIDEOS,
  MAX_SYNC_VIDEOS,
  MAX_CHECKPOINTS,
  MAX_BOOKMARKS_PER_VIDEO,
} = await import('../../src/shared/playback-resume-store.js');

describe('PlaybackResumeStore (Phase 82)', () => {
  beforeEach(() => {
    chrome.storage.local.store = {};
    chrome.storage.sync.store = {};
    PlaybackResumeStore._resetInternalForTests();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    PlaybackResumeStore._resetInternalForTests();
  });

  describe('formatTimestamp', () => {
    test('formats seconds into M:SS and H:MM:SS cleanly and clamps invalid inputs', () => {
      expect(formatTimestamp(0)).toBe('0:00');
      expect(formatTimestamp(-15)).toBe('0:00');
      expect(formatTimestamp(NaN)).toBe('0:00');
      expect(formatTimestamp(125)).toBe('2:05');
      expect(formatTimestamp(3665)).toBe('1:01:05');
      expect(formatTimestamp(51907.9)).toBe('14:25:07');
    });
  });

  describe('normalizeVideoRecord & mergeRecords', () => {
    test('normalizes both full local records and compact sync records', () => {
      expect(normalizeVideoRecord(null, 'v1')).toBeNull();
      expect(normalizeVideoRecord({}, '')).toBeNull();

      const fromCompact = normalizeVideoRecord(
        { t: 1200, f: 1500, i: 1100, ia: 5000, d: 7200, u: 9000, n: 'Audiobook Ch1' },
        'vidCompact'
      );
      expect(fromCompact).toEqual({
        videoId: 'vidCompact',
        title: 'Audiobook Ch1',
        durationSec: 7200,
        lastTimeSec: 1200,
        furthestTimeSec: 1500,
        lastInteractionTimeSec: 1100,
        lastInteractionAt: 5000,
        checkpoints: [],
        bookmarks: [],
        updatedAt: 9000,
        createdAt: 9000,
      });
    });

    test('mergeRecords combines local and sync records preserving furthest, newest active time, and unioned bookmarks/checkpoints', () => {
      const localRec = {
        videoId: 'v1',
        title: 'Story Part 1',
        durationSec: 10000,
        lastTimeSec: 3600,
        furthestTimeSec: 7200,
        lastInteractionTimeSec: 3500,
        lastInteractionAt: 2000,
        checkpoints: [{ timeSec: 1800, savedAt: 1000 }],
        bookmarks: [{ id: 'b1', timeSec: 1200, label: 'Ch2', createdAt: 900 }],
        updatedAt: 2500,
        createdAt: 500,
      };
      const syncRec = {
        t: 5400,
        f: 5400,
        i: 5300,
        ia: 4000,
        d: 10000,
        u: 4500,
        n: 'Story Part 1',
        bookmarks: [{ id: 'b2', timeSec: 4000, label: 'Ch5', createdAt: 4100 }],
      };

      const merged = mergeRecords(localRec, syncRec);
      expect(merged.lastTimeSec).toBe(5400); // newer updatedAt from sync
      expect(merged.furthestTimeSec).toBe(7200); // max furthest from local
      expect(merged.lastInteractionTimeSec).toBe(5300); // newer lastInteractionAt
      expect(merged.checkpoints).toHaveLength(1);
      expect(merged.bookmarks.map((b) => b.id)).toEqual(['b1', 'b2']);
    });
  });

  describe('resolveResumeTarget conflict resolution', () => {
    test('skips videos shorter than minDurationSec', () => {
      const res = resolveResumeTarget({
        localRecord: { videoId: 'short1', lastTimeSec: 30, updatedAt: 1000 },
        durationSec: 45,
        minDurationSec: 60,
      });
      expect(res.shouldResume).toBe(false);
      expect(res.source).toBe('none');
    });

    test('Case A: uses YouTube account startSeconds when ahead of local by > 15s (Chrome <-> Firefox sync)', () => {
      const res = resolveResumeTarget({
        localRecord: { videoId: 'v1', lastTimeSec: 3600, furthestTimeSec: 3600, updatedAt: 1000 },
        accountStartSec: 7200,
        durationSec: 36000,
        rewindSec: 3,
      });
      expect(res.shouldResume).toBe(true);
      expect(res.source).toBe('youtube-account');
      expect(res.rawTargetSec).toBe(7200);
      expect(res.targetSec).toBe(7197);
    });

    test('Case B: protects saved local progress against YouTube 0:00 reset bug (accountStartSec = 0)', () => {
      const res = resolveResumeTarget({
        localRecord: { videoId: 'v1', lastTimeSec: 14250, furthestTimeSec: 18000, updatedAt: 2000 },
        accountStartSec: 0,
        durationSec: 36000,
        rewindSec: 3,
      });
      expect(res.shouldResume).toBe(true);
      expect(res.source).toBe('local');
      expect(res.rawTargetSec).toBe(14250);
      expect(res.targetSec).toBe(14247);
      expect(res.alternatives.furthestSec).toBe(18000);
    });

    test('Case C: uses YouTube account startSeconds on a fresh device with no local/sync record', () => {
      const res = resolveResumeTarget({
        accountStartSec: 500,
        durationSec: 7200,
        rewindSec: 3,
      });
      expect(res.shouldResume).toBe(true);
      expect(res.source).toBe('youtube-account');
      expect(res.targetSec).toBe(497);
    });

    test('Case D: returns shouldResume=false when neither local nor YouTube account has >= 5s progress', () => {
      const res = resolveResumeTarget({
        localRecord: { videoId: 'v1', lastTimeSec: 2, updatedAt: 100 },
        accountStartSec: 4,
        durationSec: 3600,
      });
      expect(res.shouldResume).toBe(false);
      expect(res.source).toBe('none');
    });

    test('surfaces lastInteractionSec alternative when user fell asleep >= 30m before current position', () => {
      const res = resolveResumeTarget({
        localRecord: {
          videoId: 'sleep1',
          lastTimeSec: 20000,
          furthestTimeSec: 20000,
          lastInteractionTimeSec: 10000,
          lastInteractionAt: 100,
          updatedAt: 5000,
        },
        durationSec: 36000,
      });
      expect(res.shouldResume).toBe(true);
      expect(res.alternatives.lastInteractionSec).toBe(10000);
    });

    test('clamps rawTargetSec near end of video so player does not fire ended immediately', () => {
      const res = resolveResumeTarget({
        localRecord: { videoId: 'end1', lastTimeSec: 999, updatedAt: 100 },
        durationSec: 1000,
        rewindSec: 5,
      });
      expect(res.shouldResume).toBe(true);
      expect(res.rawTargetSec).toBe(995);
      expect(res.targetSec).toBe(990);
    });
  });

  describe('updateProgress & safety guards', () => {
    test('anti-zero-overwrite lock blocks <5s overwrites when saved position >= 15s unless allowResetToZero=true', async () => {
      await PlaybackResumeStore.updateProgress('vLock', {
        currentTimeSec: 5400,
        durationSec: 36000,
        title: 'Long Audiobook',
        isUserInteraction: true,
      });

      const blocked = await PlaybackResumeStore.updateProgress('vLock', {
        currentTimeSec: 1.5,
        durationSec: 36000,
      });
      expect(blocked.lastTimeSec).toBe(5400);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'ResumeStore',
        expect.stringContaining('ANTI_ZERO_LOCK'),
        expect.objectContaining({ videoId: 'vLock', preservedSec: 5400 })
      );

      const reset = await PlaybackResumeStore.updateProgress('vLock', {
        currentTimeSec: 0,
        durationSec: 36000,
        allowResetToZero: true,
      });
      expect(reset.lastTimeSec).toBe(0);
      expect(reset.furthestTimeSec).toBe(5400); // high-water mark stays safe
    });

    test('tracks lastInteractionTimeSec only on real user interaction and maintains rolling 30m checkpoints capped at 6', async () => {
      let nowMs = 100000;
      const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

      await PlaybackResumeStore.updateProgress('vSleep', {
        currentTimeSec: 120,
        durationSec: 50000,
        isUserInteraction: true,
      });

      // Simulate 7 hours of passive sleep playback without user interaction
      for (let i = 1; i <= 7; i++) {
        nowMs += 3600000;
        await PlaybackResumeStore.updateProgress('vSleep', {
          currentTimeSec: 120 + i * 2000,
          durationSec: 50000,
          isUserInteraction: false,
        });
      }

      const { localRecord } = await PlaybackResumeStore.getVideoRecord('vSleep');
      expect(localRecord.lastTimeSec).toBe(14120);
      expect(localRecord.lastInteractionTimeSec).toBe(120); // stayed at real interaction point!
      expect(localRecord.checkpoints).toHaveLength(MAX_CHECKPOINTS);

      dateSpy.mockRestore();
    });
  });

  describe('LRU pruning, storage.sync quota safety, bookmarks & settings', () => {
    test('pruneRecordsMap keeps most recent MAX_LOCAL_VIDEOS entries', () => {
      const map = {};
      for (let i = 0; i < MAX_LOCAL_VIDEOS + 25; i++) {
        map[`v_${i}`] = { videoId: `v_${i}`, lastTimeSec: 100, updatedAt: i };
      }
      const pruned = pruneRecordsMap(map, MAX_LOCAL_VIDEOS);
      expect(Object.keys(pruned)).toHaveLength(MAX_LOCAL_VIDEOS);
      expect(pruned.v_0).toBeUndefined();
      expect(pruned[`v_${MAX_LOCAL_VIDEOS + 24}`]).toBeDefined();
    });

    test('buildCompactSyncMap caps entries at MAX_SYNC_VIDEOS and stays under byte limit', () => {
      const map = {};
      for (let i = 0; i < 80; i++) {
        map[`vid_${i}`] = {
          videoId: `vid_${i}`,
          title: 'Very Long Audiobook Title That Exceeds Fifty Characters Easily',
          lastTimeSec: 1000 + i,
          furthestTimeSec: 2000 + i,
          lastInteractionTimeSec: 900 + i,
          lastInteractionAt: i,
          durationSec: 50000,
          updatedAt: i * 10,
        };
      }
      const compact = buildCompactSyncMap(map, MAX_SYNC_VIDEOS);
      expect(Object.keys(compact).length).toBeLessThanOrEqual(MAX_SYNC_VIDEOS);
      expect(new TextEncoder().encode(JSON.stringify(compact)).length).toBeLessThanOrEqual(7500);
    });

    test('throttles storage.sync flushes to 60s unless forceSyncFlush=true and preserves other-device sync entries', async () => {
      let nowMs = 1000000;
      const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

      // Seed an entry written by another device in storage.sync
      chrome.storage.sync.store[RESUME_SYNC_KEY] = {
        otherDeviceVid: { t: 999, f: 999, i: 999, ia: 500, d: 5000, u: 500000, n: 'Other' },
      };

      // First throttled write -> sync fires because lastSyncFlushAt === 0
      await PlaybackResumeStore.updateProgress('vSync1', {
        currentTimeSec: 120,
        durationSec: 3600,
      });
      expect(chrome.storage.sync.set).toHaveBeenCalledTimes(1);
      expect(chrome.storage.sync.store[RESUME_SYNC_KEY].otherDeviceVid).toBeDefined();

      // Within 60s without force -> local updates, sync skipped
      nowMs += 5000;
      await PlaybackResumeStore.updateProgress('vSync1', {
        currentTimeSec: 125,
        durationSec: 3600,
      });
      expect(chrome.storage.sync.set).toHaveBeenCalledTimes(1);
      expect(chrome.storage.local.store[RESUME_STORAGE_KEY].vSync1.lastTimeSec).toBe(125);

      // Force flush (e.g., pause/pagehide) -> sync fires immediately
      await PlaybackResumeStore.updateProgress('vSync1', {
        currentTimeSec: 130,
        durationSec: 3600,
        forceSyncFlush: true,
      });
      expect(chrome.storage.sync.set).toHaveBeenCalledTimes(2);

      dateSpy.mockRestore();
    });

    test('supports addBookmark, removeBookmark, listRecentVideos, clearVideoRecord, and clearAllRecords', async () => {
      const rec1 = await PlaybackResumeStore.addBookmark('bmVid', {
        timeSec: 300,
        label: 'Chapter 1',
        title: 'Book',
        durationSec: 3600,
      });
      expect(rec1.bookmarks).toHaveLength(1);
      expect(rec1.bookmarks[0].label).toBe('Chapter 1');

      const bmId = rec1.bookmarks[0].id;
      const rec2 = await PlaybackResumeStore.removeBookmark('bmVid', bmId);
      expect(rec2.bookmarks).toHaveLength(0);

      for (let i = 0; i < MAX_BOOKMARKS_PER_VIDEO + 3; i++) {
        await PlaybackResumeStore.addBookmark('bmCap', { timeSec: 100 + i * 10 });
      }
      const { mergedRecord } = await PlaybackResumeStore.getVideoRecord('bmCap');
      expect(mergedRecord.bookmarks).toHaveLength(MAX_BOOKMARKS_PER_VIDEO);

      const recent = await PlaybackResumeStore.listRecentVideos(10);
      expect(recent.length).toBeGreaterThanOrEqual(2);

      await PlaybackResumeStore.clearVideoRecord('bmVid');
      const cleared = await PlaybackResumeStore.getVideoRecord('bmVid');
      expect(cleared.mergedRecord).toBeNull();

      await PlaybackResumeStore.clearAllRecords();
      expect(await PlaybackResumeStore.listRecentVideos()).toEqual([]);
    });

    test('getSettings and saveSettings merge defaults safely and handle storage failures gracefully', async () => {
      expect(await PlaybackResumeStore.getSettings()).toEqual(DEFAULT_RESUME_SETTINGS);

      const saved = await PlaybackResumeStore.saveSettings({
        enabled: false,
        rewindSec: 5,
        minDurationSec: 180,
      });
      expect(saved).toEqual({
        ...DEFAULT_RESUME_SETTINGS,
        enabled: false,
        rewindSec: 5,
        minDurationSec: 180,
      });
      expect(chrome.storage.local.store[RESUME_SETTINGS_KEY]).toEqual(saved);

      // Graceful degradation when storage.sync throws
      chrome.storage.sync.set.mockRejectedValueOnce(new Error('QUOTA_BYTES'));
      await expect(
        PlaybackResumeStore.updateProgress('vSafe', {
          currentTimeSec: 200,
          durationSec: 3600,
          forceSyncFlush: true,
        })
      ).resolves.toMatchObject({ videoId: 'vSafe', lastTimeSec: 200 });
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('handles empty IDs, read failures, sync-only record clearing, and tight byte limits gracefully', async () => {
      expect(await PlaybackResumeStore.getVideoRecord('')).toEqual({
        localRecord: null,
        syncRecord: null,
        mergedRecord: null,
      });
      expect(await PlaybackResumeStore.updateProgress('', { currentTimeSec: 100 })).toBeNull();
      expect(await PlaybackResumeStore.addBookmark('', { timeSec: 50 })).toBeNull();
      expect(await PlaybackResumeStore.removeBookmark('', 'b1')).toBeNull();

      // Sync-only deletion removes videoId cleanly without throwing
      chrome.storage.sync.store[RESUME_SYNC_KEY] = {
        syncOnly1: { t: 400, f: 400, i: 400, ia: 10, d: 1000, u: 100, n: 'Sync Only' },
      };
      await PlaybackResumeStore.clearVideoRecord('syncOnly1');
      expect(chrome.storage.sync.store[RESUME_SYNC_KEY].syncOnly1).toBeUndefined();

      // Storage read errors degrade safely
      chrome.storage.local.get.mockRejectedValueOnce(new Error('local read err'));
      chrome.storage.sync.get.mockRejectedValueOnce(new Error('sync read err'));
      const fallbackRec = await PlaybackResumeStore.getVideoRecord('anyVid');
      expect(fallbackRec.mergedRecord).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();

      chrome.storage.local.get.mockRejectedValueOnce(new Error('settings err'));
      expect(await PlaybackResumeStore.getSettings()).toEqual(DEFAULT_RESUME_SETTINGS);

      // UTF-8 heavy titles trigger byte-budget eviction cleanly
      const bigMap = {};
      for (let i = 0; i < 40; i++) {
        bigMap[`utf8_${i}`] = {
          videoId: `utf8_${i}`,
          title: '日本語タイトル'.repeat(12),
          lastTimeSec: 100 + i,
          furthestTimeSec: 100 + i,
          lastInteractionTimeSec: 100,
          lastInteractionAt: 10,
          durationSec: 5000,
          updatedAt: 1000 + i,
        };
      }
      const compactUtf8 = buildCompactSyncMap(bigMap, 40);
      expect(new TextEncoder().encode(JSON.stringify(compactUtf8)).length).toBeLessThanOrEqual(
        7500
      );
    });
  });
});
