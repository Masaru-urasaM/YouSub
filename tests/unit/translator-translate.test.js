import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

/**
 * Characterization tests for the exported translate() in src/background/translator.js.
 *
 * Purpose: pin the CURRENT externally-observable behavior of the translation
 * pipeline so a future behavior-preserving refactor of tryKeyForBatch can be
 * gated. These assert DECISIONS and OUTPUTS (success, ordering, recovery), not
 * line execution.
 *
 * Strategy:
 * - Mock the providers.js MODULE (not fetch). The engine talks to the LLM only
 *   through Providers.chat / Providers.chatStream. The default path is
 *   non-streaming (yousub_streaming_mode unset/false) so only chat is scripted.
 * - Mock merge-fixer.js to a clean 1:1 pass-through. The real MergeFixer is a
 *   large, network-capable post-processor (via RoughTranslator); stubbing it
 *   isolates translate()'s own decision logic, which is what gates the refactor.
 * - Use targetLang 'ja' (in NON_LATIN_TARGETS) so the foreign-script and
 *   untranslated-line re-translation cascades are short-circuited — the engine
 *   then makes exactly the Providers.chat calls we script.
 * - APIManager and the chrome storage mock are REAL: keys are seeded into
 *   chrome.storage.local and APIManager.getValidKeys() reads them, exercising
 *   the real key-selection path.
 */

const chat = jest.fn();
const chatStream = jest.fn();

jest.unstable_mockModule('../../src/background/providers.js', () => ({
  Providers: { chat, chatStream },
}));

// Clean 1:1 pass-through: no merges, nothing pending. Keeps translate()'s
// post-parse path deterministic and free of RoughTranslator/network calls.
jest.unstable_mockModule('../../src/background/merge-fixer.js', () => ({
  MergeFixer: {
    fix: jest.fn(async (segments, outputLines) => ({
      lines: [...outputLines],
      pendingIndices: [],
    })),
  },
}));

const { translate } = await import('../../src/background/translator.js');

// ─── Helpers ──────────────────────────────────────────────────────────

const TGT = 'ja'; // non-Latin target → skips sanitize/foreign/untranslated cascades

function seg(text, startMs) {
  return { text, startMs };
}

// Is this Providers.chat call a per-batch translation request? Batch prompts are
// JSON ({"lines":[{n,t},...]}); the context-summary call passes raw transcript.
function isBatchPrompt(userPrompt) {
  try {
    const parsed = JSON.parse(userPrompt);
    return parsed && Array.isArray(parsed.lines);
  } catch {
    return false;
  }
}

// Echo the parsed lines back with transformed text so validCount === length and
// index mapping holds (hadMismatch stays false). Marks each translation with a
// "JA:" prefix so tests can assert the mocked translation was actually applied.
function translateBatchResponse(userPrompt) {
  const { lines } = JSON.parse(userPrompt);
  const out = lines.map((l) => ({ n: l.n, t: 'JA:' + l.t }));
  return { success: true, text: JSON.stringify({ lines: out }) };
}

const summaryResponse = { success: true, text: 'a short context summary' };

// Default content-aware chat: summary call → summary; batch call → echo lines.
function defaultChatImpl() {
  return async (_provider, _model, _apiKey, userPrompt) => {
    if (isBatchPrompt(userPrompt)) return translateBatchResponse(userPrompt);
    return summaryResponse;
  };
}

// Count only batch (translation) calls — the summary call fires first and must
// not be confused with the first batch attempt when scripting failover.
function batchCallCount() {
  return chat.mock.calls.filter((c) => isBatchPrompt(c[3])).length;
}

function seedKeys(keys) {
  chrome.storage.local.store = {
    yousub_api_keys: keys,
    yousub_failover_enabled: true,
    yousub_model_rotation: false,
    yousub_streaming_mode: false,
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────

describe('translate() characterization', () => {
  beforeEach(() => {
    // Fake timers: translate() leaves a force-timeout setTimeout pending after it
    // resolves (Promise.race does not cancel the loser), and the module registers
    // a 60s setInterval at load. Virtual timers keep both from hanging Jest.
    jest.useFakeTimers();
    jest.clearAllMocks();
    chat.mockImplementation(defaultChatImpl());
    // Distinct apiKey per test would be ideal, but each test seeds explicitly and
    // uses 429 (no retry wait) so the 10s keyCooldowns Map never blocks a later
    // test within a single batch attempt. Tests that exercise 429 use fresh keys.
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // ── Behavior 1: Happy path ──────────────────────────────────────────
  test('happy path: resolves with same-length, in-order, translated output', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'k1', model: 'gpt-4o-mini' }]);

    const segments = [seg('Hello', 0), seg('Good morning', 1000), seg('How are you', 2000)];

    const result = await translate(segments, 'en', TGT);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.translated)).toBe(true);
    expect(result.translated).toHaveLength(segments.length);
    // Output items are translated STRINGS (finalResults holds the parsed lines),
    // in input order, with the mocked "JA:" translation applied.
    expect(result.translated).toEqual(['JA:Hello', 'JA:Good morning', 'JA:How are you']);
    // One summary call + one batch call (3 segments fit in a single batch).
    expect(batchCallCount()).toBe(1);
  });

  // ── Behavior 2: Failover (first batch attempt 429, next key recovers) ─
  test('failover: 429 on first key then success on second → recovers', async () => {
    // Two physical keys so a 429 on the first triggers the next-key attempt.
    seedKeys([
      { provider: 'openai', apiKey: 'fk1', model: 'gpt-4o-mini' },
      { provider: 'openai', apiKey: 'fk2', model: 'gpt-4o-mini' },
    ]);

    let batchAttempts = 0;
    chat.mockImplementation(async (_provider, _model, _apiKey, userPrompt) => {
      if (!isBatchPrompt(userPrompt)) return summaryResponse;
      batchAttempts += 1;
      // First batch attempt (first key) → rate limited; next key succeeds.
      if (batchAttempts === 1) {
        return { success: false, message: 'rate limited', statusCode: 429 };
      }
      return translateBatchResponse(userPrompt);
    });

    const segments = [seg('Alpha', 0), seg('Bravo', 1000)];

    const result = await translate(segments, 'en', TGT);

    // Recovery is observed via success + the mocked translation being applied,
    // NOT via hadFallback (a clean second-key success reports hadFallback=false;
    // translateBatchWithFailover returns the winning key's own flag).
    expect(result.success).toBe(true);
    expect(result.translated).toEqual(['JA:Alpha', 'JA:Bravo']);
    // Two batch attempts: the 429 on key #1, then the success on key #2.
    expect(batchCallCount()).toBe(2);
  });

  // ── Behavior 3: Abort via already-aborted external signal ────────────
  test('abort: already-aborted externalSignal resolves quickly without hanging', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'ak1', model: 'gpt-4o-mini' }]);

    const ac = new AbortController();
    ac.abort();

    const segments = [seg('One', 0), seg('Two', 1000), seg('Three', 2000)];

    // No real network (all mocked) and globalAbort is tripped immediately, so the
    // batch loop breaks before any batch call. Must resolve, not hang.
    const result = await translate(segments, 'en', TGT, null, null, ac.signal);

    expect(result).toBeDefined();
    // No batch ever succeeded → reported as failure; nothing translated.
    expect(result.success).toBe(false);
    expect(batchCallCount()).toBe(0);
  });

  // ── Behavior 4: Empty / invalid input guard ──────────────────────────
  test('empty input returns {translated:[], hadFallback:false} with no chat calls', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'k1', model: 'gpt-4o-mini' }]);

    const result = await translate([], 'en', TGT);

    expect(result).toEqual({ translated: [], hadFallback: false });
    expect(chat).not.toHaveBeenCalled();
  });

  test('all-invalid segments (missing text / non-numeric startMs) hit the same guard', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'k1', model: 'gpt-4o-mini' }]);

    const segments = [
      { startMs: 0 }, // missing text
      { text: 'no timestamp' }, // missing/invalid startMs
      { text: '', startMs: 1000 }, // empty text
    ];

    const result = await translate(segments, 'en', TGT);

    // The top-of-translate() filter strips all of these, then the empty guard fires.
    expect(result).toEqual({ translated: [], hadFallback: false });
    expect(chat).not.toHaveBeenCalled();
  });

  // ── Behavior 5: 5xx transient failure retries the SAME key (D6 gate) ──
  test('5xx transient failure retries the same key and recovers', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'rk1', model: 'gpt-4o-mini' }]);

    let batchAttempts = 0;
    chat.mockImplementation(async (_provider, _model, _apiKey, userPrompt) => {
      if (!isBatchPrompt(userPrompt)) return summaryResponse;
      batchAttempts += 1;
      // First attempt: a retryable 5xx (statusCode >= 500). The retry on the SAME
      // key then succeeds — distinct from the 429 test, which switches keys.
      if (batchAttempts === 1) {
        return { success: false, statusCode: 503, message: 'Service Unavailable' };
      }
      return translateBatchResponse(userPrompt);
    });

    const segments = [seg('Hello', 0), seg('World', 1000)];

    // tryKeyForBatch's retry loop does `await wait(RETRY_DELAYS_MS[0])` (1000ms)
    // between attempt 0 and attempt 1, so the pending promise must be driven by the
    // fake clock before it can resolve.
    const p = translate(segments, 'en', TGT);
    await jest.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(result.success).toBe(true);
    expect(result.translated).toEqual(['JA:Hello', 'JA:World']);
    // Two calls to the SAME key (503 then the retry success) — not a failover.
    expect(batchCallCount()).toBe(2);
  });

  // ── Behavior 6: non-JSON timestamped text → text parser (D6 gate) ─────
  test('non-JSON timestamped text falls through to the text parser', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'tk1', model: 'gpt-4o-mini' }]);

    chat.mockImplementation(async (_provider, _model, _apiKey, userPrompt) => {
      if (!isBatchPrompt(userPrompt)) return summaryResponse;
      // NOT JSON → parseJsonResponse returns null → the engine falls through to the
      // timestamp text parser, which keys translations off the [HH:MM:SS] tags that
      // formatTimestamp(startMs) emits (0 → [00:00:00], 1000 → [00:00:01]).
      return { success: true, text: '[00:00:00] TXT:Hello\n[00:00:01] TXT:World' };
    });

    const segments = [seg('Hello', 0), seg('World', 1000)];

    const result = await translate(segments, 'en', TGT);

    expect(result.success).toBe(true);
    // Both timestamped lines matched and were applied in input order.
    expect(result.translated).toEqual(['TXT:Hello', 'TXT:World']);
    expect(batchCallCount()).toBe(1);
  });

  // ── Behavior 7: 413 (payload too large) → recursive split (D6 gate) ───
  test('413 on the full batch recursively splits and still translates all lines', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'pk1', model: 'gpt-4o-mini' }]);

    chat.mockImplementation(async (_provider, _model, _apiKey, userPrompt) => {
      if (!isBatchPrompt(userPrompt)) return summaryResponse;
      const { lines } = JSON.parse(userPrompt);
      // Reject any batch with more than 2 lines as 413; accept smaller batches. The
      // failover layer's "all keys returned 413" safety net then recursively splits
      // (segments.length > 2 && depth < MAX_RECURSION_DEPTH).
      if (lines.length > 2) {
        return { success: false, statusCode: 413, message: 'Payload Too Large' };
      }
      return translateBatchResponse(userPrompt);
    });

    const segments = [seg('A', 0), seg('B', 1000), seg('C', 2000), seg('D', 3000)];

    const result = await translate(segments, 'en', TGT);

    expect(result.success).toBe(true);
    expect(result.translated).toEqual(['JA:A', 'JA:B', 'JA:C', 'JA:D']);
    // The 4-line batch 413s, then it is split into halves that each succeed →
    // strictly more than one batch attempt.
    expect(batchCallCount()).toBeGreaterThan(1);
  });

  // ── Behavior 8: low-quality output accepted on the last/only key ──────
  test('low-quality (zero valid lines) JSON is accepted on the last/only key', async () => {
    seedKeys([{ provider: 'openai', apiKey: 'qk1', model: 'gpt-4o-mini' }]);

    chat.mockImplementation(async (_provider, _model, _apiKey, userPrompt) => {
      if (!isBatchPrompt(userPrompt)) return summaryResponse;
      // Valid JSON shape but an EMPTY lines array → validCount 0 (below threshold).
      // Because this is the only key (isLastKey), the engine accepts it rather than
      // failing the batch — pinning the accept-on-last-key escape hatch. With no
      // line replaced, the original source text is preserved.
      return { success: true, text: JSON.stringify({ lines: [] }) };
    });

    const segments = [seg('Hello', 0), seg('World', 1000)];

    const result = await translate(segments, 'en', TGT);

    expect(result.success).toBe(true);
    expect(result.translated).toEqual(['Hello', 'World']);
    expect(batchCallCount()).toBe(1);
  });
});
