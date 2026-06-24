import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { MergeFixer, _internals } from '../../src/background/merge-fixer.js';
import { RoughTranslator } from '../../src/background/rough-translator.js';

const {
  wordCount,
  extractAnchorWords,
  findAnchorInText,
  proportionalSplit,
  verifyAndRefineMerge,
  detectInternalRepetition,
  computeWordOverlap,
  detectTailAnomalies,
  findShiftCandidates,
  buildRealignment,
  extractPreservedTokens,
  computeTokenAnchorScore,
  computeBoundaryAlignmentScore,
  computeLengthOutlierScore,
  computeMedianRatio,
  detectCascadeShifts,
} = _internals;

let originalTranslateBatch;

beforeEach(() => {
  jest.clearAllMocks();
  originalTranslateBatch = RoughTranslator.translateBatch;
  RoughTranslator.translateBatch = jest.fn(async (texts) => texts.map(() => null));
});

afterEach(() => {
  RoughTranslator.translateBatch = originalTranslateBatch;
});

// ─── wordCount ───────────────────────────────────────────────

describe('wordCount', () => {
  test('returns 0 for empty string', () => {
    expect(wordCount('')).toBe(0);
  });

  test('returns 0 for null', () => {
    expect(wordCount(null)).toBe(0);
  });

  test('returns 0 for undefined', () => {
    expect(wordCount(undefined)).toBe(0);
  });

  test('counts single word', () => {
    expect(wordCount('hello')).toBe(1);
  });

  test('counts multiple words', () => {
    expect(wordCount('one two three')).toBe(3);
  });

  test('ignores extra whitespace', () => {
    expect(wordCount('  one   two  ')).toBe(2);
  });

  test('counts Japanese text as characters / 2', () => {
    expect(wordCount('これは日本語です')).toBe(4);
  });

  test('counts Chinese text as characters / 2', () => {
    expect(wordCount('你好世界')).toBe(2);
  });

  test('counts Korean text as characters / 2', () => {
    expect(wordCount('안녕하세요')).toBe(3);
  });

  test('counts mixed CJK-Latin text', () => {
    expect(wordCount('Tokyo 東京 2025')).toBe(3);
  });
});

// ─── extractAnchorWords ──────────────────────────────────────

describe('extractAnchorWords', () => {
  test('filters words shorter than MIN_ANCHOR_WORD_LEN', () => {
    expect(extractAnchorWords('I am a very good person', 3)).toEqual(['am', 'very', 'good']);
  });

  test('returns empty array for null', () => {
    expect(extractAnchorWords(null, 3)).toEqual([]);
  });

  test('returns empty array for empty string', () => {
    expect(extractAnchorWords('', 3)).toEqual([]);
  });

  test('limits result to requested count', () => {
    expect(extractAnchorWords('alpha beta gamma delta', 2)).toEqual(['alpha', 'beta']);
  });
});

// ─── findAnchorInText ────────────────────────────────────────

describe('findAnchorInText', () => {
  test('finds multi-word anchor phrase', () => {
    expect(findAnchorInText('hello world foo bar baz', ['foo', 'bar'], 0)).toBe(12);
  });

  test('returns -1 for non-existent anchor', () => {
    expect(findAnchorInText('hello world', ['nonexistent'], 0)).toBe(-1);
  });

  test('respects startFrom position', () => {
    expect(findAnchorInText('foo bar foo bar', ['foo', 'bar'], 5)).toBe(8);
  });

  test('falls back from 3-word to 1-word anchor', () => {
    const text = 'abc def ghi jkl mno';
    expect(findAnchorInText(text, ['def', 'ghi', 'xxx'], 0)).toBe(4);
  });

  test('returns -1 for empty anchor array', () => {
    expect(findAnchorInText('hello world', [], 0)).toBe(-1);
  });

  test('is case insensitive', () => {
    expect(findAnchorInText('Hello World', ['hello', 'world'], 0)).toBe(0);
  });
});

// ─── proportionalSplit ───────────────────────────────────────

describe('proportionalSplit', () => {
  test('distributes words proportionally', () => {
    const result = proportionalSplit('one two three four five six', [1, 2, 3]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('one');
    expect(result[1]).toBe('two three');
    expect(result[2]).toBe('four five six');
  });

  test('handles empty text', () => {
    expect(proportionalSplit('', [1, 1])).toEqual(['', '']);
  });

  test('handles zero word counts', () => {
    expect(proportionalSplit('hello world', [0, 0])).toEqual(['', '']);
  });

  test('gives remainder to last piece', () => {
    const result = proportionalSplit('a b c d e', [1, 1]);
    expect(result).toHaveLength(2);
    expect(result[0].split(/\s+/).length).toBeGreaterThanOrEqual(1);
    expect(result[1].split(/\s+/).length).toBeGreaterThanOrEqual(1);
  });
});

// ─── detectMerges ────────────────────────────────────────────

describe('detectMerges', () => {
  test('detects real merge when output is long and next line is empty', () => {
    const segments = [
      { text: 'I need to go to the store today' },
      { text: 'Can you help me with this task' },
      { text: 'Thanks for your time and help' },
    ];
    const outputLines = [
      'Toi can phai di den cua hang hom nay Ban co the giup toi voi nhiem vu nay khong',
      '',
      'Cam on vi thoi gian va su giup do cua ban',
    ];
    const merges = MergeFixer.detectMerges(segments, outputLines);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toEqual({ position: 0, absorbed: 1 });
  });

  test('detects merge with multiple absorbed lines', () => {
    const segments = [
      { text: 'First sentence is quite long enough' },
      { text: 'Second sentence here too now' },
      { text: 'Third sentence as well today' },
      { text: 'Fourth one is separate and fine' },
    ];
    const outputLines = [
      'Cau mot dai Cau hai o day Cau ba nua hom nay mot cau rat dai de test merge detection',
      '',
      '',
      'Cau bon rieng va tot dep hom nay',
    ];
    const merges = MergeFixer.detectMerges(segments, outputLines);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toEqual({ position: 0, absorbed: 2 });
  });

  test('Bug 1 regression: does NOT detect merge for verbose translation with no short followers', () => {
    const segments = [
      { text: 'I really want to go to the movies tonight' },
      { text: 'I think that would be a great idea' },
      { text: 'Let me check my calendar for today' },
    ];
    const outputLines = [
      'Toi thuc su muon di xem phim toi nay rat la vui khi duoc di xem phim toi nay cung ban be cua toi vi da lau roi khong di',
      'Toi nghi do la mot y tuong tuyet voi',
      'De toi kiem tra lich cua toi cho hom nay',
    ];
    const merges = MergeFixer.detectMerges(segments, outputLines);
    expect(merges).toHaveLength(0);
  });

  test('Bug 2 regression: does NOT flag short input with high ratio', () => {
    const segments = [{ text: 'Hi' }, { text: 'OK' }, { text: 'Sure thing' }];
    const outputLines = ['Xin chao ban nha', 'Duoc roi ban nha', 'Duoc chua chac roi day'];
    const merges = MergeFixer.detectMerges(segments, outputLines);
    expect(merges).toHaveLength(0);
  });

  test('Bug 2 regression: does NOT flag 1-3 word inputs regardless of ratio', () => {
    const segments = [{ text: 'Yeah' }, { text: 'Not really sure about it' }];
    const outputLines = ['U duoc roi thoi', 'Khong chac lam ve dieu do'];
    const merges = MergeFixer.detectMerges(segments, outputLines);
    expect(merges).toHaveLength(0);
  });

  test('Bug 3 regression: CJK text does not false-positive', () => {
    const segments = [
      { text: 'This is a test sentence for translation' },
      { text: 'Another sentence here today' },
    ];
    const outputLines = ['これは翻訳のためのテスト文です', 'ここにもう一つの文があります'];
    const merges = MergeFixer.detectMerges(segments, outputLines);
    expect(merges).toHaveLength(0);
  });

  test('returns empty array when no merges exist', () => {
    const segments = [
      { text: 'Hello there my good friend' },
      { text: 'How are you doing this fine day' },
    ];
    const outputLines = ['Xin chao ban tot cua toi', 'Hom nay ban co khoe khong nhi'];
    const merges = MergeFixer.detectMerges(segments, outputLines);
    expect(merges).toHaveLength(0);
  });
});

// ─── verifyAndRefineMerge ────────────────────────────────────

describe('verifyAndRefineMerge', () => {
  test('confirms real merge when Google baseline is much shorter than LLM', async () => {
    const segments = [
      { text: 'I need to go to the store today' },
      { text: 'Can you help me with this task' },
    ];
    const mergedText = 'Toi can di den cua hang hom nay Ban co the giup toi voi nhiem vu nay khong';
    // mergedText = 15 words

    // Google of seg[0] = 8 words → ratio = 15/8 = 1.875 > 1.3
    // accumulated after j=1: 8 + 5 = 13, diff = |13/15 - 1| = 0.133
    RoughTranslator.translateBatch = jest.fn(async () => [
      'Toi can di den cua hang hom nay',
      'Ban co the giup toi',
    ]);

    const result = await verifyAndRefineMerge(0, 1, 1, segments, mergedText, 'en', 'vi');
    expect(result.verified).toBe(true);
    expect(result.absorbed).toBe(1);
    expect(result.roughTranslations).toHaveLength(1);
  });

  test('rejects false alarm when Google baseline is similar to LLM', async () => {
    const segments = [
      { text: 'I really want to go to the movies tonight' },
      { text: 'Can you help me with something' },
    ];
    const mergedText = 'Toi thuc su muon di xem phim toi nay';
    // mergedText = 9 words

    // Google of seg[0] = 8 words → ratio = 9/8 = 1.125 < 1.3
    RoughTranslator.translateBatch = jest.fn(async () => [
      'Toi that su muon di xem phim nay',
      'Ban co the giup toi',
    ]);

    const result = await verifyAndRefineMerge(0, 1, 1, segments, mergedText, 'en', 'vi');
    expect(result.verified).toBe(false);
  });

  test('best-fit determines correct absorbed count', async () => {
    const segments = [
      { text: 'First sentence is quite long enough' },
      { text: 'Second sentence here too now' },
      { text: 'Third sentence as well today' },
      { text: 'Fourth is separate completely' },
    ];
    // 18 words merged
    const mergedText = 'Cau mot dai Cau hai o day Cau ba nua hom nay ban oi dep lam nhe ban';

    // Google seg[0] = 5 words, seg[1] = 5 words, seg[2] = 5 words, seg[3] = 4 words
    // j=1: accumulated = 5+5 = 10, diff = |10/18 - 1| = 0.444
    // j=2: accumulated = 10+5 = 15, diff = |15/18 - 1| = 0.167 ← best
    // j=3: accumulated = 15+4 = 19, diff = |19/18 - 1| = 0.056 ← even better
    // But we want absorbed=2, so let me adjust...
    // Actually with these numbers best would be j=3. Let me craft so j=2 wins.
    // Google seg[0]=6, seg[1]=6, seg[2]=6, seg[3]=4
    // j=1: 6+6=12, diff=|12/18-1|=0.333
    // j=2: 12+6=18, diff=|18/18-1|=0.0 ← perfect match!
    // j=3: 18+4=22, diff=|22/18-1|=0.222
    RoughTranslator.translateBatch = jest.fn(async () => [
      'Cau mot dai nhat nhe ban',
      'Cau hai o day nua nhe',
      'Cau ba nua hom nay nhe',
      'Cau bon rieng hoan toan',
    ]);

    const result = await verifyAndRefineMerge(0, 2, 3, segments, mergedText, 'en', 'vi');
    expect(result.verified).toBe(true);
    expect(result.absorbed).toBe(2);
  });

  test('best-fit adjusts absorbed UP from initial detection', async () => {
    const segments = [
      { text: 'First sentence is quite long enough' },
      { text: 'Second sentence here too now' },
      { text: 'Third sentence as well today' },
    ];
    const mergedText = 'Cau mot Cau hai Cau ba nua hom nay ban dep lam nhe ban oi';
    // 14 words

    // Google: seg[0]=4, seg[1]=5, seg[2]=5
    // j=1: 4+5=9, diff=|9/14-1|=0.357
    // j=2: 9+5=14, diff=|14/14-1|=0.0 ← perfect
    RoughTranslator.translateBatch = jest.fn(async () => [
      'Cau mot dai nhat',
      'Cau hai o day nua',
      'Cau ba nua hom nay',
    ]);

    // initialAbsorbed=1 but best-fit should find absorbed=2
    const result = await verifyAndRefineMerge(0, 1, 2, segments, mergedText, 'en', 'vi');
    expect(result.verified).toBe(true);
    expect(result.absorbed).toBe(2);
  });

  test('best-fit adjusts absorbed DOWN from initial detection', async () => {
    const segments = [
      { text: 'First sentence is quite long enough' },
      { text: 'Second sentence here too now' },
      { text: 'Third sentence as well today' },
    ];
    const mergedText = 'Cau mot dai nhat Cau hai o day nua nhe ban';
    // 11 words

    // Google: seg[0]=5, seg[1]=5, seg[2]=5
    // j=1: 5+5=10, diff=|10/11-1|=0.091 ← best
    // j=2: 10+5=15, diff=|15/11-1|=0.364
    RoughTranslator.translateBatch = jest.fn(async () => [
      'Cau mot dai nhat nhe',
      'Cau hai o day nua',
      'Cau ba nua hom nay',
    ]);

    // initialAbsorbed=2 but best-fit should find absorbed=1
    const result = await verifyAndRefineMerge(0, 2, 2, segments, mergedText, 'en', 'vi');
    expect(result.verified).toBe(true);
    expect(result.absorbed).toBe(1);
  });

  test('Google failure for current segment returns fallback', async () => {
    const segments = [
      { text: 'First sentence is quite long enough' },
      { text: 'Second sentence here too now' },
    ];
    const mergedText = 'Cau mot dai Cau hai o day nua hom nay';

    RoughTranslator.translateBatch = jest.fn(async () => [null, null]);

    const result = await verifyAndRefineMerge(0, 1, 1, segments, mergedText, 'en', 'vi');
    expect(result.verified).toBe(true);
    expect(result.absorbed).toBe(1);
    expect(result.fallback).toBe(true);
  });

  test('partial Google failures use input word count estimate', async () => {
    const segments = [
      { text: 'First sentence is quite long enough' },
      { text: 'Second here' },
      { text: 'Third sentence as well today' },
    ];
    const mergedText = 'Cau mot dai nhat Cau hai Cau ba nua hom nay dep lam';
    // 12 words

    // Google: seg[0]=5, seg[1]=null (use input wc=2), seg[2]=5
    // j=1: 5+2=7, diff=|7/12-1|=0.417
    // j=2: 7+5=12, diff=|12/12-1|=0.0 ← perfect
    RoughTranslator.translateBatch = jest.fn(async () => [
      'Cau mot dai nhat nhe',
      null,
      'Cau ba nua hom nay',
    ]);

    const result = await verifyAndRefineMerge(0, 2, 2, segments, mergedText, 'en', 'vi');
    expect(result.verified).toBe(true);
    expect(result.absorbed).toBe(2);
  });
});

// ─── fix ─────────────────────────────────────────────────────

describe('fix', () => {
  test('splits merged text using anchor words from rough translations', async () => {
    const segments = [
      { text: 'I need to go to the store today' },
      { text: 'Can you help me with this task' },
    ];
    const outputLines = [
      'Toi can di den cua hang hom nay Ban co the giup toi voi nhiem vu nay khong',
      '',
    ];

    RoughTranslator.translateBatch = jest.fn(async () => [
      'Toi can di den cua hang hom nay',
      'Ban co the giup toi',
    ]);

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toContain('Toi can di den cua hang');
    expect(result.lines[1]).toContain('Ban co the giup toi');
    expect(result.pendingIndices).toEqual([]);
  });

  test('falls back to proportional split when all roughs fail', async () => {
    const segments = [
      { text: 'Hello there my good friend today' },
      { text: 'How are you doing this fine day' },
    ];
    const outputLines = ['Xin chao ban tot cua toi hom nay Ban co khoe khong hom nay tot dep', ''];

    RoughTranslator.translateBatch = jest.fn(async () => [null, null]);

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].split(/\s+/).length).toBeGreaterThanOrEqual(1);
    expect(result.lines[1].split(/\s+/).length).toBeGreaterThanOrEqual(1);
    expect(result.pendingIndices).toEqual([]);
  });

  test('Bug 4: uses successful anchors and proportional for failed ones', async () => {
    const segments = [
      { text: 'First sentence is quite long enough' },
      { text: 'Second sentence here too now' },
      { text: 'Third sentence as well today' },
    ];
    const outputLines = [
      'Cau mot rat dai Cau hai o day Cau ba nua hom nay ban oi ban dep lam',
      '',
      '',
    ];

    RoughTranslator.translateBatch = jest.fn(async () => [
      'Cau mot rat dai nhe',
      'Cau hai o day',
      null,
    ]);

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toBeTruthy();
    expect(result.lines[1]).toBeTruthy();
    expect(result.lines[2]).toBeTruthy();
    expect(result.pendingIndices).toEqual([]);
  });

  test('does not corrupt valid translations of short segments', async () => {
    const segments = [{ text: 'Hi' }, { text: 'OK' }, { text: 'Sure' }];
    const outputLines = ['Xin chao ban', 'Duoc roi nhe', 'Chac chan roi'];

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.lines).toEqual(['Xin chao ban', 'Duoc roi nhe', 'Chac chan roi']);
    expect(result.pendingIndices).toEqual([]);
  });

  test('returns unchanged lines when no merges detected', async () => {
    const segments = [
      { text: 'Hello there my good friend' },
      { text: 'How are you doing this fine day' },
    ];
    const outputLines = ['Xin chao ban tot cua toi', 'Hom nay ban co khoe khong nhi'];

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.lines).toEqual(outputLines);
    expect(result.pendingIndices).toEqual([]);
  });

  test('handles merge at end of array correctly', async () => {
    const segments = [
      { text: 'This is a normal sentence here' },
      { text: 'This is the second one for testing' },
      { text: 'And this is the third sentence now' },
    ];
    const outputLines = [
      'Day la mot cau binh thuong o day',
      'Day la cau thu hai de test thu nhe va day la cau thu ba hom nay nua',
      '',
    ];

    RoughTranslator.translateBatch = jest.fn(async () => [
      'Day la cau thu hai de test',
      'va day la cau thu ba',
    ]);

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toBe('Day la mot cau binh thuong o day');
    expect(result.lines[1]).toBeTruthy();
    expect(result.lines[2]).toBeTruthy();
    expect(result.pendingIndices).toEqual([]);
  });

  test('verification rejects false alarm — lines unchanged', async () => {
    const segments = [
      { text: 'I really want to go to the movies tonight' },
      { text: 'Can you help me find a good one' },
      { text: 'Let me check the schedule now' },
    ];
    const outputLines = [
      'Toi thuc su muon di xem phim toi nay rat la vui khi duoc xem phim toi nay voi ban',
      '',
      'De toi kiem tra lich chieu ngay hom nay',
    ];

    // Google translates current segment to nearly same length as LLM → verifyRatio < 1.3
    RoughTranslator.translateBatch = jest.fn(async () => [
      'Toi that su muon di xem phim toi nay vui khi duoc xem phim nay ban',
      'Ban co the giup toi tim phim',
      'De toi kiem tra lich',
    ]);

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.lines).toEqual(outputLines);
    expect(result.pendingIndices).toEqual([]);
  });

  test('best-fit adjusts absorbed count in full pipeline', async () => {
    const segments = [
      { text: 'First sentence is quite long enough' },
      { text: 'Second sentence here too now' },
      { text: 'Third sentence as well today' },
      { text: 'Fourth one is separate and fine' },
    ];
    const outputLines = [
      'Cau mot dai nhat Cau hai o day nua nhe ban oi toi dep lam',
      '',
      '',
      'Cau bon rieng va tot dep hom nay',
    ];
    // mergedText = 15 words, input = 6 words, ratio = 2.5 > 2.0
    // detectMerges sees absorbed=2 (lines 1,2 empty)
    // Google says absorbed=1 is best fit:
    // seg[0]=7w, seg[1]=7w → j=1: 7+7=14, diff=|14/15-1|=0.067 ← best
    // j=2: 14+5=19, diff=|19/15-1|=0.267

    RoughTranslator.translateBatch = jest.fn(async () => [
      'Cau mot dai nhat nhe ban oi',
      'Cau hai o day nua nhe ban',
      'Cau ba nua hom nay',
      'Cau bon rieng tot dep',
    ]);

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.lines).toHaveLength(4);
    expect(result.lines[0]).toBeTruthy();
    expect(result.lines[1]).toBeTruthy();
    expect(result.pendingIndices).toEqual([]);
  });
});

// ─── detectInternalRepetition ───────────────────────────────

describe('detectInternalRepetition', () => {
  test('returns true when a 4-gram appears twice', () => {
    const text =
      'I think they should allow you to bring more mechs I think they should allow you to bring more mechs';
    expect(detectInternalRepetition(text)).toBe(true);
  });

  test('returns false for normal text without repetition', () => {
    const text = 'This is a completely normal sentence with no repeated phrases at all';
    expect(detectInternalRepetition(text)).toBe(false);
  });
});

// ─── computeWordOverlap ────────────────────────────────────

describe('computeWordOverlap', () => {
  test('returns high overlap for similar lines', () => {
    const a = 'they should allow you to bring more mechs and they should allow you';
    const b = 'and they should allow you to bring more mechs too';
    expect(computeWordOverlap(a, b)).toBeGreaterThan(0.5);
  });

  test('returns low overlap for different lines', () => {
    const a = 'the quick brown fox jumps over the lazy dog';
    const b = 'programming languages include python java rust';
    expect(computeWordOverlap(a, b)).toBeLessThan(0.3);
  });
});

// ─── detectTailAnomalies ───────────────────────────────────

describe('detectTailAnomalies', () => {
  test('detects short tail lines', () => {
    const lines = [
      'Normal translation here for this line',
      'Another good translation for testing',
      'ok',
      '',
    ];
    const result = detectTailAnomalies(lines);
    expect(result.count).toBe(2);
    expect(result.startIndex).toBe(2);
  });

  test('detects internal phrase repetition in tail', () => {
    const lines = [
      'Normal translation of the first line here',
      'Normal translation of the second line here',
      'I think they should allow more mechs I think they should allow more mechs',
    ];
    const result = detectTailAnomalies(lines);
    expect(result.count).toBe(1);
    expect(result.startIndex).toBe(2);
  });

  test('detects inter-line word overlap in tail', () => {
    const lines = [
      'Normal unique content here for the first line today',
      'Another unique line with totally different words and meaning',
      'they should allow you to bring more mechs and more power today',
      'they should allow you to bring more mechs they should allow you to bring more mechs',
    ];
    const result = detectTailAnomalies(lines);
    expect(result.count).toBeGreaterThanOrEqual(2);
  });

  test('returns count=0 for clean output', () => {
    const lines = [
      'First translated line has unique content here today',
      'Second translated line is also different and unique',
      'Third translated line completes the set of translations',
    ];
    const result = detectTailAnomalies(lines);
    expect(result.count).toBe(0);
    expect(result.startIndex).toBe(3);
  });

  test('bridges 1 normal gap between anomalous tail lines', () => {
    const lines = [
      'Normal translation here for the first line today',
      'Another good translation for the second line here',
      'ok',
      'This line is actually normal and fine for testing purposes here',
      '',
    ];
    const result = detectTailAnomalies(lines);
    expect(result.count).toBe(3);
    expect(result.startIndex).toBe(2);
  });

  test('bridges 2 normal gaps between anomalous tail lines', () => {
    const lines = [
      'Normal translation here for the first line today',
      'ok',
      'This line is actually normal and fine for testing purposes here',
      'Another normal line that should be bridged through for testing',
      '',
    ];
    const result = detectTailAnomalies(lines);
    expect(result.count).toBe(4);
    expect(result.startIndex).toBe(1);
  });

  test('stops after 3 consecutive normal lines (exceeds TAIL_MAX_GAPS)', () => {
    const lines = [
      'Normal translation here for the first line today',
      'Another good translation for the second line here',
      'Third good translation that is normal and unique too',
      'Fourth good translation that is completely different here',
      'ok',
    ];
    const result = detectTailAnomalies(lines);
    expect(result.count).toBe(1);
    expect(result.startIndex).toBe(4);
  });

  test('detects overlap with previous line (i-1)', () => {
    const lines = [
      'Normal unique content here for the first line today',
      'they should allow you to bring more mechs and more power today',
      'they should allow you to bring more mechs they should allow more',
    ];
    const result = detectTailAnomalies(lines);
    expect(result.count).toBeGreaterThanOrEqual(2);
  });
});

// ─── findShiftCandidates ───────────────────────────────────

describe('findShiftCandidates', () => {
  test('finds candidates with ratio >= 1.8', () => {
    const segments = [
      { text: 'Short input line here today' },
      { text: 'Another normal line for test' },
    ];
    const outputLines = [
      'Mot dong dich rat dai vi no gop hai dong lai voi nhau thanh mot dong dich rat dai',
      'Dong thu hai binh thuong day nhe',
    ];
    const candidates = findShiftCandidates(segments, outputLines);
    expect(candidates.length).toBe(1);
    expect(candidates[0].position).toBe(0);
  });

  test('skips lines with fewer than MIN_WORDS_FOR_RATIO_CHECK input words', () => {
    const segments = [{ text: 'Hi there' }, { text: 'Normal line for testing here' }];
    const outputLines = [
      'Xin chao ban nha hom nay ban co khoe khong nhi ban',
      'Dong binh thuong de test o day',
    ];
    const candidates = findShiftCandidates(segments, outputLines);
    expect(candidates.length).toBe(0);
  });

  test('respects MAX_SHIFT_CANDIDATES cap', () => {
    const segments = [];
    const outputLines = [];
    for (let i = 0; i < 10; i++) {
      segments.push({ text: 'Normal input line here now' });
      outputLines.push(
        'Dong dich rat dai vi gop lai voi nhau thanh mot dong dich cuc ky dai luon nhe ban oi'
      );
    }
    const candidates = findShiftCandidates(segments, outputLines);
    expect(candidates.length).toBeLessThanOrEqual(6);
  });
});

// ─── buildRealignment ──────────────────────────────────────

describe('buildRealignment', () => {
  test('single merge: correct pendingIndices and shifted content', () => {
    const outputLines = ['merged_0_1', 'shifted_2', 'shifted_3', 'garbage'];
    const merges = new Map([[0, 1]]);
    const result = buildRealignment(outputLines, merges, 4);
    expect(result.lines).toEqual(['', '', 'shifted_2', 'shifted_3']);
    expect(result.pendingIndices).toEqual([0, 1]);
  });

  test('multiple merges: correct cumulative realignment', () => {
    const outputLines = [
      'merged_0_1',
      'content_2',
      'content_3',
      'merged_4_5',
      'content_6',
      'garbage_7',
      'garbage_8',
    ];
    const merges = new Map([
      [0, 1],
      [3, 1],
    ]);
    const result = buildRealignment(outputLines, merges, 7);
    expect(result.pendingIndices).toEqual([0, 1, 4, 5]);
    expect(result.lines[2]).toBe('content_2');
    expect(result.lines[3]).toBe('content_3');
    expect(result.lines[6]).toBe('content_6');
  });

  test('truncates to N lines', () => {
    const outputLines = ['merged_0_1', 'shifted_2', 'shifted_3', 'garbage'];
    const merges = new Map([[0, 1]]);
    const result = buildRealignment(outputLines, merges, 4);
    expect(result.lines).toHaveLength(4);
  });

  test('no merges: returns original lines unchanged', () => {
    const outputLines = ['line_0', 'line_1', 'line_2'];
    const merges = new Map();
    const result = buildRealignment(outputLines, merges, 3);
    expect(result.lines).toEqual(['line_0', 'line_1', 'line_2']);
    expect(result.pendingIndices).toEqual([]);
  });
});

// ─── fix (shift-aware) ─────────────────────────────────────

describe('fix (shift-aware)', () => {
  test('shift pattern: returns pendingIndices with empty slots', async () => {
    const segments = [
      { text: 'First input line here for testing today' },
      { text: 'Second input line here for testing now' },
      { text: 'Third input line is separate and fine' },
    ];
    const outputLines = [
      'Dong mot va dong hai gop lai thanh mot dong dich rat dai luon nhe ban oi hom nay',
      'Dong ba rieng biet va tot dep nhe',
      'noi',
    ];

    RoughTranslator.translateBatch = jest.fn(async () => [
      'Dong dau tien o day de test hom nay',
      'Dong thu hai o day de test bay gio',
    ]);

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.pendingIndices).toEqual([0, 1]);
    expect(result.lines[0]).toBe('');
    expect(result.lines[1]).toBe('');
    expect(result.lines[2]).toBe('Dong ba rieng biet va tot dep nhe');
  });

  test('shift merge rejected by Google verification — classic path used', async () => {
    const segments = [
      { text: 'I really want to go to the movies tonight now' },
      { text: 'Can you help me find a good movie here' },
      { text: 'ok' },
    ];
    const outputLines = [
      'Toi thuc su muon di xem phim toi nay rat vui khi duoc xem phim ban',
      'Ban co the giup toi tim mot bo phim hay',
      'ok',
    ];

    RoughTranslator.translateBatch = jest.fn(async () => [
      'Toi that su muon di xem phim toi nay vui khi duoc xem phim',
      'Ban co the giup toi tim phim',
    ]);

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.pendingIndices).toEqual([]);
    expect(result.lines).toEqual(outputLines);
  });

  test('multiple shift merges: correct pending count', async () => {
    const segments = [];
    const outputLines = [];
    for (let i = 0; i < 8; i++) {
      segments.push({ text: `Input sentence number ${i} for testing purposes here` });
    }
    outputLines[0] = 'Dong zero va dong mot gop lai thanh cuc ky dai luon nhe ban oi hom nay';
    outputLines[1] = 'Dong hai binh thuong nhe ban oi';
    outputLines[2] = 'Dong ba binh thuong nhe ban oi';
    outputLines[3] = 'Dong bon va dong nam gop lai thanh cuc ky dai luon nhe ban oi hom nay';
    outputLines[4] = 'Dong sau binh thuong nhe ban';
    outputLines[5] = 'Dong bay binh thuong nhe ban';
    outputLines[6] =
      'Toi nghi rang ho nen cho phep mang nhieu mech Toi nghi rang ho nen cho phep mang nhieu mech';
    outputLines[7] =
      'Toi nghi rang ho nen cho phep mang nhieu mech Toi nghi rang ho nen cho phep mang nhieu mech';

    let callCount = 0;
    RoughTranslator.translateBatch = jest.fn(async (_texts) => {
      callCount++;
      if (callCount === 1) {
        return ['Cau nhap so khong de thu nghiem', 'Cau nhap so mot de thu nghiem'];
      }
      return ['Cau nhap so bon de thu nghiem', 'Cau nhap so nam de thu nghiem'];
    });

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.pendingIndices.length).toBe(4);
  });

  test('no tail anomalies: classic path used', async () => {
    const segments = [
      { text: 'Hello there my good friend today' },
      { text: 'How are you doing this fine day now' },
    ];
    const outputLines = [
      'Xin chao ban tot cua toi hom nay',
      'Hom nay ban co khoe khong nhi bay gio',
    ];

    const result = await MergeFixer.fix(segments, outputLines, 'en', 'vi');
    expect(result.pendingIndices).toEqual([]);
    expect(result.lines).toEqual(outputLines);
  });
});

// ─── extractPreservedTokens ─────────────────────────────────

describe('extractPreservedTokens', () => {
  test('extracts all-caps acronyms', () => {
    const tokens = extractPreservedTokens('The NASA program launched in 2024');
    expect(tokens).toContain('NASA');
    expect(tokens).toContain('2024');
  });

  test('extracts numbers with decimals and commas', () => {
    const tokens = extractPreservedTokens('Total cost is 1,500.75 USD');
    expect(tokens).toContain('1,500.75');
    expect(tokens).toContain('USD');
  });

  test('does not extract single uppercase letters', () => {
    const tokens = extractPreservedTokens('I went to A store');
    expect(tokens).not.toContain('I');
    expect(tokens).not.toContain('A');
  });

  test('returns empty array for CJK input', () => {
    expect(extractPreservedTokens('これはNASAのテストです')).toEqual([]);
  });

  test('returns empty for null/empty', () => {
    expect(extractPreservedTokens(null)).toEqual([]);
    expect(extractPreservedTokens('')).toEqual([]);
  });

  test('deduplicates tokens', () => {
    const tokens = extractPreservedTokens('NASA sent NASA to space in 2024');
    const nasaCount = tokens.filter((t) => t === 'NASA').length;
    expect(nasaCount).toBe(1);
  });
});

// ─── computeTokenAnchorScore ────────────────────────────────

describe('computeTokenAnchorScore', () => {
  test('returns 0 when all tokens in correct output', () => {
    const score = computeTokenAnchorScore(
      ['NASA', '2024'],
      'NASA launched in 2024',
      'Previous line here',
      'Next line here'
    );
    expect(score).toBe(0);
  });

  test('returns 1 when all tokens in neighbor instead', () => {
    const score = computeTokenAnchorScore(
      ['NASA', '2024'],
      'Some unrelated output here',
      'NASA launched in 2024',
      'Another line'
    );
    expect(score).toBe(1);
  });

  test('returns 0.5 when half tokens misplaced', () => {
    const score = computeTokenAnchorScore(
      ['NASA', '2024'],
      'NASA is in this line',
      'Previous has 2024',
      'Next line'
    );
    expect(score).toBe(0.5);
  });

  test('returns null when no tokens provided', () => {
    expect(computeTokenAnchorScore([], 'output', 'prev', 'next')).toBeNull();
    expect(computeTokenAnchorScore(null, 'output', 'prev', 'next')).toBeNull();
  });

  test('handles null prev/next outputs', () => {
    const score = computeTokenAnchorScore(['NASA'], 'Some other text', null, null);
    expect(score).toBe(0);
  });
});

// ─── computeBoundaryAlignmentScore ──────────────────────────

describe('computeBoundaryAlignmentScore', () => {
  test('returns 0 when both end with period', () => {
    expect(computeBoundaryAlignmentScore('Hello world.', 'Xin chao.')).toBe(0);
  });

  test('returns 1 when input has period but output does not', () => {
    expect(computeBoundaryAlignmentScore('Hello world.', 'Xin chao')).toBe(1);
  });

  test('returns 1 when output has period but input does not', () => {
    expect(computeBoundaryAlignmentScore('Hello world', 'Xin chao.')).toBe(1);
  });

  test('returns null when neither has terminal punctuation', () => {
    expect(computeBoundaryAlignmentScore('Hello world', 'Xin chao')).toBeNull();
  });

  test('recognizes question marks and exclamation marks', () => {
    expect(computeBoundaryAlignmentScore('How are you?', 'Ban khoe khong?')).toBe(0);
    expect(computeBoundaryAlignmentScore('Stop!', 'Dung lai')).toBe(1);
  });
});

// ─── computeLengthOutlierScore ──────────────────────────────

describe('computeLengthOutlierScore', () => {
  test('returns 0 for line matching median ratio', () => {
    const score = computeLengthOutlierScore(10, 12, 1.2);
    expect(score).toBeCloseTo(0, 1);
  });

  test('returns high score for outlier', () => {
    const score = computeLengthOutlierScore(10, 30, 1.2);
    expect(score).toBeGreaterThan(0.5);
  });

  test('clamps to 1.0', () => {
    const score = computeLengthOutlierScore(5, 50, 1.0);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  test('returns 0 when medianRatio is 0', () => {
    expect(computeLengthOutlierScore(10, 12, 0)).toBe(0);
  });
});

// ─── computeMedianRatio ─────────────────────────────────────

describe('computeMedianRatio', () => {
  test('computes median for odd-length batch', () => {
    const segments = [
      { text: 'one two three' },
      { text: 'four five' },
      { text: 'six seven eight nine' },
    ];
    const outputs = ['mot hai ba', 'bon nam', 'sau bay tam chin'];
    const ratio = computeMedianRatio(segments, outputs);
    expect(ratio).toBeCloseTo(1.0, 1);
  });

  test('computes median for even-length batch', () => {
    const segments = [{ text: 'one two' }, { text: 'three four five six' }];
    const outputs = ['mot hai', 'ba bon nam sau'];
    const ratio = computeMedianRatio(segments, outputs);
    expect(ratio).toBeCloseTo(1.0, 1);
  });
});

// ─── detectCascadeShifts ────────────────────────────────────

describe('detectCascadeShifts', () => {
  test('returns empty for small batches (< CASCADE_MIN_BATCH_SIZE)', () => {
    const segments = [{ text: 'Line 1 with NASA 2024.' }, { text: 'Line 2 content here.' }];
    const outputs = ['Wrong content', 'NASA 2024 here'];
    expect(detectCascadeShifts(segments, outputs)).toEqual([]);
  });

  test('detects cascade when tokens from input[i] appear in output[i+1]', () => {
    const segments = [
      { text: 'The NASA program launched in 2024.' },
      { text: 'The ESA program started in 2020.' },
      { text: 'Both agencies collaborate on ISS.' },
      { text: 'The budget was 500 million USD.' },
      { text: 'They plan to reach MARS by 2030.' },
      { text: 'The CREW will have 4 members.' },
    ];
    const outputs = [
      'Chuong trinh da duoc khoi dong nay',
      'Chuong trinh NASA 2024 bat dau nhe.',
      'Chuong trinh ESA 2020 hop tac nhe',
      'Ca hai co quan ISS ngan sach hom nay.',
      'Ngan sach 500 trieu USD ke hoach nhe',
      'Ho du dinh dat MARS vao 2030.',
    ];
    const cascades = detectCascadeShifts(segments, outputs);
    expect(cascades.length).toBeGreaterThanOrEqual(1);
  });

  test('does NOT trigger on correct translations', () => {
    const segments = [
      { text: 'NASA launched program A in 2024.' },
      { text: 'ESA started project B in 2020.' },
      { text: 'Both agencies work on ISS together.' },
      { text: 'Budget was 500 million USD total.' },
      { text: 'Target is MARS by 2030 deadline.' },
      { text: 'CREW will consist of 4 astronauts.' },
    ];
    const outputs = [
      'NASA da khoi dong chuong trinh A nam 2024.',
      'ESA da bat dau du an B nam 2020.',
      'Ca hai co quan hop tac tren ISS.',
      'Ngan sach la 500 trieu USD tong.',
      'Muc tieu la MARS truoc han 2030.',
      'CREW se gom 4 phi hanh gia.',
    ];
    const cascades = detectCascadeShifts(segments, outputs);
    expect(cascades.length).toBe(0);
  });

  test('requires two-signal minimum (single signal not enough)', () => {
    const segments = [
      { text: 'Simple line one here today now' },
      { text: 'Simple line two here today also' },
      { text: 'Simple line three more content' },
      { text: 'Simple line four additional text' },
      { text: 'Simple line five final words here' },
    ];
    const outputs = [
      'Dong mot o day hom nay bay gio',
      'Dong hai o day hom nay cung vay',
      'Dong ba them noi dung o day nua',
      'Dong bon them van ban nua day nhe',
      'Dong nam tu cuoi cung o day nhe',
    ];
    const cascades = detectCascadeShifts(segments, outputs);
    expect(cascades.length).toBe(0);
  });

  test('integration: MergeFixer.fix() returns pendingIndices for cascade pattern', async () => {
    const segments = [
      { text: 'The NASA program launched in 2024.' },
      { text: 'The ESA program started in 2020.' },
      { text: 'Both agencies collaborate on ISS.' },
      { text: 'The budget was 500 million USD.' },
      { text: 'They plan to reach MARS by 2030.' },
      { text: 'The CREW will have 4 members.' },
    ];
    const outputs = [
      'Chuong trinh da duoc khoi dong nay',
      'Chuong trinh NASA 2024 bat dau nhe.',
      'Chuong trinh ESA 2020 hop tac nhe',
      'Ca hai co quan ISS ngan sach hom nay.',
      'Ngan sach 500 trieu USD ke hoach nhe',
      'Ho du dinh dat MARS vao 2030.',
    ];

    const result = await MergeFixer.fix(segments, outputs, 'en', 'vi');
    expect(result.pendingIndices.length).toBeGreaterThanOrEqual(1);
  });
});
