import { describe, test, expect } from '@jest/globals';
import { _internals } from '../../src/background/translator.js';

const {
  formatTimestamp,
  normalizeTs,
  buildSystemPrompt,
  buildJsonSystemPrompt,
  buildJsonUserPrompt,
  buildVerificationPrompt,
  getProviderJsonConfig,
  parseJsonResponse,
  cleanResponse,
  partitionKeysByProvider,
  splitForGroqPayload,
  groupByPhysicalKey,
  sortGroupsByHealth,
  selectGroupForBatch,
  MAX_PAYLOAD_BYTES,
} = _internals;

// ─── formatTimestamp ──────────────────────────────────────────────────

describe('formatTimestamp', () => {
  test('formats 0 ms as [00:00:00]', () => {
    expect(formatTimestamp(0)).toBe('[00:00:00]');
  });

  test('formats 1 hour 1 minute 1 second (3661000 ms) zero-padded', () => {
    expect(formatTimestamp(3661000)).toBe('[01:01:01]');
  });

  test('truncates sub-second remainder via floor', () => {
    expect(formatTimestamp(1999)).toBe('[00:00:01]'); // 1.999s -> 1s
  });

  test('formats minutes and seconds without hours', () => {
    expect(formatTimestamp(125000)).toBe('[00:02:05]'); // 2m05s
  });

  test('zero-pads each field to two digits', () => {
    expect(formatTimestamp(9000)).toBe('[00:00:09]');
    expect(formatTimestamp(540000)).toBe('[00:09:00]'); // 9 minutes
  });

  test('handles multi-hour timestamps', () => {
    // 10h 0m 0s = 36000000 ms
    expect(formatTimestamp(36000000)).toBe('[10:00:00]');
  });
});

// ─── normalizeTs ──────────────────────────────────────────────────────

describe('normalizeTs', () => {
  test('strips brackets and leading zeros via parseInt (numbers only)', () => {
    // '[00:01:05]' -> '00:01:05' -> ['00','01','05'] -> parseInt each -> '0:1:5'
    expect(normalizeTs('[00:01:05]')).toBe('0:1:5');
  });

  test('normalizes mixed-padding forms to the same canonical key', () => {
    expect(normalizeTs('[0:01:05]')).toBe('0:1:5');
    expect(normalizeTs('[00:1:5]')).toBe('0:1:5');
    expect(normalizeTs('00:01:05')).toBe('0:1:5'); // no brackets also works
  });

  test('canonicalizes a non-zero hour field', () => {
    expect(normalizeTs('[01:01:01]')).toBe('1:1:1');
  });

  test('returns the input unchanged when not 3 parts', () => {
    expect(normalizeTs('12:30')).toBe('12:30'); // 2 parts
    expect(normalizeTs('[1:2:3:4]')).toBe('[1:2:3:4]'); // 4 parts, brackets kept
  });

  test('returns empty string for falsy input', () => {
    expect(normalizeTs('')).toBe('');
    expect(normalizeTs(null)).toBe('');
    expect(normalizeTs(undefined)).toBe('');
  });

  test('round-trips with formatTimestamp for the same instant', () => {
    expect(normalizeTs(formatTimestamp(3661000))).toBe('1:1:1');
  });
});

// ─── buildSystemPrompt ────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  test('embeds context, src, tgt, and the exact count', () => {
    const prompt = buildSystemPrompt('A cooking show', 'en', 'vi', 42);
    expect(prompt).toContain('A cooking show');
    expect(prompt).toContain('from en to vi');
    expect(prompt).toContain('Return exactly 42 lines');
  });

  test('always preserves the UNFILTERED & FAITHFUL rule', () => {
    const prompt = buildSystemPrompt('ctx', 'auto', 'ja', 1);
    expect(prompt).toContain('UNFILTERED & FAITHFUL');
  });
});

// ─── buildJsonSystemPrompt ────────────────────────────────────────────

describe('buildJsonSystemPrompt', () => {
  test('embeds context, src, tgt, and the exact count', () => {
    const prompt = buildJsonSystemPrompt('A travel vlog', 'fr', 'en', 7);
    expect(prompt).toContain('A travel vlog');
    expect(prompt).toContain('from fr to en');
    expect(prompt).toContain('7 subtitle lines');
    expect(prompt).toContain('EXACTLY 7 objects');
  });

  test('describes the JSON input/output shape', () => {
    const prompt = buildJsonSystemPrompt('ctx', 'en', 'vi', 3);
    expect(prompt).toContain('"lines"');
    expect(prompt).toContain('"n"');
    expect(prompt).toContain('"t"');
  });
});

// ─── buildJsonUserPrompt ──────────────────────────────────────────────

describe('buildJsonUserPrompt', () => {
  test('returns JSON.stringify({lines:[{n,t}...]}) with correct shape and indices', () => {
    const segments = [{ text: 'Hello' }, { text: 'World' }, { text: 'Bye' }];
    const json = buildJsonUserPrompt(segments);
    const parsed = JSON.parse(json);

    expect(Array.isArray(parsed.lines)).toBe(true);
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.lines[0]).toEqual({ n: 0, t: 'Hello' });
    expect(parsed.lines[1]).toEqual({ n: 1, t: 'World' });
    expect(parsed.lines[2]).toEqual({ n: 2, t: 'Bye' });
  });

  test('produces a 0-based n index matching array position', () => {
    const segments = [{ text: 'a' }, { text: 'b' }];
    const parsed = JSON.parse(buildJsonUserPrompt(segments));
    parsed.lines.forEach((entry, i) => expect(entry.n).toBe(i));
  });

  test('handles an empty segment list', () => {
    expect(JSON.parse(buildJsonUserPrompt([]))).toEqual({ lines: [] });
  });
});

// ─── buildVerificationPrompt ──────────────────────────────────────────

describe('buildVerificationPrompt', () => {
  test('contains src and tgt languages', () => {
    const prompt = buildVerificationPrompt('en', 'vi', 5);
    expect(prompt).toContain('from en to vi');
    expect(prompt).toContain('translate it to vi');
  });

  test('embeds the exact expected object count', () => {
    const prompt = buildVerificationPrompt('en', 'ja', 9);
    expect(prompt).toContain('EXACTLY 9 objects');
  });
});

// ─── getProviderJsonConfig ────────────────────────────────────────────

describe('getProviderJsonConfig', () => {
  test('gemini-style provider returns a responseSchema with min/maxItems = count', () => {
    const config = getProviderJsonConfig('google', 11); // google => apiStyle 'gemini'
    expect(config).not.toBeNull();
    expect(config.responseFormat).toBe(true);
    const lines = config.responseSchema.properties.lines;
    expect(lines.minItems).toBe(11);
    expect(lines.maxItems).toBe(11);
    expect(lines.type).toBe('ARRAY');
    expect(config.responseSchema.required).toContain('lines');
  });

  test('openai-style provider returns json_object responseFormat', () => {
    const config = getProviderJsonConfig('openai', 5); // openai => apiStyle 'openai'
    expect(config).toEqual({ responseFormat: { type: 'json_object' } });
  });

  test('another openai-style provider (groq) also returns json_object', () => {
    const config = getProviderJsonConfig('groq', 3);
    expect(config).toEqual({ responseFormat: { type: 'json_object' } });
  });

  test('provider without JSON mode returns null (anthropic)', () => {
    expect(getProviderJsonConfig('anthropic', 5)).toBeNull(); // supportsJsonMode: false
  });

  test('unknown provider returns null', () => {
    expect(getProviderJsonConfig('does-not-exist', 5)).toBeNull();
  });
});

// ─── parseJsonResponse ────────────────────────────────────────────────

describe('parseJsonResponse', () => {
  const segments = [{ text: 'one' }, { text: 'two' }, { text: 'three' }];

  test('(a) object format places translations by index n', () => {
    const response = JSON.stringify({
      lines: [
        { n: 0, t: 'uno' },
        { n: 1, t: 'dos' },
        { n: 2, t: 'tres' },
      ],
    });
    const result = parseJsonResponse(response, segments);
    expect(result.lines).toEqual(['uno', 'dos', 'tres']);
    expect(result.validCount).toBe(3);
    expect(result.hadMismatch).toBe(false);
  });

  test('(b) plain array of strings maps positionally', () => {
    const response = JSON.stringify(['uno', 'dos', 'tres']);
    const result = parseJsonResponse(response, segments);
    expect(result.lines).toEqual(['uno', 'dos', 'tres']);
    expect(result.validCount).toBe(3);
    expect(result.hadMismatch).toBe(false);
  });

  test('(c) markdown-fenced JSON is unwrapped and parsed', () => {
    const response = '```json\n' + JSON.stringify({ lines: [{ n: 0, t: 'uno' }] }) + '\n```';
    const single = [{ text: 'one' }];
    const result = parseJsonResponse(response, single);
    expect(result.lines).toEqual(['uno']);
    expect(result.validCount).toBe(1);
    expect(result.hadMismatch).toBe(false);
  });

  test('(d) length mismatch sets hadMismatch:true and keeps originals for missing', () => {
    const response = JSON.stringify({
      lines: [
        { n: 0, t: 'uno' },
        { n: 1, t: 'dos' },
      ],
    });
    const result = parseJsonResponse(response, segments); // expected 3, got 2
    expect(result.validCount).toBe(2);
    expect(result.hadMismatch).toBe(true);
    expect(result.lines[2]).toBe('three'); // original retained for the missing index
  });

  test('(e) reordered n indices set hadMismatch:true even when length matches', () => {
    const response = JSON.stringify({
      lines: [
        { n: 1, t: 'dos' },
        { n: 0, t: 'uno' },
        { n: 2, t: 'tres' },
      ],
    });
    const result = parseJsonResponse(response, segments);
    // placed by index, so output is still in canonical order
    expect(result.lines).toEqual(['uno', 'dos', 'tres']);
    expect(result.validCount).toBe(3);
    expect(result.hadMismatch).toBe(true); // hadReorder triggered
  });

  test('(f) garbage / non-JSON returns null', () => {
    expect(parseJsonResponse('this is not json at all', segments)).toBeNull();
    expect(parseJsonResponse('', segments)).toBeNull();
  });

  test('extracts an embedded lines object from surrounding prose', () => {
    const response =
      'Sure, here you go: {"lines": [{"n": 0, "t": "uno"}, {"n": 1, "t": "dos"}, {"n": 2, "t": "tres"}]} done.';
    const result = parseJsonResponse(response, segments);
    expect(result.lines).toEqual(['uno', 'dos', 'tres']);
    expect(result.validCount).toBe(3);
  });

  test('blank translation text falls back to the original segment text', () => {
    const response = JSON.stringify({
      lines: [
        { n: 0, t: '' },
        { n: 1, t: 'dos' },
        { n: 2, t: 'tres' },
      ],
    });
    const result = parseJsonResponse(response, segments);
    expect(result.lines[0]).toBe('one'); // empty t -> original kept, not counted
    expect(result.validCount).toBe(2);
  });
});

// ─── cleanResponse ────────────────────────────────────────────────────

describe('cleanResponse', () => {
  test('returns empty string for falsy input', () => {
    expect(cleanResponse('')).toBe('');
    expect(cleanResponse(null)).toBe('');
    expect(cleanResponse(undefined)).toBe('');
  });

  test('strips triple-backtick code fences (with language tag)', () => {
    const input = '```json\n{"a":1}\n```';
    expect(cleanResponse(input)).toBe('{"a":1}');
  });

  test('strips triple-backtick code fences (no language tag)', () => {
    const input = '```\nhello world\n```';
    expect(cleanResponse(input)).toBe('hello world');
  });

  test('strips a leading "Certainly!" noise line', () => {
    const input = 'Certainly! Here it comes\nactual content';
    expect(cleanResponse(input)).toBe('actual content');
  });

  test('strips a leading "Here is the translation:" noise line', () => {
    const input = 'Here is the translation:\nactual content';
    expect(cleanResponse(input)).toBe('actual content');
  });

  test('strips a leading "Translation:" noise line', () => {
    const input = 'Translation:\nactual content';
    expect(cleanResponse(input)).toBe('actual content');
  });

  test('leaves clean text untouched (only trims)', () => {
    expect(cleanResponse('  plain text  ')).toBe('plain text');
  });
});

// ─── partitionKeysByProvider ──────────────────────────────────────────

describe('partitionKeysByProvider', () => {
  test('splits keys into groqKeys and nonGroqKeys by provider', () => {
    const keys = [
      { provider: 'groq', apiKey: 'g1' },
      { provider: 'openai', apiKey: 'o1' },
      { provider: 'groq', apiKey: 'g2' },
      { provider: 'google', apiKey: 'gg1' },
    ];
    const { groqKeys, nonGroqKeys } = partitionKeysByProvider(keys);
    expect(groqKeys.map((k) => k.apiKey)).toEqual(['g1', 'g2']);
    expect(nonGroqKeys.map((k) => k.apiKey)).toEqual(['o1', 'gg1']);
  });

  test('preserves ordering within each partition', () => {
    const keys = [
      { provider: 'openai', apiKey: 'a' },
      { provider: 'groq', apiKey: 'b' },
      { provider: 'openai', apiKey: 'c' },
    ];
    const { groqKeys, nonGroqKeys } = partitionKeysByProvider(keys);
    expect(groqKeys.map((k) => k.apiKey)).toEqual(['b']);
    expect(nonGroqKeys.map((k) => k.apiKey)).toEqual(['a', 'c']);
  });

  test('handles all-groq and no-groq inputs', () => {
    expect(partitionKeysByProvider([{ provider: 'groq', apiKey: 'x' }])).toEqual({
      groqKeys: [{ provider: 'groq', apiKey: 'x' }],
      nonGroqKeys: [],
    });
    expect(partitionKeysByProvider([{ provider: 'openai', apiKey: 'y' }])).toEqual({
      groqKeys: [],
      nonGroqKeys: [{ provider: 'openai', apiKey: 'y' }],
    });
  });

  test('handles an empty list', () => {
    expect(partitionKeysByProvider([])).toEqual({ groqKeys: [], nonGroqKeys: [] });
  });
});

// ─── splitForGroqPayload ──────────────────────────────────────────────

describe('splitForGroqPayload', () => {
  test('returns a single chunk equal to all segments for a small input', () => {
    const segments = [
      { text: 'hello', startMs: 0 },
      { text: 'world', startMs: 1000 },
      { text: 'bye', startMs: 2000 },
    ];
    const chunks = splitForGroqPayload(segments, 'en', 'vi', 'ctx');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(segments);
  });

  test('splits a large input into >1 chunk and concatenation reproduces order', () => {
    // Build a payload large enough that buildJsonSystemPrompt+buildJsonUserPrompt
    // length * 2 exceeds MAX_PAYLOAD_BYTES. Each long segment ~2000 chars.
    const bigText = 'x'.repeat(2000);
    const segments = [];
    for (let i = 0; i < 80; i++) {
      segments.push({ text: `${bigText}-${i}`, startMs: i * 1000 });
    }

    // Sanity: confirm the full payload really exceeds the byte limit.
    const fullJson = buildJsonUserPrompt(segments);
    const fullSys = buildJsonSystemPrompt('ctx', 'en', 'vi', segments.length);
    expect((fullJson.length + fullSys.length) * 2).toBeGreaterThan(MAX_PAYLOAD_BYTES);

    const chunks = splitForGroqPayload(segments, 'en', 'vi', 'ctx');
    expect(chunks.length).toBeGreaterThan(1);

    // Concatenation reproduces every segment in original order.
    const flattened = chunks.flat();
    expect(flattened).toEqual(segments);
  });

  test('every produced chunk fits within MAX_PAYLOAD_BYTES (except forced singletons)', () => {
    const bigText = 'y'.repeat(1500);
    const segments = [];
    for (let i = 0; i < 100; i++) {
      segments.push({ text: `${bigText}-${i}`, startMs: i * 1000 });
    }
    const chunks = splitForGroqPayload(segments, 'en', 'vi', 'ctx');
    for (const chunk of chunks) {
      if (chunk.length <= 1) continue; // a single oversized segment can't be split further
      const sys = buildJsonSystemPrompt('ctx', 'en', 'vi', chunk.length);
      const user = buildJsonUserPrompt(chunk);
      expect((sys.length + user.length) * 2).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    }
  });

  test('handles an empty segment list', () => {
    expect(splitForGroqPayload([], 'en', 'vi', 'ctx')).toEqual([]);
  });
});

// ─── groupByPhysicalKey ───────────────────────────────────────────────

describe('groupByPhysicalKey', () => {
  test('groups slots sharing the same apiKey into sub-arrays, order-preserving', () => {
    const slots = [
      { apiKey: 'k1', model: 'a' },
      { apiKey: 'k2', model: 'b' },
      { apiKey: 'k1', model: 'c' }, // same physical key as slot 0
      { apiKey: 'k3', model: 'd' },
    ];
    const groups = groupByPhysicalKey(slots);
    expect(groups).toHaveLength(3); // k1, k2, k3
    expect(groups[0]).toEqual([
      { apiKey: 'k1', model: 'a' },
      { apiKey: 'k1', model: 'c' },
    ]);
    expect(groups[1]).toEqual([{ apiKey: 'k2', model: 'b' }]);
    expect(groups[2]).toEqual([{ apiKey: 'k3', model: 'd' }]);
  });

  test('preserves first-seen group order', () => {
    const slots = [
      { apiKey: 'z', model: '1' },
      { apiKey: 'a', model: '2' },
      { apiKey: 'z', model: '3' },
    ];
    const groups = groupByPhysicalKey(slots);
    expect(groups.map((g) => g[0].apiKey)).toEqual(['z', 'a']);
  });

  test('handles an empty list', () => {
    expect(groupByPhysicalKey([])).toEqual([]);
  });
});

// ─── sortGroupsByHealth ───────────────────────────────────────────────

describe('sortGroupsByHealth', () => {
  test('sorts groups in place by groups[i][0].score descending', () => {
    const groups = [
      [{ apiKey: 'low', score: 0.2 }],
      [{ apiKey: 'high', score: 0.9 }],
      [{ apiKey: 'mid', score: 0.5 }],
    ];
    sortGroupsByHealth(groups);
    expect(groups.map((g) => g[0].apiKey)).toEqual(['high', 'mid', 'low']);
  });

  test('mutates the array in place (no return value)', () => {
    const groups = [[{ apiKey: 'a', score: 0.1 }], [{ apiKey: 'b', score: 0.8 }]];
    const ret = sortGroupsByHealth(groups);
    expect(ret).toBeUndefined();
    expect(groups[0][0].apiKey).toBe('b');
  });

  test('treats a missing score as 0.5 default', () => {
    const groups = [
      [{ apiKey: 'noScore' }], // defaults to 0.5
      [{ apiKey: 'high', score: 0.9 }],
      [{ apiKey: 'low', score: 0.1 }],
    ];
    sortGroupsByHealth(groups);
    expect(groups.map((g) => g[0].apiKey)).toEqual(['high', 'noScore', 'low']);
  });
});

// ─── selectGroupForBatch ──────────────────────────────────────────────

describe('selectGroupForBatch', () => {
  // Use unique apiKey values so no module-level cooldown is ever set for them.
  function freshGroups() {
    return [
      [{ apiKey: `sel-A-${Math.random()}`, model: 'm' }],
      [{ apiKey: `sel-B-${Math.random()}`, model: 'm' }],
      [{ apiKey: `sel-C-${Math.random()}`, model: 'm' }],
    ];
  }

  test('round-robins by batchIndex % numGroups when no cooldowns are set', () => {
    const groups = freshGroups();
    expect(selectGroupForBatch(groups, 0).groupIndex).toBe(0);
    expect(selectGroupForBatch(groups, 1).groupIndex).toBe(1);
    expect(selectGroupForBatch(groups, 2).groupIndex).toBe(2);
    expect(selectGroupForBatch(groups, 3).groupIndex).toBe(0); // wraps
    expect(selectGroupForBatch(groups, 4).groupIndex).toBe(1);
  });

  test('returns the slots array for the selected group', () => {
    const groups = freshGroups();
    const selected = selectGroupForBatch(groups, 1);
    expect(selected.slots).toBe(groups[1]);
  });

  test('returns null for an empty group list', () => {
    expect(selectGroupForBatch([], 0)).toBeNull();
  });

  test('works with a single group (always index 0)', () => {
    const groups = [[{ apiKey: `sel-single-${Math.random()}`, model: 'm' }]];
    expect(selectGroupForBatch(groups, 0).groupIndex).toBe(0);
    expect(selectGroupForBatch(groups, 7).groupIndex).toBe(0);
  });
});
