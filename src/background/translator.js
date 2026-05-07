import { Logger } from '../shared/logger.js';
import { APIManager } from './api-manager.js';
import { Providers } from './providers.js';
import { HealthManager } from './health.js';
import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { MergeFixer } from './merge-fixer.js';
import '../shared/libs/browser-polyfill.js';

/**
 * translator.js — Multi-Provider LLM Translation Engine
 * 
 * High-level flow:
 * 1. Get list of valid API keys via APIManager.
 * 2. Split input texts into line-based batches (e.g. 40 lines).
 * 3. Use a system prompt to enforce line-count preservation.
 * 4. Implement a failover loop (Primary -> Backup...) per batch if needed.
 * 5. Verify results, fallback to original on persistent failure.
 */

// Critical: MAX_LINES_PER_BATCH is not the problem. STOP MENTIONING IT, STOP CHANGING IT, STOP TALKING ABOUT IT. STOP THINKING ABOUT IT.

const MAX_LINES_PER_BATCH = 50;
// Phase 54.1: Re-enable retry for transient failures (timeouts, 5xx)
const RETRY_ATTEMPTS = 2;
const RETRY_DELAYS_MS = [1000, 3000];
const RATE_LIMIT_MAX_RETRIES = 0;
const RATE_LIMIT_BASE_DELAY_MS = 0;
const INITIAL_BATCH_DELAY_MS = 50;
const ELEVATED_BATCH_DELAY_MS = 3000;

// Phase 47: Anti-deadlock constants
const MAX_CONTEXT_CHARS = 500;        // Cap context summary to prevent permanent 413
const MAX_RECURSION_DEPTH = 3;        // Stop infinite 413 splits
const KEY_COOLDOWN_MS = 10000;        // 10s per-key cooldown after 429
const keyCooldowns = new Map();       // apiKey -> cooldown expiry timestamp
const MAX_PAYLOAD_BYTES = 95000;      // ~95KB safe limit for Groq (most restrictive provider)
const RE_TRANSLATION_MAX_LINES = 12;  // max lines per re-translation call

// Phase 54.2: Request deduplication — track in-flight translations by videoId+lang
const inFlightRequests = new Map();

// Phase 55: Periodic cleanup for keyCooldowns to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of keyCooldowns) {
    if (now >= expiry) keyCooldowns.delete(key);
  }
}, 60000);

/**
 * Helper: Sleep for ms
 * Phase 38: Added to fix "wait is not defined" crash
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const NON_LATIN_TARGETS = new Set(['zh', 'ja', 'ko', 'ar', 'hi', 'th', 'ru', 'uk', 'el', 'he', 'bn']);

function sanitizeForeignScript(lines, tgt) {
  if (NON_LATIN_TARGETS.has(tgt)) return lines;
  return lines.map(line => {
    if (!line || typeof line !== 'string') return line;
    const cleaned = line
      .replace(/[Ѐ-ӿ一-鿿㐀-䶿　-〿぀-ゟ゠-ヿ가-힯]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned !== line) Logger.debug('Translator', `[SANITIZE] Stripped foreign script from line`);
    return cleaned;
  });
}

async function retranslateShiftedLines(segments, lines, pendingIndices, key, tabId, options) {
  const result = [...lines];
  const pending = pendingIndices.slice(0, RE_TRANSLATION_MAX_LINES);

  Logger.debug('Translator', `[RE-TRANSLATE] ${pending.length} shifted lines for ${key.provider}`);

  const miniSegments = pending.map(i => segments[i]);
  const context = options.context || '';
  const src = options.src || 'auto';
  const tgt = options.tgt || 'vi';

  const miniSystemPrompt = buildSystemPrompt(context, src, tgt, miniSegments.length);
  const miniUserPrompt = miniSegments.map((s, idx) =>
    `#${idx + 1} ${formatTimestamp(s.startMs)} ${s.text}`
  ).join('\n');

  const reOptions = { ...options, _skipMergeFix: true, isLastKey: true };
  const reResult = await tryKeyForBatch(key, miniSegments, miniSystemPrompt, miniUserPrompt, tabId, reOptions);

  if (reResult.status === 'success' && reResult.translated.length === pending.length) {
    for (let i = 0; i < pending.length; i++) {
      result[pending[i]] = reResult.translated[i];
    }
    Logger.debug('Translator', `[RE-TRANSLATE] Success: filled ${pending.length} lines`);
  } else {
    for (const idx of pending) {
      if (!result[idx]) result[idx] = segments[idx].text;
    }
    Logger.warn('Translator', `[RE-TRANSLATE] Failed, using original text as fallback`);
  }

  return result;
}

function getFirstAvailableKey(activeKeys) {
  const now = Date.now();
  for (const key of activeKeys) {
    const cooldownUntil = keyCooldowns.get(key.apiKey) || 0;
    if (now >= cooldownUntil) return key;
  }
  return activeKeys[0];
}

/**
 * Helper: Format milliseconds to [HH:MM:SS]
 */
function formatTimestamp(ms) {
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
function normalizeTs(tsString) {
  if (!tsString) return '';
  const parts = tsString.replace(/[\[\]]/g, '').split(':');
  if (parts.length !== 3) return tsString;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parseInt(parts[2], 10);
  return `${h}:${m}:${s}`;
}

/**
 * Main translation entry point.
 * @param {Array} segments - Array of { text, startMs }
 */
export async function translate(segments, sourceLang, targetLang, tabId = null, onBatchComplete = null, externalSignal = null) {
  if (!segments || segments.length === 0) return { translated: [], hadFallback: false };

  // Phase 55: Filter out invalid segments before translation
  segments = segments.filter(s => s && s.text && typeof s.startMs === 'number');
  if (segments.length === 0) return { translated: [], hadFallback: false };

  const src = sourceLang || 'auto';
  const tgt = targetLang || 'vi';

  // Phase 54.2: Dedup — return existing Promise if same video+lang is already translating
  const dedupKey = `${tabId}_${src}_${tgt}`;
  if (inFlightRequests.has(dedupKey)) {
    Logger.info('Translator', `[DEDUP] Returning existing in-flight request for ${dedupKey}`);
    return inFlightRequests.get(dedupKey);
  }

  const translatePromise = _translateInternal(segments, src, tgt, tabId, onBatchComplete, externalSignal);
  inFlightRequests.set(dedupKey, translatePromise);
  try {
    return await translatePromise;
  } finally {
    inFlightRequests.delete(dedupKey);
  }
}

async function _translateInternal(segments, src, tgt, tabId, onBatchComplete, externalSignal) {
  Logger.trace('Translator', `[CHECKPOINT 1] Starting translation: ${segments.length} segments`);
  sendDebugLog(tabId, `Initializing translation pipeline (${segments.length} lines)...`, '#2dd4bf', true);

  // Phase 47: Global abort controller — kills ALL in-flight fetches on timeout
  const globalAbort = new AbortController();

  // Phase 52.1: Wire external abort signal (port disconnect) to globalAbort
  if (externalSignal) {
    if (externalSignal.aborted) {
      globalAbort.abort();
    } else {
      externalSignal.addEventListener('abort', () => globalAbort.abort(), { once: true });
    }
  }

  // Internal 55s safety timeout to prevent hanging the whole background
  return await Promise.race([
    (async () => {
      try {
        Logger.trace('Translator', '[CHECKPOINT 2] Fetching valid keys...');
        const activeKeys = await APIManager.getValidKeys();

        if (!activeKeys || activeKeys.length === 0) {
          Logger.warn('Translator', '[CHECKPOINT 2.E] No valid API keys found.');
          return { success: false, failureReason: 'NO_API_KEYS' };
        }
        Logger.trace('Translator', `[CHECKPOINT 2.S] ${activeKeys.length} keys loaded.`);

        const finalResults = new Array(segments.length).fill(null);
        let globalHadFallback = false;
        const allFailuresMap = new Map();

        // Accumulated stats
        const stats = {
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          durationMs: 0,
          model: 'unknown',
          batchCount: 0
        };

        // Phase 45: Granular Log & Timeout for Context Summary
        Logger.trace('Translator', '[CHECKPOINT 3] Analyzing video context...');
        sendDebugLog(tabId, `Analyzing video context (Max 10s)...`, '#3b82f6');

        let context = "";
        try {
          context = await Promise.race([
            generateContextSummary(segments.map(s => s.text), activeKeys, tabId, src, tgt),
            new Promise((_, reject) => setTimeout(() => reject(new Error("ContextTimeout")), 10000))
          ]);
          Logger.trace('Translator', '[CHECKPOINT 3.S] Context summary ready.');
        } catch (e) {
          Logger.warn('Translator', `[CHECKPOINT 3.E] Context summary failed: ${e.message}`);
          context = "General video content.";
        }

        // Phase 47: Safety belt — cap context regardless of source
        if (context.length > MAX_CONTEXT_CHARS) {
          context = context.substring(0, MAX_CONTEXT_CHARS) + '...';
        }

        const startTimeFull = performance.now();
        let currentBatchDelay = INITIAL_BATCH_DELAY_MS;
        const totalLines = segments.length;
        let cursor = 0;
        let batchIndex = 0;
        let anyBatchSucceeded = false;
        let allFailures = [];

        Logger.trace('Translator', `[CHECKPOINT 4] Starting batch processing (${totalLines} lines)...`);

        while (cursor < totalLines) {
          const primaryKey = getFirstAvailableKey(activeKeys);
          const batchSize = primaryKey.maxLinesPerBatch || MAX_LINES_PER_BATCH;
          const batch = segments.slice(cursor, cursor + batchSize);

          batchIndex++;
          const batchStartTime = performance.now();
          Logger.trace('Translator', `[CHECKPOINT 5] Batch ${batchIndex}: lines ${cursor + 1}-${cursor + batch.length}/${totalLines} (size=${batchSize})...`);
          sendDebugLog(tabId, `Translating lines ${cursor + 1}-${cursor + batch.length} / ${totalLines}...`, '#a855f7');

          let result = await translateBatchWithFailover(batch, src, tgt, activeKeys, tabId, context, { signal: globalAbort.signal });

          const elapsed = ((performance.now() - batchStartTime) / 1000).toFixed(1);
          Logger.trace('Translator', `[BATCH_RESULT] success=${result.success}, hadFallback=${result.hadFallback}, translatedCount=${result.translated?.length}, sample=${result.translated?.[0]?.substring?.(0, 50)}`);

          if (result.success) {
            anyBatchSucceeded = true;
            Logger.trace('Translator', `[CHECKPOINT 5.S] Batch ${batchIndex} DONE in ${elapsed}s (lines ${cursor + 1}-${cursor + batch.length})`);
            sendDebugLog(tabId, `Lines ${cursor + 1}-${cursor + batch.length} OK (${elapsed}s)`, '#10b981');

            result.translated.forEach((t, j) => {
              if (cursor + j < finalResults.length) {
                finalResults[cursor + j] = t;
              }
            });

            if (result.stats) {
              stats.totalTokens += result.stats.usage?.totalTokens || 0;
              stats.promptTokens += result.stats.usage?.promptTokens || 0;
              stats.completionTokens += result.stats.usage?.completionTokens || 0;
              stats.model = result.stats.model;
            }
          } else {
            Logger.warn('Translator', `[CHECKPOINT 5.E] Batch ${batchIndex} FAILED (lines ${cursor + 1}-${cursor + batch.length}).`);
            batch.forEach((s, j) => {
              if (cursor + j < finalResults.length) {
                finalResults[cursor + j] = s.text;
              }
            });
            if (result.failures) allFailures.push(...result.failures);
            sendDebugLog(tabId, `Lines ${cursor + 1}-${cursor + batch.length} FAILED — using original text`, '#ef4444');
            saveDebugBatch({
              timestamp: new Date().toISOString(),
              provider: 'all', model: 'N/A',
              input: batch.map((s, i) => `#${i + 1} ${formatTimestamp(s.startMs)} ${s.text}`).join('\n'),
              output: null, systemPrompt: null,
              success: false, duration: elapsed + 's',
              failures: result.failures || []
            });
          }

          stats.batchCount++;
          if (result.hadFallback) globalHadFallback = true;

          if (typeof onBatchComplete === 'function' && result.success) {
            onBatchComplete(cursor, result.translated);
          }

          cursor += batch.length;

          if (cursor < totalLines) {
            const delay = result.hadRateLimit ? ELEVATED_BATCH_DELAY_MS : currentBatchDelay;
            await wait(delay);
          }
        }

        stats.durationMs = performance.now() - startTimeFull;
        Logger.info('Translator', '[CHECKPOINT 6] Translation pipeline complete.');

        return {
          success: anyBatchSucceeded,
          translated: finalResults,
          hadFallback: globalHadFallback,
          stats,
          failures: allFailures,
          ...(anyBatchSucceeded ? {} : { failureReason: 'ALL_BATCHES_FAILED' })
        };

      } catch (err) {
        Logger.error('Translator', `[CRITICAL_FAIL] ${err.message}`, { stack: err.stack });
        return { success: false, failureReason: 'INTERNAL_TRANSLATOR_ERROR', error: err.message };
      }
    })(),
    new Promise(resolve => setTimeout(() => {
      Logger.error('Translator', '[TIMEOUT_GUARD] Translation aborted after 100s safety limit.');
      globalAbort.abort(); // Phase 47: Kill all in-flight fetches
      resolve({ success: false, failureReason: 'TRANSLATOR_FORCE_TIMEOUT' });
    }, 100000))
  ]);
}

// Phase 57: Build the system prompt template (extracted for reuse by Groq waterfall)
// Never change UNFILTERED & FAITHFUL rule, it is the most important rule.
function buildSystemPrompt(context, src, tgt, segmentCount) {
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
function getProviderJsonConfig(providerId, segmentCount) {
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
                t: { type: 'STRING' }
              },
              required: ['n', 't']
            },
            minItems: segmentCount,
            maxItems: segmentCount
          }
        },
        required: ['lines']
      }
    };
  }

  if (provider.apiStyle === 'openai') {
    return { responseFormat: { type: 'json_object' } };
  }

  return null;
}

// Phase 58: JSON-in / JSON-out prompt — symmetric structure reduces merge errors
function buildJsonSystemPrompt(context, src, tgt, segmentCount) {
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
function buildJsonUserPrompt(segments) {
  const lines = segments.map((s, i) => ({ n: i, t: s.text }));
  return JSON.stringify({ lines });
}

// Phase 58: Parse JSON translation response, validate array length
function parseJsonResponse(responseText, segments) {
  let cleaned = cleanResponse(responseText);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const jsonMatch = cleaned.match(/\{[\s\S]*"lines"\s*:\s*\[[\s\S]*\]\s*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch (e2) { return null; }
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
  const result = segments.map(s => s.text);
  let validCount = 0;
  let hadReorder = false;

  const isObjectFormat = rawLines.length > 0 && typeof rawLines[0] === 'object' && rawLines[0] !== null && 't' in rawLines[0];

  if (isObjectFormat) {
    for (let i = 0; i < rawLines.length; i++) {
      const entry = rawLines[i];
      const idx = typeof entry.n === 'number' ? entry.n : -1;
      const text = typeof entry.t === 'string' ? entry.t.trim() : '';
      if (idx >= 0 && idx < expected && text) {
        result[idx] = text;
        validCount++;
        if (idx !== i) hadReorder = true;
      }
    }
    Logger.trace('Translator', `[JSON_PARSE] Object format: ${validCount}/${expected} placed by index`);
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
    Logger.warn('Translator', `[JSON_PARSE] Array length mismatch: expected=${expected} actual=${rawLines.length}`);
  }

  return { lines: result, validCount, hadMismatch: rawLines.length !== expected || hadReorder };
}

// Phase 57: Try a single API key for a batch. Returns structured status.
async function tryKeyForBatch(key, segments, systemPrompt, userPrompt, tabId, options = {}) {
  const { signal, onChunk, isLastKey = false } = options;

  if (signal && signal.aborted) {
    return { status: 'aborted' };
  }

  const cooldownUntil = keyCooldowns.get(key.apiKey) || 0;
  if (Date.now() < cooldownUntil) {
    Logger.debug('Translator', `Skipping ${key.provider} — cooldown active`);
    return { status: 'cooldown' };
  }

  Logger.trace('Translator', `Trying key: ${key.provider} (${key.model})`);

  // Phase 58: Detect JSON mode support for this provider
  const jsonConfig = getProviderJsonConfig(key.provider, segments.length);
  const useJsonMode = !!jsonConfig;

  let effectiveSystemPrompt = systemPrompt;
  let effectiveUserPrompt = userPrompt;
  let jsonApiOptions = {};

  if (useJsonMode) {
    const ctx = options.context || '';
    const src = options.src || 'auto';
    const tgt = options.tgt || 'vi';
    effectiveSystemPrompt = buildJsonSystemPrompt(ctx, src, tgt, segments.length);
    effectiveUserPrompt = buildJsonUserPrompt(segments);
    jsonApiOptions = { ...jsonConfig };
    Logger.trace('Translator', `[JSON_MODE] Enabled for ${key.provider} (${segments.length} segments)`);
  }

  try {
    const settings = await browser.storage.local.get(['yousub_streaming_mode']);
    const isStreaming = settings.yousub_streaming_mode === true && !useJsonMode;
    const estimatedOutputTokens = useJsonMode
      ? Math.min(segments.length * 130, 16384)
      : Math.min(segments.length * 100, 8192);

    let result;
    let duration;
    for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
      if (signal && signal.aborted) break;

      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1] || 3000;
        Logger.warn('Translator', `Retry ${attempt}/${RETRY_ATTEMPTS} for ${key.provider} after ${delay}ms...`);
        await wait(delay);
      }

      const attemptStart = performance.now();
      if (isStreaming) {
        result = await Providers.chatStream(
          key.provider, key.model, key.apiKey, effectiveUserPrompt,
          { systemPrompt: effectiveSystemPrompt, temperature: 0.1, maxTokens: estimatedOutputTokens, signal },
          (chunk) => { if (onChunk) onChunk(chunk); }
        );
      } else {
        result = await Providers.chat(
          key.provider, key.model, key.apiKey, effectiveUserPrompt,
          { systemPrompt: effectiveSystemPrompt, temperature: 0.1, maxTokens: estimatedOutputTokens, signal, ...jsonApiOptions }
        );
      }
      duration = performance.now() - attemptStart;

      const isTransient = !result.success && (
        (result.message && result.message.includes('Timeout')) ||
        (result.statusCode && result.statusCode >= 500)
      );
      if (!isTransient || attempt === RETRY_ATTEMPTS) break;
    }

    if (result.success && result.text) {
      saveDebugBatch({
        timestamp: new Date().toISOString(),
        provider: key.provider, model: key.model,
        input: effectiveUserPrompt, output: result.text, systemPrompt: effectiveSystemPrompt,
        success: true, duration: duration.toFixed(0) + 'ms'
      });

      // Phase 58: Try JSON parsing first when JSON mode was used
      if (useJsonMode) {
        const jsonResult = parseJsonResponse(result.text, segments);
        if (jsonResult) {
          Logger.debug('Translator', `[JSON_MODE] Parsed ${jsonResult.validCount}/${segments.length} lines from ${key.provider}`);
          const threshold = Math.max(1, Math.floor(segments.length * 0.1));
          if (jsonResult.validCount >= threshold || isLastKey) {
            HealthManager.report(key.provider, key.apiKey, true, duration);
            let fixedLines;
            if (options._skipMergeFix) {
              fixedLines = jsonResult.lines;
            } else {
              const fixResult = await MergeFixer.fix(segments, jsonResult.lines, options.src || 'auto', options.tgt || 'vi');
              fixedLines = fixResult.lines;
              const pendingCount = fixResult.pendingIndices.length;
              if (pendingCount > 0) {
                Logger.info('Translator', `[MERGE_FIX] Shift detected: ${pendingCount} lines pending re-translation (${key.provider})`);
                sendDebugLog(tabId, `MergeFixer: ${pendingCount} shifted lines, re-translating...`, '#f59e0b');
                fixedLines = await retranslateShiftedLines(segments, fixedLines, fixResult.pendingIndices, key, tabId, options);
                sendDebugLog(tabId, `MergeFixer: Re-translation done (${pendingCount} lines filled)`, '#10b981');
              } else {
                Logger.trace('Translator', `[MERGE_FIX] Clean batch - no merges (${segments.length} lines, ${key.provider})`);
              }
            }
            const sanitizedLines = sanitizeForeignScript(fixedLines, options.tgt || 'vi');
            return {
              status: 'success',
              translated: sanitizedLines,
              hadFallback: jsonResult.hadMismatch || jsonResult.validCount < segments.length,
              hadRateLimit: false,
              stats: { usage: result.usage, model: result.model }
            };
          }
          Logger.warn('Translator', `[JSON_MODE] Quality low (${jsonResult.validCount}/${segments.length}). Trying text parser.`);
        } else {
          Logger.warn('Translator', `[JSON_MODE] JSON parse failed for ${key.provider}. Trying text parser.`);
        }
      }

      // Text-based parser (timestamp regex) — primary for non-JSON, fallback for JSON failures
      let cleanedText = cleanResponse(result.text);
      cleanedText = cleanedText.replace(/#\d+\s+(?=\[)/g, '');

      const tagRegex = /\[(\d{1,2}:\d{1,2}:\d{1,2})\]/g;
      const parsedQueues = {};
      let pendingTags = [];
      let lastEnd = 0;
      let match;

      while ((match = tagRegex.exec(cleanedText)) !== null) {
        const textBetween = cleanedText.substring(lastEnd, match.index).trim();
        if (textBetween && pendingTags.length > 0) {
          pendingTags.forEach(tag => {
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
        pendingTags.forEach(tag => {
          const norm = normalizeTs(tag);
          if (!parsedQueues[norm]) parsedQueues[norm] = [];
          parsedQueues[norm].push(finalContent);
        });
      }

      let validLinesCount = 0;
      const resultLines = segments.map(s => {
        const rawTs = formatTimestamp(s.startMs);
        const normTs = normalizeTs(rawTs);
        if (parsedQueues[normTs] && parsedQueues[normTs].length > 0) {
          validLinesCount++;
          return parsedQueues[normTs].shift();
        }
        return s.text;
      });

      const threshold = Math.max(1, Math.floor(segments.length * 0.1));

      if (validLinesCount === 0) {
        Logger.warn('Translator', `Parser failure with ${key.provider}. (Matched 0/${segments.length})`);
        HealthManager.report(key.provider, key.apiKey, false, duration);
        return { status: 'parse_fail' };
      }

      Logger.debug('Translator', `Parser outcome: ${validLinesCount}/${segments.length} matched via ${key.provider}.`);

      if (validLinesCount >= threshold || isLastKey) {
        HealthManager.report(key.provider, key.apiKey, true, duration);
        let fixedLines;
        if (options._skipMergeFix) {
          fixedLines = resultLines;
        } else {
          const fixResult = await MergeFixer.fix(segments, resultLines, options.src || 'auto', options.tgt || 'vi');
          fixedLines = fixResult.lines;
          const pendingCount = fixResult.pendingIndices.length;
          if (pendingCount > 0) {
            Logger.info('Translator', `[MERGE_FIX] Shift detected: ${pendingCount} lines pending re-translation (${key.provider})`);
            sendDebugLog(tabId, `MergeFixer: ${pendingCount} shifted lines, re-translating...`, '#f59e0b');
            fixedLines = await retranslateShiftedLines(segments, fixedLines, fixResult.pendingIndices, key, tabId, options);
            sendDebugLog(tabId, `MergeFixer: Re-translation done (${pendingCount} lines filled)`, '#10b981');
          } else {
            Logger.trace('Translator', `[MERGE_FIX] Clean batch - no merges (${segments.length} lines, ${key.provider})`);
          }
        }
        const sanitizedLines = sanitizeForeignScript(fixedLines, options.tgt || 'vi');
        return {
          status: 'success',
          translated: sanitizedLines,
          hadFallback: validLinesCount < segments.length,
          hadRateLimit: false,
          stats: { usage: result.usage, model: result.model }
        };
      } else {
        Logger.warn('Translator', `Quality mismatch (${validLinesCount}/${segments.length}). Failing over.`);
        HealthManager.report(key.provider, key.apiKey, false, duration);
        return { status: 'quality_fail' };
      }
    } else if (result.statusCode === 413) {
      Logger.warn('Translator', `413 from ${key.provider} (segs=${segments.length}).`);
      HealthManager.report(key.provider, key.apiKey, false, duration);
      return { status: '413', message: result.message };
    } else if (result.statusCode === 429) {
      const cooldown = Math.max(KEY_COOLDOWN_MS, result.retryAfterMs || 0);
      keyCooldowns.set(key.apiKey, Date.now() + cooldown);
      Logger.warn('Translator', `Rate limited (429) by ${key.provider}. Cooldown ${cooldown}ms.`);
      HealthManager.report(key.provider, key.apiKey, false, duration, { isTransient: true });
      return { status: '429', cooldown, message: result.message };
    } else {
      Logger.warn('Translator', `${key.provider} returned error: ${result.message}`);
      HealthManager.report(key.provider, key.apiKey, false, duration);
      return { status: 'error', message: result.message };
    }
  } catch (err) {
    Logger.error('Translator', `Exception with ${key.provider}: ${err.message}`);
    return { status: 'exception', message: err.message };
  }
}

// Phase 57: Partition keys into Groq and non-Groq groups (preserves ordering)
function partitionKeysByProvider(apiKeys) {
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
function splitForGroqPayload(segments, src, tgt, context) {
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
        : testSegments.map((s, i) => `#${i + 1} ${formatTimestamp(s.startMs)} ${s.text}`).join('\n');
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

// Phase 57: Sticky-until-fail waterfall across Groq keys
async function processGroqWaterfall(chunks, groqKeys, src, tgt, tabId, context, options = {}) {
  const { signal } = options;
  const results = new Array(chunks.length).fill(null);
  let currentKeyIndex = 0;
  let hadRateLimit = false;
  const allStats = { usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 }, model: 'unknown' };
  const unprocessedChunks = [];
  const failures = [];

  for (let i = 0; i < chunks.length; i++) {
    if (signal && signal.aborted) {
      for (let j = i; j < chunks.length; j++) unprocessedChunks.push({ index: j, segments: chunks[j] });
      break;
    }

    const chunkSegments = chunks[i];
    const systemPrompt = buildSystemPrompt(context, src, tgt, chunkSegments.length);
    const userPrompt = chunkSegments.map((s, i) => `#${i + 1} ${formatTimestamp(s.startMs)} ${s.text}`).join('\n');
    let chunkDone = false;

    while (currentKeyIndex < groqKeys.length && !chunkDone) {
      if (signal && signal.aborted) break;

      const key = groqKeys[currentKeyIndex];
      const result = await tryKeyForBatch(key, chunkSegments, systemPrompt, userPrompt, tabId, {
        signal, onChunk: options.onChunk, isLastKey: currentKeyIndex === groqKeys.length - 1,
        context, src, tgt
      });

      switch (result.status) {
        case 'success':
          results[i] = result;
          chunkDone = true;
          allStats.usage.totalTokens += result.stats?.usage?.totalTokens || 0;
          allStats.usage.promptTokens += result.stats?.usage?.promptTokens || 0;
          allStats.usage.completionTokens += result.stats?.usage?.completionTokens || 0;
          allStats.model = result.stats?.model || allStats.model;
          break;
        case '429':
          hadRateLimit = true;
          failures.push({ provider: key.provider, model: key.model, status: 429, message: result.message });
          currentKeyIndex++;
          break;
        case '413':
          failures.push({ provider: key.provider, model: key.model, status: 413, message: result.message });
          currentKeyIndex = groqKeys.length;
          break;
        case 'cooldown':
          currentKeyIndex++;
          break;
        case 'aborted':
          currentKeyIndex = groqKeys.length;
          break;
        default:
          failures.push({ provider: key.provider, model: key.model, message: result.message || result.status });
          currentKeyIndex++;
          break;
      }
    }

    if (!chunkDone) {
      unprocessedChunks.push({ index: i, segments: chunks[i] });
    }
  }

  return { results, unprocessedChunks, hadRateLimit, stats: allStats, failures };
}

// Phase 57: Fallback to non-Groq providers (no payload splitting needed)
async function fallbackToNonGroq(segments, nonGroqKeys, src, tgt, tabId, context, options = {}) {
  const { signal } = options;
  const systemPrompt = buildSystemPrompt(context, src, tgt, segments.length);
  const userPrompt = segments.map((s, i) => `#${i + 1} ${formatTimestamp(s.startMs)} ${s.text}`).join('\n');
  const failures = [];

  for (let k = 0; k < nonGroqKeys.length; k++) {
    if (signal && signal.aborted) break;
    const key = nonGroqKeys[k];
    const result = await tryKeyForBatch(key, segments, systemPrompt, userPrompt, tabId, {
      signal, onChunk: options.onChunk, isLastKey: k === nonGroqKeys.length - 1,
      context, src, tgt
    });
    if (result.status === 'success') {
      return { success: true, translated: result.translated, hadFallback: result.hadFallback, stats: result.stats };
    }
    if (result.status === 'aborted') break;
    if (result.status !== 'cooldown') {
      failures.push({ provider: key.provider, model: key.model, status: result.status === '429' ? 429 : (result.status === '413' ? 413 : 0), message: result.message });
    }
  }

  return { success: false, translated: segments.map(s => s.text), hadFallback: true, stats: {}, failures };
}

/**
 * Process a single batch of lines, trying different providers on failure.
 * Phase 57: Groq-aware routing with waterfall distribution.
 */
async function translateBatchWithFailover(segments, src, tgt, apiKeys, tabId, context, options = {}) {
  const { startKeyIndex = 0, depth = 0, signal } = options;

  if (signal && signal.aborted) {
    return { translated: segments.map(s => s.text), hadFallback: true, hadRateLimit: false };
  }

  const systemPrompt = buildSystemPrompt(context, src, tgt, segments.length);
  const userPrompt = segments.map((s, i) => `#${i + 1} ${formatTimestamp(s.startMs)} ${s.text}`).join('\n');
  const estimatedBytes = (systemPrompt.length + userPrompt.length) * 2;

  // Phase 57: Groq-aware pre-flight — split and waterfall across Groq keys
  const { groqKeys, nonGroqKeys } = partitionKeysByProvider(apiKeys);
  const payloadExceedsGroq = estimatedBytes > MAX_PAYLOAD_BYTES;

  if (groqKeys.length > 0 && payloadExceedsGroq && segments.length > 2 && depth < MAX_RECURSION_DEPTH) {
    Logger.trace('Translator', `Payload ~${Math.round(estimatedBytes / 1024)}KB exceeds Groq limit. Groq waterfall with ${groqKeys.length} keys.`);

    const chunks = splitForGroqPayload(segments, src, tgt, context);
    Logger.trace('Translator', `Split into ${chunks.length} Groq-sized chunks.`);

    const { results, unprocessedChunks, hadRateLimit, stats, failures: groqFailures } =
      await processGroqWaterfall(chunks, groqKeys, src, tgt, tabId, context, { signal, onChunk: options.onChunk });

    let fallbackFailures = [];
    if (unprocessedChunks.length > 0 && nonGroqKeys.length > 0) {
      Logger.trace('Translator', `${unprocessedChunks.length} chunks remaining. Falling back to non-Groq providers.`);
      const remainingSegments = [];
      const indexMap = [];
      for (const { index, segments: segs } of unprocessedChunks) {
        indexMap.push({ chunkIndex: index, baseOffset: remainingSegments.length, count: segs.length });
        remainingSegments.push(...segs);
      }

      const fallback = await fallbackToNonGroq(remainingSegments, nonGroqKeys, src, tgt, tabId, context, { signal, onChunk: options.onChunk });
      fallbackFailures = fallback.failures || [];

      if (fallback.success) {
        for (const { chunkIndex, baseOffset, count } of indexMap) {
          results[chunkIndex] = {
            status: 'success',
            translated: fallback.translated.slice(baseOffset, baseOffset + count),
            hadFallback: fallback.hadFallback,
            stats: fallback.stats
          };
        }
      }
      stats.usage.totalTokens += fallback.stats?.usage?.totalTokens || 0;
      stats.usage.promptTokens += fallback.stats?.usage?.promptTokens || 0;
      stats.usage.completionTokens += fallback.stats?.usage?.completionTokens || 0;
    }

    const finalTranslated = [];
    let allSuccess = true;
    let anyFallback = false;

    for (let i = 0; i < chunks.length; i++) {
      if (results[i] && results[i].status === 'success') {
        finalTranslated.push(...results[i].translated);
        if (results[i].hadFallback) anyFallback = true;
      } else {
        finalTranslated.push(...chunks[i].map(s => s.text));
        allSuccess = false;
        anyFallback = true;
      }
    }

    const mergedFailures = [...(groqFailures || []), ...fallbackFailures];
    return {
      success: allSuccess,
      translated: finalTranslated,
      hadFallback: anyFallback,
      hadRateLimit: hadRateLimit,
      stats,
      failures: mergedFailures
    };
  }

  // Standard sequential failover (payload fits all providers, or no Groq keys)
  const failures = [];
  let hadRateLimit = false;
  let had413 = false;

  for (let k = startKeyIndex; k < apiKeys.length; k++) {
    if (signal && signal.aborted) {
      return { translated: segments.map(s => s.text), hadFallback: true, hadRateLimit: false };
    }

    const key = apiKeys[k];
    const result = await tryKeyForBatch(key, segments, systemPrompt, userPrompt, tabId, {
      signal, onChunk: options.onChunk, isLastKey: k === apiKeys.length - 1,
      context, src, tgt
    });

    switch (result.status) {
      case 'success':
        return { success: true, translated: result.translated, hadFallback: result.hadFallback, hadRateLimit: false, stats: result.stats };
      case '429':
        hadRateLimit = true;
        failures.push({ provider: key.provider, model: key.model, status: 429, message: result.message });
        break;
      case '413':
        had413 = true;
        failures.push({ provider: key.provider, model: key.model, status: 413, message: result.message });
        break;
      case 'aborted':
        return { translated: segments.map(s => s.text), hadFallback: true, hadRateLimit: false };
      default:
        failures.push({ provider: key.provider, model: key.model, message: result.message || result.status });
        break;
    }
  }

  // Safety net: all keys exhausted with 413 — recursive split
  if (had413 && segments.length > 2 && depth < MAX_RECURSION_DEPTH) {
    Logger.warn('Translator', `All keys returned 413. Splitting ${segments.length} segments at depth=${depth}.`);
    const mid = Math.floor(segments.length / 2);
    const subContext = depth > 2 ? '' : context;

    const res1 = await translateBatchWithFailover(
      segments.slice(0, mid), src, tgt, apiKeys, tabId, subContext,
      { startKeyIndex: 0, depth: depth + 1, signal }
    );
    const res2 = await translateBatchWithFailover(
      segments.slice(mid), src, tgt, apiKeys, tabId, subContext,
      { startKeyIndex: 0, depth: depth + 1, signal }
    );

    return {
      success: res1.success && res2.success,
      translated: [...res1.translated, ...res2.translated],
      hadFallback: res1.hadFallback || res2.hadFallback,
      hadRateLimit: res1.hadRateLimit || res2.hadRateLimit,
      stats: {
        usage: {
          totalTokens: (res1.stats?.usage?.totalTokens || 0) + (res2.stats?.usage?.totalTokens || 0),
          promptTokens: (res1.stats?.usage?.promptTokens || 0) + (res2.stats?.usage?.promptTokens || 0),
          completionTokens: (res1.stats?.usage?.completionTokens || 0) + (res2.stats?.usage?.completionTokens || 0),
        },
        model: res1.stats?.model || res2.stats?.model
      },
      failures: [...(res1.failures || []), ...(res2.failures || [])]
    };
  }

  if (had413 && segments.length <= 2 && depth < MAX_RECURSION_DEPTH && context) {
    Logger.warn('Translator', `413 with ${segments.length} segments. Stripping context for final retry.`);
    return await translateBatchWithFailover(
      segments, src, tgt, apiKeys, tabId, '',
      { startKeyIndex: 0, depth: depth + 1, signal }
    );
  }

  return { success: false, translated: segments.map(s => s.text), hadFallback: true, hadRateLimit, failures };
}

/**
 * Generate a context summary of the video based on the full transcript.
 */
async function generateContextSummary(texts, apiKeys, tabId, src, tgt) {
  // Phase 37: Sample only the first 100 lines for context to save tokens and stay within TPM
  const sampleTexts = texts.slice(0, 100);
  const fullTranscript = sampleTexts.join('\n');
  const summaryPrompt = `You are a professional content analyzer.
Below is the FULL transcript of a video in ${src}. 
Provide a about 200 words summary in English of the video's topic, context, and key terms to help a translator keep consistency (especially for pronouns and specialized vocabulary). 
Return ONLY the summary.`;

  sendDebugLog(tabId, "Analyzing FULL transcript for video context...", "#3b82f6");

  for (const key of apiKeys) {
    try {
      // Phase 57: Per-provider payload awareness — truncate for Groq if too large
      let transcript = fullTranscript;
      if (key.provider === 'groq') {
        const estimatedBytes = (summaryPrompt.length + transcript.length) * 2;
        if (estimatedBytes > MAX_PAYLOAD_BYTES) {
          const maxChars = Math.floor(MAX_PAYLOAD_BYTES / 2) - summaryPrompt.length - 200;
          transcript = transcript.substring(0, Math.max(1000, maxChars));
          Logger.trace('Translator', `Truncated transcript to ${transcript.length} chars for Groq context summary`);
        }
      }

      const result = await Providers.chat(key.provider, key.model, key.apiKey, transcript, {
        systemPrompt: summaryPrompt,
        temperature: 0.3
      });

      if (result.success && result.text) {
        let summary = result.text.trim();
        if (summary.length > MAX_CONTEXT_CHARS) {
          summary = summary.substring(0, MAX_CONTEXT_CHARS) + '...';
        }
        Logger.info('Translator', 'Context summary generated: ' + summary.substring(0, 100) + '...');
        return summary;
      }

      if (result.statusCode === 429) {
        Logger.trace('Translator', `Context summary: 429 from ${key.provider}, trying next...`);
      }
    } catch (e) {
      Logger.warn('Translator', `Failed to generate summary with ${key.provider}`);
    }
  }
  return "General video content.";
}

/**
 * Noise reduction: Strip common LLM artifacts to extract raw subtitle lines.
 */
function cleanResponse(text) {
  if (!text) return "";

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
    /^Please see below.*?\n/i
  ];

  noisePatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, '').trim();
  });

  return cleaned;
}

/**
 * Phase 51: Save batch debug info to local storage (max 20)
 */
async function saveDebugBatch(entry) {
  try {
    const data = await browser.storage.local.get('yousub_debug_history');
    let history = data.yousub_debug_history || [];
    history.unshift(entry);
    if (history.length > 20) {
      history = history.slice(0, 20);
    }
    await browser.storage.local.set({ yousub_debug_history: history });
  } catch (e) {
    console.error('[YouSub] Failed to save debug batch:', e);
  }
}

/**
 * Helper: Forward important debug info directly to content script's console
 */
function sendDebugLog(tabId, msg, color = '#cbd5e1', bold = false) {
  if (!tabId) return;
  try {
    browser.tabs.sendMessage(tabId, {
      type: 'YOUSUB_DEBUG_LOG',
      msg,
      color,
      bold
    }).catch(() => { }); // Catch if tab is closed
  } catch (e) { }
}
