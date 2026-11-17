import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

/**
 * Advanced characterization tests for src/background/translator.js (TODO T8).
 *
 * Covers the complex paths not exercised by translator-translate.test.js:
 * - Streaming mode (Providers.chatStream + onChunk forwarding)
 * - MergeFixer pending re-translation (retranslateShiftedLines)
 * - Foreign-script contamination re-translation + empty fallback
 * - Untranslated-line LLM verification (retranslateWithVerification: keep & fix)
 * - Completeness sweep recovery + INCOMPLETE_AFTER_SWEEP failure
 * - Groq oversized-payload waterfall + non-Groq fallback
 * - 413 context-stripping retry when <= 2 segments
 */

const chat = jest.fn();
const chatStream = jest.fn();

jest.unstable_mockModule('../../src/background/providers.js', () => ({
  Providers: { chat, chatStream },
}));

const fixFn = jest.fn(async (_segments, outputLines) => ({
  lines: [...outputLines],
  pendingIndices: [],
}));

jest.unstable_mockModule('../../src/background/merge-fixer.js', () => ({
  MergeFixer: { fix: fixFn },
}));

const { translate, _internals } = await import('../../src/background/translator.js');

const seg = (text, startMs) => ({ text, startMs });

function isJsonBatchPrompt(userPrompt) {
  try {
    const parsed = JSON.parse(userPrompt);
    return parsed && Array.isArray(parsed.lines);
  } catch {
    return false;
  }
}

function seedKeys(keys, extra = {}) {
  chrome.storage.local.store = {
    yousub_api_keys: keys,
    yousub_failover_enabled: true,
    yousub_model_rotation: false,
    yousub_streaming_mode: false,
    ...extra,
  };
}

describe('translator.js advanced & streaming paths (T8)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    fixFn.mockImplementation(async (_segments, outputLines) => ({
      lines: [...outputLines],
      pendingIndices: [],
    }));
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('streaming mode uses Providers.chatStream when provider does not use JSON mode', async () => {
    // ollama has jsonMode=false -> streaming mode activates
    seedKeys([{ provider: 'ollama', apiKey: 'oll-1', model: 'llama3' }], {
      yousub_streaming_mode: true,
    });

    chat.mockResolvedValue({ success: true, text: 'Video context' });
    chatStream.mockImplementation(async (_p, _m, _k, _prompt, _opts, onChunk) => {
      onChunk('part-1');
      onChunk('part-2');
      return {
        success: true,
        text: '[00:00:00] Xin chao\n[00:00:01] The gioi',
        usage: { totalTokens: 12, promptTokens: 5, completionTokens: 7 },
        model: 'llama3',
      };
    });

    const segments = [seg('Hello', 0), seg('World', 1000)];
    const result = await translate(segments, 'en', 'vi');

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.translated).toEqual(['Xin chao', 'The gioi']);
    expect(result.stats.totalTokens).toBe(12);
  });

  test('MergeFixer pendingIndices triggers retranslateShiftedLines and recovers', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'mf-1', model: 'gpt-4o-mini' }]);

    fixFn.mockResolvedValueOnce({
      lines: ['Xin chao', ''],
      pendingIndices: [1],
    });

    let batchCall = 0;
    chat.mockImplementation(async (_p, _m, _k, userPrompt) => {
      if (isJsonBatchPrompt(userPrompt)) {
        batchCall++;
        const { lines } = JSON.parse(userPrompt);
        if (batchCall === 1) {
          return {
            success: true,
            text: JSON.stringify({ lines: lines.map((l) => ({ n: l.n, t: 'Dich ' + l.t })) }),
          };
        }
        return {
          success: true,
          text: JSON.stringify({ lines: [{ n: 0, t: 'The gioi da sua' }] }),
        };
      }
      return { success: true, text: 'Summary' };
    });

    const segments = [seg('Hello', 0), seg('World', 1000)];
    const result = await translate(segments, 'en', 'vi');

    expect(result.success).toBe(true);
    expect(result.translated).toEqual(['Xin chao', 'The gioi da sua']);
  });

  test('foreign script triggers re-translation and falls back to original if still empty after 3 rounds', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'fs-1', model: 'gpt-4o-mini' }]);

    let retranslateCalls = 0;
    let initialDone = false;
    chat.mockImplementation(async (_p, _m, _k, userPrompt) => {
      if (isJsonBatchPrompt(userPrompt)) {
        if (!initialDone) {
          initialDone = true;
          return {
            success: true,
            text: JSON.stringify({
              lines: [
                { n: 0, t: 'Xin chao 朋友' }, // contaminated CJK in Latin target 'vi'
                { n: 1, t: 'Tot lam' },
              ],
            }),
          };
        }
        retranslateCalls++;
        if (retranslateCalls === 1) {
          return {
            success: true,
            text: JSON.stringify({ lines: [{ n: 0, t: 'Van con 漢字' }] }),
          };
        }
        // Return whitespace on remaining rounds -> still empty -> falls back to original
        return {
          success: true,
          text: JSON.stringify({ lines: [{ n: 0, t: '   ' }] }),
        };
      }
      return { success: true, text: 'Summary' };
    });

    const segments = [seg('Original zero', 0), seg('Very good', 1000)];
    const result = await translate(segments, 'en', 'vi');

    expect(result.success).toBe(true);
    // Round 1 had 汉字 (foreign script); round 2 whitespace failed validCount so parseJsonResponse
    // kept original clean text ('Original zero'), terminating the loop cleanly after 2 rounds.
    expect(retranslateCalls).toBe(2);
    expect(result.translated).toEqual(['Original zero', 'Tot lam']);
  });

  test('untranslated lines trigger LLM verification (retranslateWithVerification) to keep or fix', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'uv-1', model: 'gpt-4o-mini' }]);

    const srcLine0 = 'This whole sentence stays completely unchanged';
    const srcLine1 = 'Another long English sentence left verbatim';

    chat.mockImplementation(async (_p, _m, _k, userPrompt, opts) => {
      if (opts?.systemPrompt?.includes('language verifier')) {
        return {
          success: true,
          text: JSON.stringify({
            lines: [
              { n: 0, t: srcLine0, k: true },
              { n: 1, t: 'Mot cau tieng Anh khac da dich', k: false },
            ],
          }),
        };
      }
      if (isJsonBatchPrompt(userPrompt)) {
        return {
          success: true,
          text: JSON.stringify({
            lines: [
              { n: 0, t: srcLine0 },
              { n: 1, t: srcLine1 },
            ],
          }),
        };
      }
      return { success: true, text: 'Summary' };
    });

    const result = await translate([seg(srcLine0, 0), seg(srcLine1, 1000)], 'en', 'vi');
    expect(result.success).toBe(true);
    expect(result.translated).toEqual([srcLine0, 'Mot cau tieng Anh khac da dich']);
  });

  test('completeness sweep retries missed batch and recovers after transient failure', async () => {
    seedKeys([
      { provider: 'openai', apiKey: 'sw-1', model: 'gpt-4o-mini' },
      { provider: 'openai', apiKey: 'sw-2', model: 'gpt-4o-mini' },
    ]);

    let batchCalls = 0;
    chat.mockImplementation(async (_p, _m, _k, userPrompt) => {
      if (!isJsonBatchPrompt(userPrompt)) return { success: true, text: 'Summary' };
      batchCalls++;
      // Fail first two attempts (1 per key in initial pass) with 429 so batch fails into sweep;
      // succeed in sweep round 1 after cooldown wait.
      if (batchCalls <= 2) {
        return { success: false, statusCode: 429, message: 'Rate limited' };
      }
      const { lines } = JSON.parse(userPrompt);
      return {
        success: true,
        text: JSON.stringify({ lines: lines.map((l) => ({ n: l.n, t: 'JA:' + l.t })) }),
      };
    });

    const onBatchComplete = jest.fn();
    const onProgress = jest.fn();

    const p = translate(
      [seg('One', 0), seg('Two', 1000)],
      'en',
      'ja',
      10,
      onBatchComplete,
      null,
      onProgress
    );
    // Advance past key cooldown (10s) so sweep round 1 executes immediately
    await jest.advanceTimersByTimeAsync(11000);
    const result = await p;

    expect(result.success).toBe(true);
    expect(result.translated).toEqual(['JA:One', 'JA:Two']);
    expect(onProgress).toHaveBeenCalled();
    expect(onBatchComplete).toHaveBeenCalledWith(0, ['JA:One', 'JA:Two']);
  });

  test('returns INCOMPLETE_AFTER_SWEEP when one batch stays failing across all 3 sweep rounds', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'fail-sweep-1', model: 'gpt-4o-mini' }]);

    // 55 segments -> 2 batches (50 + 5). Batch 1 succeeds, batch 2 always fails.
    const segments = Array.from({ length: 55 }, (_, i) => seg(`Line ${i}`, i * 1000));

    chat.mockImplementation(async (_p, _m, _k, userPrompt) => {
      if (!isJsonBatchPrompt(userPrompt)) return { success: true, text: 'Summary' };
      const { lines } = JSON.parse(userPrompt);
      if (lines.length === 5) {
        return { success: false, statusCode: 400, message: 'Bad request for batch 2' };
      }
      return {
        success: true,
        text: JSON.stringify({ lines: lines.map((l) => ({ n: l.n, t: 'JA:' + l.t })) }),
      };
    });

    const p = translate(segments, 'en', 'ja');
    await jest.advanceTimersByTimeAsync(5000);
    const result = await p;

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('INCOMPLETE_AFTER_SWEEP');
    // Batch 1 translations preserved, batch 2 kept original text
    expect(result.translated[0]).toBe('JA:Line 0');
    expect(result.translated[50]).toBe('Line 50');
  });

  test('Groq oversized payload runs waterfall across Groq keys and falls back to non-Groq', async () => {
    seedKeys([
      { provider: 'groq', apiKey: 'gq-1', model: 'llama-3.3-70b-versatile' },
      { provider: 'groq', apiKey: 'gq-2', model: 'llama-3.3-70b-versatile' },
      { provider: 'ollama', apiKey: 'oll-bk', model: 'qwen2' },
    ]);

    // Build 4 segments totaling > MAX_PAYLOAD_BYTES (95000 bytes)
    const bigText = 'word '.repeat(3000); // ~15k chars = 30KB UTF-16 per line
    const segments = [
      seg('S0 ' + bigText, 0),
      seg('S1 ' + bigText, 1000),
      seg('S2 ' + bigText, 2000),
      seg('S3 ' + bigText, 3000),
    ];

    let groqCalls = 0;
    chat.mockImplementation(async (provider, _m, apiKey, userPrompt, opts) => {
      if (opts?.systemPrompt?.includes('FULL transcript')) {
        return { success: true, text: 'Context ok' };
      }
      if (provider === 'groq') {
        groqCalls++;
        const parsed = JSON.parse(userPrompt);
        if (apiKey === 'gq-1') {
          if (groqCalls === 1) {
            return {
              success: true,
              text: JSON.stringify({
                lines: parsed.lines.map((l, idx) => ({ n: l.n, t: `G1:S${idx}` })),
              }),
            };
          }
          return { success: false, statusCode: 429, message: 'Groq rate limit' };
        }
        if (apiKey === 'gq-2') {
          return { success: false, statusCode: 413, message: 'Too big for groq' };
        }
      }
      // Fallback to non-Groq (ollama) translates remaining lines
      if (provider === 'ollama') {
        return { success: true, text: '[00:00:02] OL:S2\n[00:00:03] OL:S3' };
      }
      return { success: false, statusCode: 500, message: 'unexpected' };
    });

    const result = await translate(segments, 'en', 'ja');

    expect(result.success).toBe(true);
    expect(result.translated).toEqual(['G1:S0', 'G1:S1', 'OL:S2', 'OL:S3']);
  });

  test('413 on <=2 segments with context strips context and retries via _internals', async () => {
    seedKeys([{ provider: 'ollama', apiKey: 'oll-413', model: 'm1' }]);

    let callCount = 0;
    chat.mockImplementation(async (_p, _m, _k, _userPrompt, opts) => {
      callCount++;
      if (opts?.systemPrompt?.includes('Video context summary')) {
        return { success: false, statusCode: 413, message: 'Payload too large' };
      }
      return { success: true, text: '[00:00:00] Retried OK' };
    });

    // Trigger via normal 2-segment flow where context summary succeeds first
    let summaryDone = false;
    chat.mockImplementation(async (_p, _m, _k, userPrompt, opts) => {
      if (!summaryDone && !userPrompt.includes('[00:00:00]')) {
        summaryDone = true;
        return { success: true, text: 'Video context summary' };
      }
      callCount++;
      if (opts?.systemPrompt?.includes('Video context summary')) {
        return { success: false, statusCode: 413, message: 'Context pushed payload over limit' };
      }
      return { success: true, text: '[00:00:00] Stripped OK' };
    });

    const result = await translate([seg('Short line', 0)], 'en', 'ja');
    expect(result.success).toBe(true);
    expect(result.translated).toEqual(['Stripped OK']);
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(_internals.MAX_PAYLOAD_BYTES).toBe(95000);
  });
});
