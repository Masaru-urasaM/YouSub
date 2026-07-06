import { Logger } from '../shared/logger.js';
import { RoughTranslator } from './rough-translator.js';

const MERGE_RATIO_HIGH = 2.0;
const MERGE_RATIO_LOW = 0.5;
const MIN_ANCHOR_WORD_LEN = 2;
const MAX_FIX_PASSES = 3;
const GARBAGE_WORD_THRESHOLD = 2;
const MIN_WORDS_FOR_RATIO_CHECK = 4;
const VERIFY_THRESHOLD = 1.3;
const MAX_BEST_FIT_DIFF = 0.35;
const MAX_SCAN_EXTRA = 2;
const SHIFT_RATIO_MIN = 1.8;
const SHIFT_MAX_SCAN = 4;
const TAIL_NGRAM_SIZE = 4;
const TAIL_OVERLAP_THRESHOLD = 0.5;
const MAX_SHIFT_CANDIDATES = 6;
const TAIL_MAX_GAPS = 2;
const MERGE_RATIO_MEDIUM = 1.5;
const CASCADE_SCORE_THRESHOLD = 0.6;
const CASCADE_TOKEN_WEIGHT = 0.4;
const CASCADE_BOUNDARY_WEIGHT = 0.3;
const CASCADE_LENGTH_WEIGHT = 0.3;
const CASCADE_MIN_BATCH_SIZE = 5;
const TOKEN_REGEX = /\b[A-Z]{2,}\b|\b\d[\d.,]*\b/g;
const TERMINAL_PUNCT_REGEX = /[.?!]$/;
const CJK_REGEX = /[぀-ゟ゠-ヿ一-鿿가-힯]/;

function wordCount(text) {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;

  if (CJK_REGEX.test(trimmed)) {
    const cjkChars = (trimmed.match(/[぀-ゟ゠-ヿ一-鿿가-힯]/g) || []).length;
    const nonCjk = trimmed
      .replace(/[぀-ゟ゠-ヿ一-鿿가-힯]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((w) => w).length;
    return Math.max(1, Math.ceil(cjkChars / 2) + nonCjk);
  }

  return trimmed.split(/\s+/).filter((w) => w).length;
}

function extractAnchorWords(roughText, count) {
  if (!roughText) return [];
  return roughText
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= MIN_ANCHOR_WORD_LEN)
    .slice(0, count);
}

function findAnchorInText(text, anchorWords, startFrom) {
  if (!anchorWords.length) return -1;
  const lowerText = text.toLowerCase();

  for (let n = Math.min(anchorWords.length, 3); n >= 1; n--) {
    const needle = anchorWords.slice(0, n).join(' ').toLowerCase();
    const pos = lowerText.indexOf(needle, startFrom);
    if (pos >= 0) return pos;
  }

  return -1;
}

function proportionalSplit(text, inputWordCounts) {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w);
  const totalInput = inputWordCounts.reduce((a, b) => a + b, 0);
  if (totalInput === 0) return inputWordCounts.map(() => '');

  const pieces = [];
  let cursor = 0;
  let cumTarget = 0;

  for (let i = 0; i < inputWordCounts.length; i++) {
    if (i === inputWordCounts.length - 1) {
      pieces.push(words.slice(cursor).join(' '));
    } else {
      cumTarget += (inputWordCounts[i] / totalInput) * words.length;
      const end = Math.max(cursor + 1, Math.round(cumTarget));
      pieces.push(words.slice(cursor, end).join(' '));
      cursor = end;
    }
  }
  return pieces;
}

function detectInternalRepetition(text) {
  if (!text) return false;
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w);
  if (words.length < TAIL_NGRAM_SIZE * 2) return false;

  const ngrams = new Map();
  for (let i = 0; i <= words.length - TAIL_NGRAM_SIZE; i++) {
    const gram = words
      .slice(i, i + TAIL_NGRAM_SIZE)
      .join(' ')
      .toLowerCase();
    ngrams.set(gram, (ngrams.get(gram) || 0) + 1);
    if (ngrams.get(gram) >= 2) return true;
  }
  return false;
}

function computeWordOverlap(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(
    a
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2)
  );
  const setB = new Set(
    b
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2)
  );
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  return intersection / Math.min(setA.size, setB.size);
}

function extractPreservedTokens(text) {
  if (!text || CJK_REGEX.test(text)) return [];
  const matches = text.match(TOKEN_REGEX);
  return matches ? [...new Set(matches)] : [];
}

function computeTokenAnchorScore(inputTokens, outputLine, prevOutput, nextOutput) {
  if (!inputTokens || inputTokens.length === 0) return null;

  const outputLower = (outputLine || '').toLowerCase();
  const prevLower = (prevOutput || '').toLowerCase();
  const nextLower = (nextOutput || '').toLowerCase();

  let misplaced = 0;
  for (const token of inputTokens) {
    const tLower = token.toLowerCase();
    const inCorrect = outputLower.includes(tLower);
    const inNeighbor = prevLower.includes(tLower) || nextLower.includes(tLower);
    if (!inCorrect && inNeighbor) misplaced++;
  }

  return misplaced / inputTokens.length;
}

function computeBoundaryAlignmentScore(inputLine, outputLine) {
  const inputHas = TERMINAL_PUNCT_REGEX.test((inputLine || '').trim());
  const outputHas = TERMINAL_PUNCT_REGEX.test((outputLine || '').trim());
  if (!inputHas && !outputHas) return null;
  return inputHas === outputHas ? 0.0 : 1.0;
}

function computeLengthOutlierScore(inputWc, outputWc, medianRatio) {
  if (medianRatio === 0 || inputWc === 0) return 0;
  const lineRatio = outputWc / Math.max(inputWc, 1);
  const deviation = Math.abs(lineRatio - medianRatio) / medianRatio;
  return Math.min(deviation, 1.0);
}

function computeMedianRatio(segments, outputLines) {
  const ratios = [];
  for (let i = 0; i < segments.length; i++) {
    const inWc = wordCount(segments[i].text);
    const outWc = wordCount(outputLines[i]);
    ratios.push(outWc / Math.max(inWc, 1));
  }
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 === 0 ? (ratios[mid - 1] + ratios[mid]) / 2 : ratios[mid];
}

function _computeLineCascadeScore(i, segments, outputLines, medianRatio) {
  const inputTokens = extractPreservedTokens(segments[i].text);
  const prevOutput = i > 0 ? outputLines[i - 1] : null;
  const nextOutput = i < outputLines.length - 1 ? outputLines[i + 1] : null;

  const tokenScore = computeTokenAnchorScore(inputTokens, outputLines[i], prevOutput, nextOutput);
  const boundaryScore = computeBoundaryAlignmentScore(segments[i].text, outputLines[i]);
  const lengthScore = computeLengthOutlierScore(
    wordCount(segments[i].text),
    wordCount(outputLines[i]),
    medianRatio
  );

  let totalWeight = 0;
  let weightedSum = 0;
  let signalCount = 0;

  if (tokenScore !== null) {
    totalWeight += CASCADE_TOKEN_WEIGHT;
    weightedSum += tokenScore * CASCADE_TOKEN_WEIGHT;
    if (tokenScore > 0.3) signalCount++;
  }
  if (boundaryScore !== null) {
    totalWeight += CASCADE_BOUNDARY_WEIGHT;
    weightedSum += boundaryScore * CASCADE_BOUNDARY_WEIGHT;
    if (boundaryScore > 0.5) signalCount++;
  }
  totalWeight += CASCADE_LENGTH_WEIGHT;
  weightedSum += lengthScore * CASCADE_LENGTH_WEIGHT;
  if (lengthScore > 0.3) signalCount++;

  if (totalWeight === 0) return { score: 0, signalCount: 0 };

  return { score: weightedSum / totalWeight, signalCount };
}

function detectCascadeShifts(segments, outputLines) {
  if (segments.length < CASCADE_MIN_BATCH_SIZE) return [];

  const medianRatio = computeMedianRatio(segments, outputLines);
  const cascades = [];

  for (let i = 0; i < segments.length; i++) {
    const { score, signalCount } = _computeLineCascadeScore(i, segments, outputLines, medianRatio);

    if (score >= CASCADE_SCORE_THRESHOLD && signalCount >= 2) {
      const inputTokens = extractPreservedTokens(segments[i].text);
      let direction = 1;
      if (inputTokens.length > 0) {
        const prevLower = (i > 0 ? outputLines[i - 1] : '').toLowerCase();
        const nextLower = (i < outputLines.length - 1 ? outputLines[i + 1] : '').toLowerCase();
        let inPrev = 0,
          inNext = 0;
        for (const token of inputTokens) {
          const tLower = token.toLowerCase();
          if (prevLower.includes(tLower)) inPrev++;
          if (nextLower.includes(tLower)) inNext++;
        }
        direction = inPrev > inNext ? -1 : 1;
      }
      cascades.push({ position: i, score, direction });
    }
  }

  return cascades;
}

function detectTailAnomalies(outputLines) {
  let count = 0;
  let gaps = 0;
  for (let i = outputLines.length - 1; i > 0; i--) {
    const line = outputLines[i];
    const isShort = wordCount(line) <= GARBAGE_WORD_THRESHOLD;
    const hasInternalRepetition = detectInternalRepetition(line);
    const isDuplicate = line && line === outputLines[i - 1];
    const overlapNext =
      i < outputLines.length - 1 &&
      computeWordOverlap(line, outputLines[i + 1]) > TAIL_OVERLAP_THRESHOLD;
    const overlapPrev =
      i > 1 && computeWordOverlap(line, outputLines[i - 1]) > TAIL_OVERLAP_THRESHOLD;

    if (isShort || hasInternalRepetition || isDuplicate || overlapNext || overlapPrev) {
      count += 1 + gaps;
      gaps = 0;
    } else {
      gaps++;
      if (gaps > TAIL_MAX_GAPS) break;
    }
  }
  return { count, startIndex: outputLines.length - count };
}

function findShiftCandidates(segments, outputLines) {
  const candidates = [];
  for (let i = 0; i < segments.length - 1 && candidates.length < MAX_SHIFT_CANDIDATES; i++) {
    const inWc = wordCount(segments[i].text);
    const outWc = wordCount(outputLines[i]);
    const ratio = outWc / Math.max(inWc, 1);
    if (ratio >= SHIFT_RATIO_MIN && inWc >= MIN_WORDS_FOR_RATIO_CHECK) {
      const nextOutWc = wordCount(outputLines[i + 1]);
      const nextInWc = wordCount(segments[i + 1].text);
      const nextRatio = nextOutWc / Math.max(nextInWc, 1);
      const nextIsShort = nextRatio < MERGE_RATIO_LOW || nextOutWc === 0;
      if (!nextIsShort) {
        candidates.push({ position: i, ratio });
      }
    }
  }
  return candidates;
}

function buildRealignment(outputLines, confirmedMerges, N) {
  const corrected = [];
  const pendingIndices = [];

  for (let readIdx = 0; readIdx < outputLines.length; readIdx++) {
    if (corrected.length >= N) break;

    if (confirmedMerges.has(readIdx)) {
      const absorbed = confirmedMerges.get(readIdx);
      for (let j = 0; j <= absorbed; j++) {
        pendingIndices.push(corrected.length);
        corrected.push('');
      }
    } else {
      corrected.push(outputLines[readIdx]);
    }
  }

  while (corrected.length < N) corrected.push('');
  return { lines: corrected.slice(0, N), pendingIndices };
}

async function verifyAndRefineMerge(
  position,
  initialAbsorbed,
  maxScan,
  segments,
  mergedText,
  src,
  tgt,
  roughTranslate
) {
  const textsToTranslate = [];
  for (let j = 0; j <= maxScan; j++) {
    textsToTranslate.push(segments[position + j].text);
  }
  // `roughTranslate` (optional) is an injected delegate with the SAME contract as
  // RoughTranslator.translateBatch: Promise<Array<string|null>> of length ===
  // texts.length, never rejecting. When absent, fall back to the in-worker seam.
  let roughAll;
  try {
    roughAll = roughTranslate
      ? await roughTranslate(textsToTranslate, src, tgt)
      : await RoughTranslator.translateBatch(textsToTranslate, src, tgt);
  } catch {
    // Contract says the delegate never rejects; if it does anyway, degrade rather
    // than let the throw abort the whole batch's finalization.
    roughAll = null;
  }
  // Defensive coercion (Blocker 2): downstream indexes roughAll[j] and calls
  // wordCount/extractAnchorWords on it (which assume string|null), so any contract
  // violation must degrade to all-null rather than corrupt or crash the verification.
  if (!Array.isArray(roughAll) || roughAll.length !== textsToTranslate.length) {
    roughAll = textsToTranslate.map(() => null);
  } else {
    // Normalize element types: only strings survive; a non-string element (delegate
    // breaking its Array<string|null> contract) becomes null. No-op for the in-worker
    // seam, which already returns Array<string|null>.
    roughAll = roughAll.map((r) => (typeof r === 'string' ? r : null));
  }

  const roughCurrent = roughAll[0];
  if (!roughCurrent) {
    return {
      verified: true,
      absorbed: initialAbsorbed,
      roughTranslations: roughAll.slice(1, initialAbsorbed + 1),
      fallback: true,
    };
  }

  const googleLen = wordCount(roughCurrent);
  const llmLen = wordCount(mergedText);
  const verifyRatio = llmLen / Math.max(googleLen, 1);

  if (verifyRatio < VERIFY_THRESHOLD) {
    Logger.debug(
      'MergeFixer',
      `[VERIFY] False alarm at ${position}: ratio=${verifyRatio.toFixed(2)} < ${VERIFY_THRESHOLD}`
    );
    return { verified: false };
  }

  let accumulated = googleLen;
  let bestAbsorbed = 0;
  let bestDiff = Infinity;

  for (let j = 1; j <= maxScan; j++) {
    const roughJ = roughAll[j];
    if (roughJ) {
      accumulated += wordCount(roughJ);
    } else {
      accumulated += wordCount(segments[position + j].text);
    }

    const diff = Math.abs(accumulated / llmLen - 1.0);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestAbsorbed = j;
    }

    if (accumulated > llmLen * 1.5) break;
  }

  if (bestDiff > MAX_BEST_FIT_DIFF || bestAbsorbed === 0) {
    Logger.debug(
      'MergeFixer',
      `[BESTFIT] No fit at ${position}: bestDiff=${bestDiff.toFixed(2)}, bestAbsorbed=${bestAbsorbed}`
    );
    return { verified: false };
  }

  Logger.debug(
    'MergeFixer',
    `[BESTFIT] Merge at ${position}: initial=${initialAbsorbed} -> refined=${bestAbsorbed} (diff=${bestDiff.toFixed(2)})`
  );
  return {
    verified: true,
    absorbed: bestAbsorbed,
    roughTranslations: roughAll.slice(1, bestAbsorbed + 1),
  };
}

export const MergeFixer = {
  detectMerges(segments, outputLines) {
    const merges = [];
    let i = 0;
    const medianRatio =
      segments.length >= CASCADE_MIN_BATCH_SIZE ? computeMedianRatio(segments, outputLines) : 0;

    while (i < segments.length) {
      const inWc = wordCount(segments[i].text);
      const outWc = wordCount(outputLines[i]);
      const ratio = outWc / Math.max(inWc, 1);

      const highRatio = ratio > MERGE_RATIO_HIGH;
      const mediumRatio = !highRatio && ratio > MERGE_RATIO_MEDIUM && medianRatio > 0;
      let cascadeConfirmed = false;
      if (mediumRatio && inWc >= MIN_WORDS_FOR_RATIO_CHECK) {
        const { score, signalCount } = _computeLineCascadeScore(
          i,
          segments,
          outputLines,
          medianRatio
        );
        cascadeConfirmed = score >= CASCADE_SCORE_THRESHOLD && signalCount >= 2;
      }

      if (
        (highRatio || cascadeConfirmed) &&
        inWc >= MIN_WORDS_FOR_RATIO_CHECK &&
        i < segments.length - 1
      ) {
        let absorbed = 0;
        for (let j = i + 1; j < segments.length; j++) {
          const jInWc = wordCount(segments[j].text);
          const jOutWc = wordCount(outputLines[j]);
          const jRatio = jOutWc / Math.max(jInWc, 1);
          const isShort = jRatio < MERGE_RATIO_LOW || jOutWc === 0;
          const isCascade =
            outputLines[i] &&
            outputLines[j] &&
            outputLines[j].length > 10 &&
            outputLines[i].includes(outputLines[j]);
          if (isShort || isCascade) {
            absorbed++;
          } else {
            break;
          }
        }

        if (absorbed === 0) {
          i++;
          continue;
        }
        merges.push({ position: i, absorbed });
        i += 1 + absorbed;
        continue;
      }
      i++;
    }

    return merges;
  },

  async fix(segments, outputLines, src, tgt, roughTranslate) {
    const lines = [...outputLines];
    const N = segments.length;

    const tailInfo = detectTailAnomalies(lines);
    if (tailInfo.count > 0) {
      const candidates = findShiftCandidates(segments, lines);
      if (candidates.length > 0) {
        const confirmedMerges = new Map();
        for (const { position } of candidates) {
          const maxScan = Math.min(SHIFT_MAX_SCAN, N - position - 1);
          const verifyResult = await verifyAndRefineMerge(
            position,
            1,
            maxScan,
            segments,
            lines[position],
            src,
            tgt,
            roughTranslate
          );
          if (verifyResult.verified) {
            confirmedMerges.set(position, verifyResult.absorbed);
          }
        }
        if (confirmedMerges.size > 0) {
          const totalAbsorbed = [...confirmedMerges.values()].reduce((a, b) => a + b, 0);
          Logger.debug(
            'MergeFixer',
            `[SHIFT] ${confirmedMerges.size} merge(s), ${totalAbsorbed} absorbed (tail=${tailInfo.count})`
          );
          return buildRealignment(lines, confirmedMerges, N);
        }
      }
    }

    const cascades = detectCascadeShifts(segments, lines);
    if (cascades.length > 0) {
      Logger.debug(
        'MergeFixer',
        `[CASCADE] ${cascades.length} cascade shift(s) detected via offline signals`
      );
      const cascadeMerges = new Map();
      for (const { position } of cascades) {
        cascadeMerges.set(position, 1);
      }
      return buildRealignment(lines, cascadeMerges, N);
    }

    for (let pass = 0; pass < MAX_FIX_PASSES; pass++) {
      const merges = this.detectMerges(segments, lines);
      if (merges.length === 0) break;

      Logger.debug(
        'MergeFixer',
        `[Pass ${pass + 1}] Detected ${merges.length} merge(s). Fixing...`
      );

      for (let m = merges.length - 1; m >= 0; m--) {
        const { position, absorbed: initialAbsorbed } = merges[m];
        const mergedText = lines[position];

        const nextMergePos = m < merges.length - 1 ? merges[m + 1].position : segments.length;
        const maxScan = Math.min(
          initialAbsorbed + MAX_SCAN_EXTRA,
          nextMergePos - position - 1,
          segments.length - position - 1
        );

        const verifyResult = await verifyAndRefineMerge(
          position,
          initialAbsorbed,
          maxScan,
          segments,
          mergedText,
          src,
          tgt,
          roughTranslate
        );

        if (!verifyResult.verified) continue;

        const absorbed = verifyResult.absorbed;
        const roughTranslations = verifyResult.roughTranslations;
        const allRoughsFailed = roughTranslations.every((r) => r === null);

        let pieces;

        if (allRoughsFailed) {
          const inputWordCounts = [];
          for (let j = 0; j <= absorbed; j++) {
            inputWordCounts.push(wordCount(segments[position + j].text));
          }
          pieces = proportionalSplit(mergedText, inputWordCounts);
          Logger.debug(
            'MergeFixer',
            `[FALLBACK] Proportional split at ${position} (${absorbed + 1} pieces)`
          );
        } else {
          const anchorPositions = [0];
          let cursor = 0;
          let failedCount = 0;

          for (let j = 0; j < roughTranslations.length; j++) {
            const rough = roughTranslations[j];
            if (!rough) {
              failedCount++;
              anchorPositions.push(-1);
              continue;
            }

            const anchorWords = extractAnchorWords(rough, 3);
            const splitPos = findAnchorInText(mergedText, anchorWords, cursor + 1);

            if (splitPos < 0 || (splitPos <= cursor && cursor > 0)) {
              failedCount++;
              anchorPositions.push(-1);
            } else {
              anchorPositions.push(splitPos);
              cursor = splitPos;
            }
          }
          anchorPositions.push(mergedText.length);

          if (failedCount === roughTranslations.length) {
            const inputWordCounts = [];
            for (let j = 0; j <= absorbed; j++) {
              inputWordCounts.push(wordCount(segments[position + j].text));
            }
            pieces = proportionalSplit(mergedText, inputWordCounts);
            Logger.debug(
              'MergeFixer',
              `[FALLBACK] All anchors failed at ${position}, using proportional`
            );
          } else if (failedCount === 0) {
            pieces = [];
            for (let j = 0; j < anchorPositions.length - 1; j++) {
              pieces.push(mergedText.substring(anchorPositions[j], anchorPositions[j + 1]).trim());
            }
            Logger.debug(
              'MergeFixer',
              `[ANCHOR] Split at ${position} into ${pieces.length} pieces`
            );
          } else {
            pieces = [];
            let rangeStart = 0;
            let rangeStartIdx = 0;

            for (let j = 1; j < anchorPositions.length; j++) {
              if (anchorPositions[j] >= 0 || j === anchorPositions.length - 1) {
                const rangeEnd = anchorPositions[j] >= 0 ? anchorPositions[j] : mergedText.length;
                const rangeText = mergedText.substring(rangeStart, rangeEnd);
                const rangeSegCount = j - rangeStartIdx;

                if (rangeSegCount === 1) {
                  pieces.push(rangeText.trim());
                } else {
                  const rangeWordCounts = [];
                  for (let k = rangeStartIdx; k < j; k++) {
                    rangeWordCounts.push(wordCount(segments[position + k].text));
                  }
                  const subPieces = proportionalSplit(rangeText, rangeWordCounts);
                  pieces.push(...subPieces);
                }

                rangeStart = rangeEnd;
                rangeStartIdx = j;
              }
            }
            Logger.debug(
              'MergeFixer',
              `[PARTIAL] Split at ${position}: ${failedCount} anchor(s) failed, used proportional for gaps`
            );
          }
        }

        lines.splice(position, 1 + absorbed, ...pieces);
        lines.splice(N);
      }

      for (let i = lines.length - 1; i > 0; i--) {
        if (lines[i] === lines[i - 1] && lines[i]) {
          lines[i] = segments[i] ? segments[i].text : '';
          Logger.debug('MergeFixer', `[DEDUP] Duplicate tail at ${i}, reverted to original`);
        } else {
          break;
        }
      }

      let tailGarbage = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (wordCount(lines[i]) <= GARBAGE_WORD_THRESHOLD) tailGarbage++;
        else break;
      }
      if (tailGarbage === 0) break;
      Logger.debug(
        'MergeFixer',
        `[Pass ${pass + 1}] ${tailGarbage} garbage tail lines remain, continuing...`
      );
    }

    return { lines, pendingIndices: [] };
  },
};

export const _internals = {
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
};
