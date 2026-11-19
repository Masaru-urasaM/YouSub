import { Logger } from '../shared/logger.js';
import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';

export const MAX_PAYLOAD_BYTES = 95000; // ~95KB safe limit for Groq (most restrictive provider)
export const MIN_WORDS_FOR_UNTRANSLATED = 4;
export const UNTRANSLATED_OVERLAP_THRESHOLD = 0.85;

export const NON_LATIN_TARGETS = new Set([
  'zh',
  'ja',
  'ko',
  'ar',
  'hi',
  'th',
  'ru',
  'uk',
  'el',
  'he',
  'bn',
]);

// eslint-disable-next-line no-misleading-character-class, no-irregular-whitespace -- intentional: matches foreign-script (incl. combining/ideographic-space) chars to detect contamination
export const FOREIGN_SCRIPT_DETECT = /[Ѐ-ԯ֐-ۿऀ-৿฀-๿　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
// eslint-disable-next-line no-misleading-character-class, no-irregular-whitespace -- intentional: strips foreign-script (incl. combining/ideographic-space) chars from text
export const FOREIGN_SCRIPT_STRIP = /[Ѐ-ԯ֐-ۿऀ-৿฀-๿　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;

export function detectForeignScriptLines(lines, tgt) {
  if (NON_LATIN_TARGETS.has(tgt)) return [];
  const contaminated = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && typeof line === 'string' && FOREIGN_SCRIPT_DETECT.test(line)) {
      contaminated.push(i);
    }
  }
  return contaminated;
}

export function sanitizeForeignScript(lines, segments, tgt) {
  if (NON_LATIN_TARGETS.has(tgt)) return lines;
  return lines.map((line, i) => {
    if (!line || typeof line !== 'string') return line;
    const cleaned = line
      .replace(FOREIGN_SCRIPT_STRIP, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned !== line)
      Logger.debug('Translator', `[SANITIZE] Stripped foreign script from line`);
    if (!cleaned && segments && segments[i]) return segments[i].text;
    return cleaned;
  });
}

export function detectUntranslatedLines(lines, segments, tgt) {
  if (NON_LATIN_TARGETS.has(tgt)) return [];
  const untranslated = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const source = segments[i]?.text;
    if (!line || !source || typeof line !== 'string' || typeof source !== 'string') continue;

    const sourceWords = source.trim().split(/\s+/);
    if (sourceWords.length <= MIN_WORDS_FOR_UNTRANSLATED) continue;

    if (line.trim() === source.trim()) {
      untranslated.push(i);
      continue;
    }

    const lineWords = line.trim().toLowerCase().split(/\s+/);
    const srcWords = source.trim().toLowerCase().split(/\s+/);
    const srcSet = new Set(srcWords);
    const shared = lineWords.filter((w) => srcSet.has(w)).length;
    const overlap = shared / Math.max(srcWords.length, lineWords.length);
    if (overlap >= UNTRANSLATED_OVERLAP_THRESHOLD) {
      untranslated.push(i);
    }
  }
  return untranslated;
}

/**
 * Helper: Format milliseconds to [HH:MM:SS]
 */
export function formatTimestamp(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const h = String(hours).padStart(2, '0');
  const m = String(minutes).padStart(2, '0');
  const s = String(seconds).padStart(2, '0');

  return `[${h}:${m}:${s}]`;
}

/**
 * Helper: Normalize any H:M:S format into a canonical H:M:S key (numbers only)
 * Handles [0:01:05], [00:1:5], [00:01:05] etc.
 */
export function normalizeTs(tsString) {
  if (!tsString) return '';
  const parts = tsString.replace(/[[\]]/g, '').split(':');
  if (parts.length !== 3) return tsString;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parseInt(parts[2], 10);
  return `${h}:${m}:${s}`;
}

/**
 * Noise reduction: Strip common LLM artifacts to extract raw subtitle lines.
 */
export function cleanResponse(text) {
  if (!text) return '';

  let cleaned = text.trim();

  // 1. Strip Markdown code blocks (``` ... ```)
  const codeBlockRegex = /```(?:\w+)?\n([\s\S]+?)```/;
  const match = cleaned.match(codeBlockRegex);
  if (match && match[1]) {
    cleaned = match[1].trim();
  }

  // 2. Clear common introductory noise (e.g., "Certainly!", "Here is the translation:")
  const noisePatterns = [
    /^Certainly!.*?\n/i,
    /^Sure!.*?\n/i,
    /^Here is the translation.*?\n/i,
    /^Translation:.*?\n/i,
    /^Please see below.*?\n/i,
  ];

  noisePatterns.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, '').trim();
  });

  return cleaned;
}

// Phase 57: Build the system prompt template (extracted for reuse by Groq waterfall)
// Never change UNFILTERED & FAITHFUL rule, it is the most important rule.
export function buildSystemPrompt(context, src, tgt, segmentCount) {
  return `You are a professional subtitle translator for youtube. The input is a list of subtitle lines with timestamps of youtube's auto-generated subtitles.
VIDEO CONTEXT:
${context}

Translate the following subtitle lines from ${src} to ${tgt}.
CRITICAL RULES:
1. PRESERVE THE LINE COUNT EXACTLY. Return exactly ${segmentCount} lines, with exact format as the rules below.
2. REQUIRED FORMAT: #N [HH:MM:SS] {Translated Text}
   Example: #1 [00:00:12] Hello, #2 [00:00:13] Good morning
3. THE TIMESTAMP IS THE POINTER. I use timestamp to sync subtitles. So you must return the same timestamp for each translated line as provided in the input.
4. ONE-TO-ONE MAPPING: Output line #N must be the translation of ONLY input line #N. Do NOT merge content from multiple input lines into one output line. If a sentence spans multiple input lines, split the translation across the same line numbers.
5. Return ONLY the translated lines. No explanations. The translated text must be in ${tgt}.
6. UNFILTERED & FAITHFUL: Preserve all profanity, slang, and offensive language as-is. Do NOT censor, refine, or "beautify" the translation. If the source is vulgar, the translation MUST be equally vulgar in ${tgt}. 100% honesty to the source is mandatory, even if it is a swear word, slur, curse, profanity, or any other offensive, criminal, illegal language.
`;
}

// Phase 58: JSON Structured Output — returns provider-specific config or null
export function getProviderJsonConfig(providerId, segmentCount) {
  const provider = YOUSUB_PROVIDERS.getProvider(providerId);
  if (!provider || !provider.supportsJsonMode) return null;

  if (provider.apiStyle === 'gemini') {
    return {
      responseFormat: true,
      responseSchema: {
        type: 'OBJECT',
        properties: {
          lines: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                n: { type: 'INTEGER' },
                t: { type: 'STRING' },
              },
              required: ['n', 't'],
            },
            minItems: segmentCount,
            maxItems: segmentCount,
          },
        },
        required: ['lines'],
      },
    };
  }

  if (provider.apiStyle === 'openai') {
    return { responseFormat: { type: 'json_object' } };
  }

  return null;
}

// Phase 58: JSON-in / JSON-out prompt — symmetric structure reduces merge errors
export function buildJsonSystemPrompt(context, src, tgt, segmentCount) {
  return `You are a professional subtitle translator for youtube.
VIDEO CONTEXT:
${context}

The input is a JSON object containing ${segmentCount} subtitle lines.
Translate each line from ${src} to ${tgt} and return the same JSON structure with translated text.
Input/Output format: {"lines": [{"n": 0, "t": "..."}, {"n": 1, "t": "..."}, ...]}

CRITICAL RULES:
1. The output "lines" array MUST contain EXACTLY ${segmentCount} objects, same as input.
2. Each "n" value must match the input. Translate "t" only, keep "n" unchanged.
3. Object with "n": i is the translation of ONLY input "n": i. Do NOT merge multiple input lines into one.
4. If a sentence spans multiple lines, split the translation across the same line numbers.
5. UNFILTERED & FAITHFUL: Preserve all profanity, slang, and offensive language as-is. Do NOT censor, refine, or "beautify" the translation. If the source is vulgar, the translation MUST be equally vulgar in ${tgt}. 100% honesty to the source is mandatory, even if it is a swear word, slur, curse, profanity, or any other offensive, criminal, illegal language.
6. Return ONLY the JSON object. No explanations, no markdown.`;
}

// Phase 58: User prompt for JSON mode — symmetric JSON input matching output format
export function buildJsonUserPrompt(segments) {
  const lines = segments.map((s, i) => ({ n: i, t: s.text }));
  return JSON.stringify({ lines });
}

export function buildVerificationPrompt(src, tgt, count) {
  return `You are a subtitle translator and language verifier.

The lines below may not have been translated properly from ${src} to ${tgt}.
For each line, translate it to ${tgt}.

HOWEVER: If a line is a proper noun, a name, a simple universal word, a brand name, or genuinely cannot be translated to ${tgt} — keep the original text and mark it.

Return JSON: {"lines": [{"n": 0, "t": "translated text", "k": false}, ...]}
- "n": line index (keep unchanged from input)
- "t": the correct translation in ${tgt}, OR the original text if keeping
- "k": true ONLY if the text is a proper noun / name / untranslatable. false if you translated it.

The output "lines" array MUST contain EXACTLY ${count} objects.
Return ONLY the JSON object. No explanations, no markdown.`;
}

export function parseVerificationResponse(responseText, expectedCount) {
  let cleaned = cleanResponse(responseText);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*"lines"\s*:\s*\[[\s\S]*\]\s*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  let rawLines;
  if (Array.isArray(parsed)) rawLines = parsed;
  else if (parsed && Array.isArray(parsed.lines)) rawLines = parsed.lines;
  else return null;

  const result = [];
  for (let i = 0; i < rawLines.length && i < expectedCount; i++) {
    const entry = rawLines[i];
    if (entry && typeof entry === 'object') {
      result.push({
        index: typeof entry.n === 'number' ? entry.n : i,
        text: typeof entry.t === 'string' ? entry.t.trim() : '',
        keep: !!entry.k,
      });
    }
  }
  return result.length > 0 ? result : null;
}

// Phase 58: Parse JSON translation response, validate array length
export function parseJsonResponse(responseText, segments) {
  let cleaned = cleanResponse(responseText);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*"lines"\s*:\s*\[[\s\S]*\]\s*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  let rawLines;
  if (Array.isArray(parsed)) {
    rawLines = parsed;
  } else if (parsed && Array.isArray(parsed.lines)) {
    rawLines = parsed.lines;
  } else {
    return null;
  }

  const expected = segments.length;
  const result = segments.map((s) => s.text);
  let validCount = 0;
  let hadReorder = false;

  const isObjectFormat =
    rawLines.length > 0 &&
    typeof rawLines[0] === 'object' &&
    rawLines[0] !== null &&
    't' in rawLines[0];

  if (isObjectFormat) {
    const parsedItems = [];
    let minIdx = Infinity;
    let maxIdx = -Infinity;
    let hasZero = false;

    for (let i = 0; i < rawLines.length; i++) {
      const entry = rawLines[i];
      if (!entry || typeof entry !== 'object') continue;
      const rawN =
        typeof entry.n === 'number' && Number.isInteger(entry.n)
          ? entry.n
          : typeof entry.n === 'string' && /^\d+$/.test(entry.n.trim())
            ? Number(entry.n.trim())
            : -1;
      const text = typeof entry.t === 'string' ? entry.t.trim() : '';
      if (rawN >= 0 && text) {
        parsedItems.push({ rawIndex: rawN, arrayPos: i, text });
        if (rawN === 0) hasZero = true;
        if (rawN < minIdx) minIdx = rawN;
        if (rawN > maxIdx) maxIdx = rawN;
      }
    }

    const isOneBased =
      parsedItems.length > 0 &&
      !hasZero &&
      minIdx === 1 &&
      maxIdx <= expected &&
      (maxIdx === expected || (rawLines.length === expected && parsedItems.length === expected));
    const indexOffset = isOneBased ? 1 : 0;

    for (const item of parsedItems) {
      const idx = item.rawIndex - indexOffset;
      if (idx >= 0 && idx < expected) {
        result[idx] = item.text;
        validCount++;
        if (idx !== item.arrayPos) hadReorder = true;
      }
    }
    Logger.trace(
      'Translator',
      `[JSON_PARSE] Object format: ${validCount}/${expected} placed by index${isOneBased ? ' (normalized 1-based)' : ''}`
    );
  } else {
    for (let i = 0; i < rawLines.length && i < expected; i++) {
      const text = typeof rawLines[i] === 'string' ? rawLines[i].trim() : '';
      if (text) {
        result[i] = text;
        validCount++;
      }
    }
  }

  if (rawLines.length !== expected) {
    Logger.warn(
      'Translator',
      `[JSON_PARSE] Array length mismatch: expected=${expected} actual=${rawLines.length}`
    );
  }

  return { lines: result, validCount, hadMismatch: rawLines.length !== expected || hadReorder };
}

// Phase D6 (DEFERRED): timestamp text parser. Mirrors parseJsonResponse's shape.
// Maps [HH:MM:SS]-tagged response text back onto segments by normalized timestamp
// (queued FIFO per tag), keeping the original segment text where no tag matched.
export function parseTimestampedText(responseText, segments) {
  let cleanedText = cleanResponse(responseText);
  cleanedText = cleanedText.replace(/#\d+\s+(?=\[)/g, '');

  const tagRegex = /\[(\d{1,2}:\d{1,2}:\d{1,2})\]/g;
  const parsedQueues = {};
  let pendingTags = [];
  let lastEnd = 0;
  let match;

  while ((match = tagRegex.exec(cleanedText)) !== null) {
    const textBetween = cleanedText.substring(lastEnd, match.index).trim();
    if (textBetween && pendingTags.length > 0) {
      pendingTags.forEach((tag) => {
        const norm = normalizeTs(tag);
        if (!parsedQueues[norm]) parsedQueues[norm] = [];
        parsedQueues[norm].push(textBetween);
      });
      pendingTags = [];
    }
    pendingTags.push(match[1]);
    lastEnd = tagRegex.lastIndex;
  }

  const finalContent = cleanedText.substring(lastEnd).trim();
  if (finalContent && pendingTags.length > 0) {
    pendingTags.forEach((tag) => {
      const norm = normalizeTs(tag);
      if (!parsedQueues[norm]) parsedQueues[norm] = [];
      parsedQueues[norm].push(finalContent);
    });
  }

  let validLinesCount = 0;
  const resultLines = segments.map((s) => {
    const rawTs = formatTimestamp(s.startMs);
    const normTs = normalizeTs(rawTs);
    if (parsedQueues[normTs] && parsedQueues[normTs].length > 0) {
      validLinesCount++;
      return parsedQueues[normTs].shift();
    }
    return s.text;
  });

  return { lines: resultLines, validCount: validLinesCount };
}

// Phase 57: Partition keys into Groq and non-Groq groups (preserves ordering)
export function partitionKeysByProvider(apiKeys) {
  const groqKeys = [];
  const nonGroqKeys = [];
  for (const key of apiKeys) {
    if (key.provider === 'groq') {
      groqKeys.push(key);
    } else {
      nonGroqKeys.push(key);
    }
  }
  return { groqKeys, nonGroqKeys };
}

// Phase 57: Split segments into chunks that each fit within MAX_PAYLOAD_BYTES for Groq
export function splitForGroqPayload(segments, src, tgt, context) {
  const chunks = [];
  let start = 0;

  while (start < segments.length) {
    let end = segments.length;

    while (end > start + 1) {
      const testSegments = segments.slice(start, end);
      const groqJson = getProviderJsonConfig('groq', testSegments.length);
      const testSystemPrompt = groqJson
        ? buildJsonSystemPrompt(context, src, tgt, testSegments.length)
        : buildSystemPrompt(context, src, tgt, testSegments.length);
      const testUserPrompt = groqJson
        ? buildJsonUserPrompt(testSegments)
        : testSegments
            .map((s, i) => `#${i + 1} ${formatTimestamp(s.startMs)} ${s.text}`)
            .join('\n');
      const estimatedBytes = (testSystemPrompt.length + testUserPrompt.length) * 2;

      if (estimatedBytes <= MAX_PAYLOAD_BYTES) break;
      end = Math.floor((start + end) / 2);
    }

    if (end === start) end = start + 1;
    chunks.push(segments.slice(start, end));
    start = end;
  }

  return chunks;
}
