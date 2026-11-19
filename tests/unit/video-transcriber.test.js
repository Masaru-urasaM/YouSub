import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockAPIManager = {
  getValidKeys: jest.fn(),
};
const mockProviders = {
  chat: jest.fn(),
};
const mockHealthManager = {
  report: jest.fn(),
};
const mockCache = {
  mergeGeneratedBatch: jest.fn(),
};

jest.unstable_mockModule('../../src/background/api-manager.js', () => ({
  APIManager: mockAPIManager,
}));
jest.unstable_mockModule('../../src/background/providers.js', () => ({
  Providers: mockProviders,
}));
jest.unstable_mockModule('../../src/background/health.js', () => ({
  HealthManager: mockHealthManager,
}));
jest.unstable_mockModule('../../src/background/cache.js', () => ({
  Cache: mockCache,
}));

const {
  DEFAULT_WINDOW_SEC,
  DEFAULT_FPS,
  MEDIA_RESOLUTION_LOW,
  normalizeYouTubeVideoUrl,
  computeBatchRange,
  getTotalBatches,
  resolveGeminiVideoModel,
  buildGeminiVideoPrompt,
  buildGeminiVideoPayloadOptions,
  parseTimestampToMs,
  sanitizeGeminiVideoEntries,
  classifyGeminiVideoError,
  getActiveGeminiKeys,
  hasActiveGeminiKey,
  transcribeVideoWindow,
} = await import('../../src/background/video-transcriber.js');

describe('video-transcriber.js (Phase 78)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHealthManager.report.mockResolvedValue();
    mockCache.mergeGeneratedBatch.mockResolvedValue();
  });

  describe('URL normalization & window math', () => {
    test('normalizeYouTubeVideoUrl accepts watch & Shorts IDs and rejects invalid values', () => {
      expect(normalizeYouTubeVideoUrl('dQw4w9WgXcQ')).toBe(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      );
      expect(normalizeYouTubeVideoUrl('  ALWp-RMMP5k  ')).toBe(
        'https://www.youtube.com/watch?v=ALWp-RMMP5k'
      );
      expect(normalizeYouTubeVideoUrl('')).toBeNull();
      expect(normalizeYouTubeVideoUrl(null)).toBeNull();
      expect(normalizeYouTubeVideoUrl('bad id with spaces')).toBeNull();
      expect(normalizeYouTubeVideoUrl('abc')).toBeNull();
    });

    test('computeBatchRange & getTotalBatches clamp to duration and reject invalid bounds', () => {
      expect(computeBatchRange(0, 600, 240)).toEqual({
        batchIndex: 0,
        startSec: 0,
        endSec: 240,
        startMs: 0,
        endMs: 240000,
      });
      expect(computeBatchRange(2, 600, 240)).toEqual({
        batchIndex: 2,
        startSec: 480,
        endSec: 600,
        startMs: 480000,
        endMs: 600000,
      });
      expect(computeBatchRange(3, 600, 240)).toBeNull();
      expect(computeBatchRange(-1, 600, 240)).toBeNull();
      expect(computeBatchRange(0, NaN, 240)).toEqual({
        batchIndex: 0,
        startSec: 0,
        endSec: 240,
        startMs: 0,
        endMs: 240000,
      });

      expect(getTotalBatches(600, 240)).toBe(3);
      expect(getTotalBatches(480, 240)).toBe(2);
      expect(getTotalBatches(0, 240)).toBeNull();
      expect(getTotalBatches(NaN, 240)).toBeNull();
    });

    test('resolveGeminiVideoModel upgrades auto and legacy 1.5 models', () => {
      expect(resolveGeminiVideoModel('auto')).toBe('gemini-2.5-flash');
      expect(resolveGeminiVideoModel('gemini-1.5-flash')).toBe('gemini-2.5-flash');
      expect(resolveGeminiVideoModel('gemini-1.5-pro')).toBe('gemini-2.5-flash');
      expect(resolveGeminiVideoModel('gemini-2.0-flash')).toBe('gemini-2.0-flash');
      expect(resolveGeminiVideoModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    });
  });

  describe('payload construction & timestamp parsing', () => {
    test('buildGeminiVideoPayloadOptions constructs v1beta REST multimodal options', () => {
      const prompt = buildGeminiVideoPrompt('vi', 240, 480);
      expect(prompt).toContain('04:00 to 08:00');
      expect(prompt).toContain('Vietnamese');

      const built25 = buildGeminiVideoPayloadOptions({
        videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        startSec: 240,
        endSec: 480,
        fps: DEFAULT_FPS,
        targetLang: 'vi',
        model: 'gemini-2.5-flash',
      });
      expect(built25.options.mediaResolution).toBe(MEDIA_RESOLUTION_LOW);
      expect(built25.options.thinkingBudget).toBe(0);
      expect(built25.options.parts[0]).toEqual({
        fileData: { fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        videoMetadata: { startOffset: '240s', endOffset: '480s', fps: DEFAULT_FPS },
      });

      const built20 = buildGeminiVideoPayloadOptions({
        videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        startSec: 0,
        endSec: 120,
        targetLang: 'ja',
        model: 'gemini-2.0-flash',
      });
      expect(built20.options.thinkingBudget).toBeUndefined();
      expect(built20.prompt).toContain('Japanese');
    });

    test('parseTimestampToMs parses numbers, seconds strings, MM:SS, and HH:MM:SS', () => {
      expect(parseTimestampToMs(12.5)).toBe(12500);
      expect(parseTimestampToMs('245.25')).toBe(245250);
      expect(parseTimestampToMs('[04:05]')).toBe(245000);
      expect(parseTimestampToMs('01:02:03.5')).toBe(3723500);
      expect(parseTimestampToMs('bad')).toBeNaN();
      expect(parseTimestampToMs('00:65')).toBeNaN();
      expect(parseTimestampToMs(-1)).toBeNaN();
    });
  });

  describe('sanitizeGeminiVideoEntries', () => {
    test('handles absolute timestamps, sorts, clamps, and de-overlaps entries', () => {
      const raw =
        '```json\n' +
        JSON.stringify({
          lines: [
            { startSec: 255, endSec: 262, original: 'Second', translated: 'Thu hai' },
            { startSec: 240, endSec: 257, original: 'First', translated: 'Thu nhat' },
            { startSec: 270, endSec: 275, original: '', translated: '' },
          ],
        }) +
        '\n```';

      const entries = sanitizeGeminiVideoEntries(raw, 240000, 480000);
      expect(entries).toEqual([
        {
          startMs: 240000,
          endMs: 255000,
          original: 'First',
          text: 'Thu nhat',
          isAiGenerated: true,
        },
        {
          startMs: 255000,
          endMs: 262000,
          original: 'Second',
          text: 'Thu hai',
          isAiGenerated: true,
        },
      ]);
    });

    test('automatically shifts chunk-relative timestamps by batchStartMs for batch > 0', () => {
      const raw = JSON.stringify({
        lines: [
          { startSec: 2.5, endSec: 6.0, original: 'Hello', translated: 'Xin chao' },
          { startSec: 10.0, endSec: 14.0, original: 'World', translated: 'The gioi' },
        ],
      });

      const entries = sanitizeGeminiVideoEntries(raw, 240000, 480000);
      expect(entries[0].startMs).toBe(242500);
      expect(entries[0].endMs).toBe(246000);
      expect(entries[1].startMs).toBe(250000);
      expect(entries[1].endMs).toBe(254000);
    });

    test('shifts batch #1 chunk-relative cues even when trailing relative cue exceeds 240s boundary slightly', () => {
      const raw = JSON.stringify({
        lines: [
          { startSec: 5.0, endSec: 9.0, original: 'Early line', translated: 'Dong dau' },
          { startSec: 241.0, endSec: 244.0, original: 'Tail line', translated: 'Dong cuoi' },
        ],
      });

      const entries = sanitizeGeminiVideoEntries(raw, 240000, 480000);
      expect(entries[0]).toMatchObject({ startMs: 245000, endMs: 249000, text: 'Dong dau' });
    });

    test('returns empty array for silent/music segments or invalid JSON', () => {
      expect(sanitizeGeminiVideoEntries('{"lines":[]}', 0, 240000)).toEqual([]);
      expect(sanitizeGeminiVideoEntries('not json at all', 0, 240000)).toEqual([]);
    });
  });

  describe('classifyGeminiVideoError', () => {
    test('classifies rate limit, invalid key, private/unavailable video, model 404, and 5xx', () => {
      expect(classifyGeminiVideoError(429, 'RESOURCE_EXHAUSTED')).toEqual({
        failureReason: 'GEMINI_RATE_LIMITED',
        retryable: true,
      });
      expect(classifyGeminiVideoError(400, 'API key not valid')).toEqual({
        failureReason: 'INVALID_API_KEY',
        retryable: true,
      });
      expect(classifyGeminiVideoError(403, 'Private YouTube video is not accessible')).toEqual({
        failureReason: 'VIDEO_UNAVAILABLE_OR_PRIVATE',
        retryable: false,
      });
      expect(classifyGeminiVideoError(404, 'Model not found')).toEqual({
        failureReason: 'GEMINI_ERROR',
        retryable: true,
      });
      expect(classifyGeminiVideoError(503, 'Server error')).toEqual({
        failureReason: 'GEMINI_TRANSIENT_ERROR',
        retryable: true,
      });
    });
  });

  describe('transcribeVideoWindow & key discovery', () => {
    test('filters active keys to google provider (including auto AIza keys)', async () => {
      mockAPIManager.getValidKeys.mockResolvedValue([
        { provider: 'groq', model: 'auto', apiKey: 'gsk_123' },
        { provider: 'auto', model: 'auto', apiKey: 'AIzaAutoKey' },
      ]);

      expect(await hasActiveGeminiKey()).toBe(true);
      const keys = await getActiveGeminiKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0].provider).toBe('google');
    });

    test('returns NO_GEMINI_KEY when only non-Gemini keys exist', async () => {
      mockAPIManager.getValidKeys.mockResolvedValue([
        { provider: 'groq', model: 'auto', apiKey: 'gsk_123' },
      ]);

      const res = await transcribeVideoWindow({
        videoId: 'dQw4w9WgXcQ',
        batchIndex: 0,
        durationSec: 300,
        targetLang: 'vi',
      });
      expect(res.success).toBe(false);
      expect(res.failureReason).toBe('NO_GEMINI_KEY');
      expect(mockProviders.chat).not.toHaveBeenCalled();
    });

    test('transcribes window, reports health, and persists incrementally in Cache', async () => {
      mockAPIManager.getValidKeys.mockResolvedValue([
        { provider: 'google', model: 'auto', apiKey: 'AIzaKeyOne' },
      ]);
      mockProviders.chat.mockResolvedValue({
        success: true,
        text: JSON.stringify({
          lines: [{ startSec: 1.5, endSec: 4.5, original: 'Hi', translated: 'Chao' }],
        }),
      });

      const res = await transcribeVideoWindow({
        videoId: 'dQw4w9WgXcQ',
        batchIndex: 0,
        durationSec: 600,
        targetLang: 'vi',
      });

      expect(res.success).toBe(true);
      expect(res.model).toBe('gemini-2.5-flash');
      expect(res.entries).toEqual([
        { startMs: 1500, endMs: 4500, original: 'Hi', text: 'Chao', isAiGenerated: true },
      ]);
      expect(mockHealthManager.report).toHaveBeenCalledWith(
        'google',
        'AIzaKeyOne',
        true,
        expect.any(Number)
      );
      expect(mockCache.mergeGeneratedBatch).toHaveBeenCalledWith('dQw4w9WgXcQ', 'vi', {
        windowSec: DEFAULT_WINDOW_SEC,
        durationSec: 600,
        batchIndex: 0,
        entries: res.entries,
      });
    });

    test('rotates on 429 and aborts immediately without retry on private video', async () => {
      mockAPIManager.getValidKeys.mockResolvedValue([
        { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'AIzaKey1' },
        { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'AIzaKey2' },
      ]);
      mockProviders.chat
        .mockResolvedValueOnce({ success: false, status: 429, message: 'RESOURCE_EXHAUSTED' })
        .mockResolvedValueOnce({ success: false, status: 429, message: 'RESOURCE_EXHAUSTED' })
        .mockResolvedValueOnce({
          success: true,
          text: JSON.stringify({
            lines: [{ startSec: 245, endSec: 250, original: 'Next', translated: 'Tiep' }],
          }),
        });

      const okRes = await transcribeVideoWindow({
        videoId: 'dQw4w9WgXcQ',
        batchIndex: 1,
        durationSec: 600,
        targetLang: 'vi',
      });
      expect(okRes.success).toBe(true);
      expect(mockProviders.chat).toHaveBeenCalledTimes(3);

      // Private video stops immediately on first error without trying fallback models/keys
      jest.clearAllMocks();
      mockProviders.chat.mockResolvedValueOnce({
        success: false,
        status: 403,
        message: 'Private YouTube video cannot be accessed',
      });
      const privRes = await transcribeVideoWindow({
        videoId: 'dQw4w9WgXcQ',
        batchIndex: 0,
        durationSec: 600,
        targetLang: 'vi',
      });
      expect(privRes.success).toBe(false);
      expect(privRes.failureReason).toBe('VIDEO_UNAVAILABLE_OR_PRIVATE');
      expect(mockProviders.chat).toHaveBeenCalledTimes(1);
    });

    test('returns ABORTED cleanly when signal is aborted before or during request', async () => {
      const controller = new AbortController();
      controller.abort();

      const preAborted = await transcribeVideoWindow({
        videoId: 'dQw4w9WgXcQ',
        batchIndex: 0,
        durationSec: 300,
        signal: controller.signal,
      });
      expect(preAborted.failureReason).toBe('ABORTED');

      const liveController = new AbortController();
      mockAPIManager.getValidKeys.mockResolvedValue([
        { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'AIzaKey1' },
      ]);
      mockProviders.chat.mockImplementation(async () => {
        liveController.abort();
        return { success: false, message: 'Request timed out (90s)' };
      });
      const midAborted = await transcribeVideoWindow({
        videoId: 'dQw4w9WgXcQ',
        batchIndex: 0,
        durationSec: 300,
        signal: liveController.signal,
      });
      expect(midAborted.failureReason).toBe('ABORTED');
      expect(mockHealthManager.report).not.toHaveBeenCalled();
    });
  });
});
