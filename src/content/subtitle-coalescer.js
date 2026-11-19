import { devLog } from '../shared/constants.js';

export const MAX_GAP_MS = 500;
export const MAX_BRIDGED_GAP_MS = 1500;
export const MAX_COALESCED_DURATION_MS = 7000;
export const MAX_CHARS_LATIN = 120;
export const MAX_CHARS_CJK = 60;
const MIN_OVERLAP_TOLERANCE_MS = -100;

const TERMINAL_PUNCT_REGEX = /(?:[.?!…。？！♪♫"”'’)\]:])$/;
const CJK_ALL_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
const CJK_NO_SPACE_EDGE_REGEX =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff、。？！「」『』（）]/;

/**
 * Check whether a subtitle line ends with terminal punctuation or closing quote/bracket.
 */
export function hasTerminalPunctuation(text) {
  if (!text || typeof text !== 'string') return false;
  return TERMINAL_PUNCT_REGEX.test(text.trim());
}

/**
 * Determine whether CJK characters make up >= 30% of non-whitespace characters.
 */
export function isCjkDominant(text) {
  if (!text || typeof text !== 'string') return false;
  const compact = text.replace(/\s+/g, '');
  if (!compact) return false;
  const cjkMatches = compact.match(CJK_ALL_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  return cjkCount / compact.length >= 0.3;
}

/**
 * Join two subtitle text fragments, omitting spaces between Chinese/Japanese characters
 * while keeping spaces for Latin/Hangul scripts.
 */
export function joinCueTexts(prevText, nextText) {
  const left = (prevText || '').trim();
  const right = (nextText || '').trim();
  if (!left) return right;
  if (!right) return left;

  const lastChar = left.slice(-1);
  const firstChar = right.slice(0, 1);
  if (CJK_NO_SPACE_EDGE_REGEX.test(lastChar) && CJK_NO_SPACE_EDGE_REGEX.test(firstChar)) {
    return left + right;
  }
  return `${left} ${right}`;
}

function isNonMergeableCue(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  if (/^\[[^\]]+\]$/.test(trimmed) || /^\([^)]+\)$/.test(trimmed)) return true;
  if (/^-\s/.test(trimmed)) return true;
  return false;
}

function normalizeCueIntervals(cues) {
  if (!Array.isArray(cues) || cues.length <= 1) return cues;
  let i = 0;
  while (i < cues.length - 1) {
    let tieEnd = i;
    while (tieEnd + 1 < cues.length && cues[tieEnd + 1].startMs <= cues[i].startMs) {
      tieEnd++;
    }
    if (tieEnd > i) {
      const tieStart = cues[i].startMs;
      const maxTieEnd = cues.slice(i, tieEnd + 1).reduce((m, c) => Math.max(m, c.endMs), tieStart);
      const nextAnchor =
        tieEnd + 1 < cues.length && cues[tieEnd + 1].startMs > tieStart
          ? cues[tieEnd + 1].startMs
          : Math.max(maxTieEnd, tieStart + (tieEnd - i + 1) * 1000);
      const totalSpan = Math.max(tieEnd - i + 1, nextAnchor - tieStart);
      const sliceMs = totalSpan / (tieEnd - i + 1);
      for (let k = i; k <= tieEnd; k++) {
        const offset = k - i;
        cues[k].startMs = Math.round(tieStart + offset * sliceMs);
        cues[k].endMs =
          k === tieEnd
            ? nextAnchor
            : Math.max(cues[k].startMs + 1, Math.round(tieStart + (offset + 1) * sliceMs));
      }
      i = tieEnd + 1;
      continue;
    }

    if (cues[i].endMs > cues[i + 1].startMs) {
      cues[i].endMs = cues[i + 1].startMs;
    }
    i++;
  }
  return cues;
}

/**
 * Coalesce fragmented ASR/transcript cues into complete semantic clauses or sentences
 * prior to translation, preserving exact [first.startMs, last.endMs] timing.
 *
 * @param {Array<{startMs:number, endMs:number, text:string}>} entries
 * @param {Object} [options]
 * @param {boolean} [options.bridgedDom=false] True when adjacent DOM transcript cues had endMs set to next.startMs
 * @param {number} [options.maxGapMs] Override max inter-cue gap in ms
 * @param {number} [options.maxDurationMs] Override max coalesced duration in ms
 * @param {number} [options.maxCharsLatin] Override max Latin character count
 * @param {number} [options.maxCharsCjk] Override max CJK character count
 * @returns {{ entries: Array, stats: { rawCount: number, coalescedCount: number, mergedCues: number } }}
 */
export function coalesceSubtitleEntries(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      entries: [],
      stats: { rawCount: 0, coalescedCount: 0, mergedCues: 0 },
    };
  }

  const maxGapMs =
    typeof options.maxGapMs === 'number'
      ? options.maxGapMs
      : options.bridgedDom
        ? MAX_BRIDGED_GAP_MS
        : MAX_GAP_MS;
  const maxDurationMs =
    typeof options.maxDurationMs === 'number' ? options.maxDurationMs : MAX_COALESCED_DURATION_MS;
  const maxCharsLatin =
    typeof options.maxCharsLatin === 'number' ? options.maxCharsLatin : MAX_CHARS_LATIN;
  const maxCharsCjk = typeof options.maxCharsCjk === 'number' ? options.maxCharsCjk : MAX_CHARS_CJK;

  const clean = [];
  for (const item of entries) {
    if (!item || typeof item.startMs !== 'number' || Number.isNaN(item.startMs)) continue;
    const text = typeof item.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) continue;
    const endMs =
      typeof item.endMs === 'number' && !Number.isNaN(item.endMs) && item.endMs > item.startMs
        ? item.endMs
        : item.startMs + 2000;
    clean.push({
      ...item,
      startMs: item.startMs,
      endMs,
      text,
    });
  }

  if (clean.length === 0) {
    return {
      entries: [],
      stats: { rawCount: entries.length, coalescedCount: 0, mergedCues: 0 },
    };
  }

  const coalesced = [{ ...clean[0], rawCueCount: 1 }];

  for (let i = 1; i < clean.length; i++) {
    const next = clean[i];
    const current = coalesced[coalesced.length - 1];

    const gap = next.startMs - current.endMs;
    const combinedDuration = Math.max(current.endMs, next.endMs) - current.startMs;
    const combinedText = joinCueTexts(current.text, next.text);
    const charLimit = isCjkDominant(combinedText) ? maxCharsCjk : maxCharsLatin;

    const canMerge =
      !hasTerminalPunctuation(current.text) &&
      !isNonMergeableCue(current.text) &&
      !isNonMergeableCue(next.text) &&
      gap >= MIN_OVERLAP_TOLERANCE_MS &&
      gap <= maxGapMs &&
      combinedDuration <= maxDurationMs &&
      combinedText.length <= charLimit;

    if (canMerge) {
      current.endMs = Math.max(current.endMs, next.endMs);
      current.text = combinedText;
      current.rawCueCount = (current.rawCueCount || 1) + 1;
    } else {
      coalesced.push({ ...next, rawCueCount: 1 });
    }
  }

  normalizeCueIntervals(coalesced);

  const stats = {
    rawCount: clean.length,
    coalescedCount: coalesced.length,
    mergedCues: clean.length - coalesced.length,
  };

  devLog(
    `[YouSub] Coalescer: ${stats.rawCount} raw -> ${stats.coalescedCount} semantic cues (-${stats.mergedCues} merges)`
  );

  return { entries: coalesced, stats };
}

export const SubtitleCoalescer = {
  coalesce: coalesceSubtitleEntries,
  hasTerminalPunctuation,
  isCjkDominant,
  joinCueTexts,
  MAX_GAP_MS,
  MAX_BRIDGED_GAP_MS,
  MAX_COALESCED_DURATION_MS,
  MAX_CHARS_LATIN,
  MAX_CHARS_CJK,
};

if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.SubtitleCoalescer = SubtitleCoalescer;
}
