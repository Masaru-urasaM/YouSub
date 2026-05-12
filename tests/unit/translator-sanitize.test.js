import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { _internals } from '../../src/background/translator.js';

const {
  detectForeignScriptLines, sanitizeForeignScript, NON_LATIN_TARGETS,
  detectUntranslatedLines, parseVerificationResponse,
  MIN_WORDS_FOR_UNTRANSLATED, UNTRANSLATED_OVERLAP_THRESHOLD
} = _internals;

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
});

// ─── detectForeignScriptLines ────────────────────────────────

describe('detectForeignScriptLines', () => {
  test('detects Chinese (CJK) in Vietnamese text', () => {
    const lines = ['lệnh封锁', 'clean line'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([0]);
  });

  test('detects Cyrillic contamination', () => {
    const lines = ['Привет world', 'hello'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([0]);
  });

  test('detects Arabic contamination', () => {
    const lines = ['مرحبا hello', 'ok'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([0]);
  });

  test('detects Thai contamination', () => {
    const lines = ['สวัสดี xin chao'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([0]);
  });

  test('detects Devanagari contamination', () => {
    const lines = ['नमस्ते hello'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([0]);
  });

  test('detects Bengali contamination', () => {
    const lines = ['বাংলা hello'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([0]);
  });

  test('detects Hebrew contamination', () => {
    const lines = ['שלום hello'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([0]);
  });

  test('detects Hangul contamination', () => {
    const lines = ['안녕하세요 hello'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([0]);
  });

  test('returns empty for clean Latin text', () => {
    const lines = ['perfectly clean', 'also clean', 'Xin chào thế giới'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([]);
  });

  test('returns empty for Vietnamese diacritics', () => {
    const lines = ['Đây là một câu tiếng Việt hoàn chỉnh', 'ắ ằ ẳ ẵ ặ ố ồ ổ ỗ ộ'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([]);
  });

  test('skips detection for non-Latin targets', () => {
    for (const tgt of NON_LATIN_TARGETS) {
      expect(detectForeignScriptLines(['你好世界'], tgt)).toEqual([]);
    }
  });

  test('detects multiple contaminated lines', () => {
    const lines = ['line封锁', 'clean', 'линия'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([0, 2]);
  });

  test('handles null/empty/undefined lines', () => {
    const lines = [null, '', undefined, 'ok'];
    expect(detectForeignScriptLines(lines, 'vi')).toEqual([]);
  });

  test('detects production example: lệnh封锁', () => {
    expect(detectForeignScriptLines(['lệnh封锁'], 'vi')).toEqual([0]);
  });

  test('detects production example: Ồ天啊', () => {
    expect(detectForeignScriptLines(['Ồ天啊'], 'vi')).toEqual([0]);
  });

  test('detects production example: 展示 cho mọi người', () => {
    expect(detectForeignScriptLines(['展示 cho mọi người'], 'vi')).toEqual([0]);
  });

  test('detects production example: đó基本 là lựa chọn', () => {
    expect(detectForeignScriptLines(['đó基本 là lựa chọn'], 'vi')).toEqual([0]);
  });

  test('detects CJK Compatibility ideographs', () => {
    expect(detectForeignScriptLines(['豈test'], 'vi')).toEqual([0]);
  });

  test('detects Hiragana contamination', () => {
    expect(detectForeignScriptLines(['こんにちは hello'], 'vi')).toEqual([0]);
  });

  test('detects Katakana contamination', () => {
    expect(detectForeignScriptLines(['カタカナ hello'], 'vi')).toEqual([0]);
  });
});

// ─── sanitizeForeignScript ───────────────────────────────────

describe('sanitizeForeignScript', () => {
  test('strips CJK from Vietnamese text', () => {
    const segments = [{ text: 'blockade command', startMs: 0 }];
    expect(sanitizeForeignScript(['lệnh封锁'], segments, 'vi')).toEqual(['lệnh']);
  });

  test('strips Cyrillic', () => {
    const segments = [{ text: 'hello world', startMs: 0 }];
    expect(sanitizeForeignScript(['helloМир'], segments, 'vi')).toEqual(['hello']);
  });

  test('strips Arabic', () => {
    const segments = [{ text: 'hello', startMs: 0 }];
    expect(sanitizeForeignScript(['helloمرحبا'], segments, 'vi')).toEqual(['hello']);
  });

  test('strips Thai', () => {
    const segments = [{ text: 'hello', startMs: 0 }];
    expect(sanitizeForeignScript(['helloสวัสดี'], segments, 'vi')).toEqual(['hello']);
  });

  test('collapses multiple spaces after stripping', () => {
    const segments = [{ text: 'a b', startMs: 0 }];
    expect(sanitizeForeignScript(['a 封 b'], segments, 'vi')).toEqual(['a b']);
  });

  test('no-op for non-Latin target', () => {
    expect(sanitizeForeignScript(['你好'], null, 'zh')).toEqual(['你好']);
    expect(sanitizeForeignScript(['안녕'], null, 'ko')).toEqual(['안녕']);
  });

  test('handles null/undefined lines', () => {
    expect(sanitizeForeignScript([null, undefined], null, 'vi')).toEqual([null, undefined]);
  });

  test('strip-to-empty falls back to source text', () => {
    const segments = [{ text: 'Oh my god', startMs: 0 }];
    expect(sanitizeForeignScript(['天啊'], segments, 'vi')).toEqual(['Oh my god']);
  });

  test('strip-to-empty without segments returns empty', () => {
    expect(sanitizeForeignScript(['天啊'], null, 'vi')).toEqual(['']);
  });

  test('preserves Latin text with diacritics', () => {
    const segments = [{ text: 'hello', startMs: 0 }];
    const input = ['Đây là câu tiếng Việt'];
    expect(sanitizeForeignScript(input, segments, 'vi')).toEqual(input);
  });
});

// ─── detectUntranslatedLines ────────────────────────────────

describe('detectUntranslatedLines', () => {
  test('detects exact match with > 4 words', () => {
    const source = 'Imagine a soldier who can turn off fear';
    const segments = [{ text: source, startMs: 0 }];
    expect(detectUntranslatedLines([source], segments, 'vi')).toEqual([0]);
  });

  test('detects high word overlap (0.9)', () => {
    const source = 'the quick brown fox jumps over the lazy dog today';
    const output = 'the quick brown fox jumps over the lazy dog now';
    const segments = [{ text: source, startMs: 0 }];
    expect(detectUntranslatedLines([output], segments, 'vi')).toEqual([0]);
  });

  test('does not detect low word overlap (0.5)', () => {
    const source = 'the quick brown fox jumps over the lazy dog';
    const output = 'con cao nau nhanh nhay qua the lazy dog';
    const segments = [{ text: source, startMs: 0 }];
    expect(detectUntranslatedLines([output], segments, 'vi')).toEqual([]);
  });

  test('exempts short source (<=4 words) even with exact match', () => {
    const segments = [
      { text: 'Thank you', startMs: 0 },
      { text: 'Oh my God', startMs: 1000 },
      { text: 'Yes sir', startMs: 2000 },
      { text: 'No no no', startMs: 3000 }
    ];
    const lines = ['Thank you', 'Oh my God', 'Yes sir', 'No no no'];
    expect(detectUntranslatedLines(lines, segments, 'vi')).toEqual([]);
  });

  test('exempts single word "Paris"', () => {
    const segments = [{ text: 'Paris', startMs: 0 }];
    expect(detectUntranslatedLines(['Paris'], segments, 'vi')).toEqual([]);
  });

  test('returns empty for clean translation', () => {
    const segments = [{ text: 'Hello world how are you today', startMs: 0 }];
    expect(detectUntranslatedLines(['Xin chao the gioi ban khoe khong'], segments, 'vi')).toEqual([]);
  });

  test('returns empty for non-Latin target', () => {
    const source = 'Imagine a soldier who can turn off fear';
    const segments = [{ text: source, startMs: 0 }];
    expect(detectUntranslatedLines([source], segments, 'zh')).toEqual([]);
    expect(detectUntranslatedLines([source], segments, 'ja')).toEqual([]);
    expect(detectUntranslatedLines([source], segments, 'ko')).toEqual([]);
  });

  test('detects multiple untranslated lines', () => {
    const segments = [
      { text: 'This is a long sentence that was not translated', startMs: 0 },
      { text: 'Day la cau da dich', startMs: 1000 },
      { text: 'Another long sentence that remains in English completely', startMs: 2000 }
    ];
    const lines = [
      'This is a long sentence that was not translated',
      'Day la cau da dich roi',
      'Another long sentence that remains in English completely'
    ];
    expect(detectUntranslatedLines(lines, segments, 'vi')).toEqual([0, 2]);
  });

  test('handles null/undefined lines without crash', () => {
    const segments = [
      { text: 'hello world how are you', startMs: 0 },
      { text: 'foo bar baz qux quux', startMs: 1000 },
      null
    ];
    expect(detectUntranslatedLines([null, undefined, 'ok'], segments, 'vi')).toEqual([]);
  });

  test('production example: full English in Vietnamese output', () => {
    const source = 'Imagine a soldier who can turn off fear and anxiety at will';
    const segments = [{ text: source, startMs: 32000 }];
    expect(detectUntranslatedLines([source], segments, 'vi')).toEqual([0]);
  });

  test('borderline overlap exactly at 0.85 threshold', () => {
    // 7 words source, need >= 0.85 * 7 = 5.95 -> 6 shared words to trigger
    const source = 'one two three four five six seven';
    const segments = [{ text: source, startMs: 0 }];
    // 6 of 7 shared = 0.857 >= 0.85 -> should detect
    const output6 = 'one two three four five six changed';
    expect(detectUntranslatedLines([output6], segments, 'vi')).toEqual([0]);
    // 5 of 7 shared = 0.714 < 0.85 -> should NOT detect
    const output5 = 'one two three four five changed altered';
    expect(detectUntranslatedLines([output5], segments, 'vi')).toEqual([]);
  });
});

// ─── parseVerificationResponse ──────────────────────────────

describe('parseVerificationResponse', () => {
  test('parses valid JSON with {n, t, k}', () => {
    const json = JSON.stringify({
      lines: [
        { n: 0, t: 'translated text', k: false },
        { n: 1, t: 'Paris', k: true }
      ]
    });
    const result = parseVerificationResponse(json, 2);
    expect(result).toEqual([
      { index: 0, text: 'translated text', keep: false },
      { index: 1, text: 'Paris', keep: true }
    ]);
  });

  test('k: true maps to keep: true', () => {
    const json = JSON.stringify({ lines: [{ n: 0, t: 'NASA', k: true }] });
    const result = parseVerificationResponse(json, 1);
    expect(result[0].keep).toBe(true);
  });

  test('missing k defaults to keep: false', () => {
    const json = JSON.stringify({ lines: [{ n: 0, t: 'some text' }] });
    const result = parseVerificationResponse(json, 1);
    expect(result[0].keep).toBe(false);
  });

  test('invalid JSON returns null', () => {
    expect(parseVerificationResponse('not json at all', 1)).toBeNull();
  });

  test('parses markdown-wrapped JSON', () => {
    const wrapped = '```json\n{"lines": [{"n": 0, "t": "hello", "k": false}]}\n```';
    const result = parseVerificationResponse(wrapped, 1);
    expect(result).toEqual([{ index: 0, text: 'hello', keep: false }]);
  });
});
