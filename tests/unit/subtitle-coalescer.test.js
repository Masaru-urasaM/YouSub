import { describe, test, expect } from '@jest/globals';
import {
  SubtitleCoalescer,
  coalesceSubtitleEntries,
  hasTerminalPunctuation,
  isCjkDominant,
  joinCueTexts,
  MAX_GAP_MS,
  MAX_BRIDGED_GAP_MS,
} from '../../src/content/subtitle-coalescer.js';

const cue = (startMs, endMs, text) => ({ startMs, endMs, text });

describe('SubtitleCoalescer (Phase 79b)', () => {
  test('hasTerminalPunctuation detects EN and CJK endings accurately', () => {
    expect(hasTerminalPunctuation('Hello world.')).toBe(true);
    expect(hasTerminalPunctuation('Really?')).toBe(true);
    expect(hasTerminalPunctuation('Watch out!')).toBe(true);
    expect(hasTerminalPunctuation('日本語です。')).toBe(true);
    expect(hasTerminalPunctuation('He said, "stop."')).toBe(true);
    expect(hasTerminalPunctuation('So I went to')).toBe(false);
    expect(hasTerminalPunctuation('and then')).toBe(false);
    expect(hasTerminalPunctuation('')).toBe(false);
  });

  test('isCjkDominant distinguishes Japanese/Chinese/Korean from English', () => {
    expect(isCjkDominant('これは日本語の字幕です')).toBe(true);
    expect(isCjkDominant('今天天气真好我们走吧')).toBe(true);
    expect(isCjkDominant('This is an English sentence')).toBe(false);
    expect(isCjkDominant('Using NASA and AIza tokens')).toBe(false);
  });

  test('joinCueTexts joins CJK without extra spaces and Latin with a single space', () => {
    expect(joinCueTexts('これは', 'テストです')).toBe('これはテストです');
    expect(joinCueTexts('So I went', 'to the store.')).toBe('So I went to the store.');
  });

  test('coalesces unpunctuated English ASR fragments and preserves [first.startMs, last.endMs]', () => {
    const raw = [
      cue(1000, 2200, 'So today we are going'),
      cue(2300, 3800, 'to build a complete'),
      cue(3900, 5100, 'subtitle translation engine.'),
      cue(5200, 6500, 'It handles seeking fast.'),
    ];

    const { entries, stats } = coalesceSubtitleEntries(raw);

    expect(stats).toEqual({ rawCount: 4, coalescedCount: 2, mergedCues: 2 });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      startMs: 1000,
      endMs: 5100,
      text: 'So today we are going to build a complete subtitle translation engine.',
      rawCueCount: 3,
    });
    expect(entries[1]).toMatchObject({
      startMs: 5200,
      endMs: 6500,
      text: 'It handles seeking fast.',
      rawCueCount: 1,
    });
  });

  test('splits when inter-cue gap exceeds limit (500ms standard vs 1500ms bridgedDom)', () => {
    const raw = [cue(0, 1000, 'First part without dot'), cue(1900, 3000, 'second part here')];

    const standard = coalesceSubtitleEntries(raw, { bridgedDom: false });
    expect(standard.entries).toHaveLength(2);

    const bridged = coalesceSubtitleEntries(raw, { bridgedDom: true });
    expect(bridged.entries).toHaveLength(1);
    expect(bridged.entries[0].endMs).toBe(3000);

    const tooFarBridged = coalesceSubtitleEntries(
      [cue(0, 1000, 'First part'), cue(1000 + MAX_BRIDGED_GAP_MS + 100, 4000, 'after silence')],
      { bridgedDom: true }
    );
    expect(tooFarBridged.entries).toHaveLength(2);
  });

  test('enforces 7000ms combined duration ceiling and 120 Latin / 60 CJK char ceilings', () => {
    const durationBounded = coalesceSubtitleEntries([
      cue(0, 4000, 'Part one still speaking'),
      cue(4100, 7500, 'part two exceeds 7s total'),
    ]);
    expect(durationBounded.entries).toHaveLength(2);

    const longA = 'a'.repeat(80);
    const longB = 'b'.repeat(45);
    const latinBounded = coalesceSubtitleEntries([cue(0, 1000, longA), cue(1100, 2000, longB)]);
    expect(latinBounded.entries).toHaveLength(2);

    const cjkShort = coalesceSubtitleEntries([
      cue(0, 1000, '今日はとてもいい天気ですね'),
      cue(1100, 2200, '一緒に散歩しましょう。'),
    ]);
    expect(cjkShort.entries).toHaveLength(1);
    expect(cjkShort.entries[0].text).toBe('今日はとてもいい天気ですね一緒に散歩しましょう。');

    const cjkTooLong = coalesceSubtitleEntries([
      cue(0, 1000, 'あ'.repeat(35)),
      cue(1100, 2200, 'い'.repeat(30)),
    ]);
    expect(cjkTooLong.entries).toHaveLength(2);
  });

  test('does not merge across bracketed sound effects or speaker turn markers', () => {
    const raw = [
      cue(0, 1000, 'Welcome back'),
      cue(1050, 2000, '[Music]'),
      cue(2050, 3000, 'Let us begin'),
      cue(3050, 4000, '- Wait what?'),
    ];
    const { entries } = SubtitleCoalescer.coalesce(raw);
    expect(entries).toHaveLength(4);
  });

  test('handles empty/invalid inputs cleanly', () => {
    expect(coalesceSubtitleEntries([])).toEqual({
      entries: [],
      stats: { rawCount: 0, coalescedCount: 0, mergedCues: 0 },
    });
    expect(
      coalesceSubtitleEntries([null, { startMs: 'bad', text: 'x' }, { startMs: 0, text: '' }])
        .entries
    ).toEqual([]);
    expect(MAX_GAP_MS).toBe(500);
  });

  test('normalizes tied whole-second timestamps and overlapping intervals monotonically for binary search', () => {
    const tiedSameSec = coalesceSubtitleEntries([
      cue(12000, 12000, 'First complete sentence.'),
      cue(12000, 15000, 'Second cue same whole second.'),
      cue(15000, 18000, 'Third cue.'),
    ]);
    expect(tiedSameSec.entries).toHaveLength(3);
    expect(tiedSameSec.entries[0].startMs).toBe(12000);
    expect(tiedSameSec.entries[0].endMs).toBe(13500);
    expect(tiedSameSec.entries[1].startMs).toBe(13500);
    expect(tiedSameSec.entries[1].endMs).toBe(15000);
    expect(tiedSameSec.entries[2].startMs).toBe(15000);

    const overlapping = coalesceSubtitleEntries([
      cue(1000, 6000, 'Rolling line one.'),
      cue(3000, 8000, 'Rolling line two.'),
    ]);
    expect(overlapping.entries[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
    expect(overlapping.entries[1]).toMatchObject({ startMs: 3000, endMs: 8000 });
  });
});
