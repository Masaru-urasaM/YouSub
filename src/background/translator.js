import { Logger } from '../shared/logger.js';
import { APIManager } from './api-manager.js';
import { Providers } from './providers.js';
import { HealthManager } from './health.js';
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
const RETRY_ATTEMPTS = 0;
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

/**
 * Helper: Sleep for ms
 * Phase 38: Added to fix "wait is not defined" crash
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
export async function translate(segments, sourceLang, targetLang, tabId = null, onBatchComplete = null) {
  if (!segments || segments.length === 0) return { translated: [], hadFallback: false };

  const src = sourceLang || 'auto';
  const tgt = targetLang || 'vi';

  Logger.error('Translator', `[CHECKPOINT 1] Starting translation: ${segments.length} segments`);
  sendDebugLog(tabId, `Initializing translation pipeline (${segments.length} lines)...`, '#2dd4bf', true);

  // Phase 47: Global abort controller — kills ALL in-flight fetches on timeout
  const globalAbort = new AbortController();

  // Internal 55s safety timeout to prevent hanging the whole background
  return await Promise.race([
    (async () => {
      try {
        Logger.error('Translator', '[CHECKPOINT 2] Fetching valid keys...');
        const activeKeys = await APIManager.getValidKeys();

        if (!activeKeys || activeKeys.length === 0) {
          Logger.error('Translator', '[CHECKPOINT 2.E] No valid API keys found.');
          return { success: false, failureReason: 'NO_API_KEYS' };
        }
        Logger.error('Translator', `[CHECKPOINT 2.S] ${activeKeys.length} keys loaded.`);

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
        Logger.error('Translator', '[CHECKPOINT 3] Analyzing video context...');
        sendDebugLog(tabId, `Analyzing video context (Max 10s)...`, '#3b82f6');

        let context = "";
        try {
          context = await Promise.race([
            generateContextSummary(segments.map(s => s.text), activeKeys, tabId, src, tgt),
            new Promise((_, reject) => setTimeout(() => reject(new Error("ContextTimeout")), 10000))
          ]);
          Logger.error('Translator', '[CHECKPOINT 3.S] Context summary ready.');
        } catch (e) {
          Logger.error('Translator', `[CHECKPOINT 3.E] Context summary failed: ${e.message}`);
          context = "General video content.";
        }

        // Phase 47: Safety belt — cap context regardless of source
        if (context.length > MAX_CONTEXT_CHARS) {
          context = context.substring(0, MAX_CONTEXT_CHARS) + '...';
        }

        const startTimeFull = performance.now();
        let currentBatchDelay = INITIAL_BATCH_DELAY_MS;
        const totalBatches = Math.ceil(segments.length / MAX_LINES_PER_BATCH);

        Logger.error('Translator', `[CHECKPOINT 4] Starting batch processing (${totalBatches} batches)...`);

        // Process in batches
        for (let i = 0; i < totalBatches; i++) {
          const startIndex = i * MAX_LINES_PER_BATCH;
          const batch = segments.slice(startIndex, startIndex + MAX_LINES_PER_BATCH);

          const batchStartTime = performance.now();
          Logger.error('Translator', `[CHECKPOINT 5] Batch ${i + 1}/${totalBatches} processing...`);
          sendDebugLog(tabId, `Processing batch ${i + 1}/${totalBatches}...`, '#a855f7');

          let result = await translateBatchWithFailover(batch, src, tgt, activeKeys, tabId, context, { signal: globalAbort.signal });

          const elapsed = ((performance.now() - batchStartTime) / 1000).toFixed(1);
          // Phase 47: Diagnostic — log batch result shape for debugging
          Logger.error('Translator', `[BATCH_RESULT] success=${result.success}, hadFallback=${result.hadFallback}, translatedCount=${result.translated?.length}, sample=${result.translated?.[0]?.substring?.(0, 50)}`);

          if (result.success) {
            Logger.error('Translator', `[CHECKPOINT 5.S] Batch ${i + 1}/${totalBatches} DONE in ${elapsed}s`);
            sendDebugLog(tabId, `Batch ${i + 1}/${totalBatches} OK (${elapsed}s)`, '#10b981');

            result.translated.forEach((t, j) => {
              if (startIndex + j < finalResults.length) {
                finalResults[startIndex + j] = t;
              }
            });

            if (result.stats) {
              stats.totalTokens += result.stats.usage?.totalTokens || 0;
              stats.promptTokens += result.stats.usage?.promptTokens || 0;
              stats.completionTokens += result.stats.usage?.completionTokens || 0;
              stats.model = result.stats.model;
            }
          } else {
            Logger.error('Translator', `[CHECKPOINT 5.E] Batch ${i + 1} FAILED.`);
            // Fill with original text if fallback happened
            batch.forEach((s, j) => {
              if (startIndex + j < finalResults.length) {
                finalResults[startIndex + j] = s.text;
              }
            });
          }

          stats.batchCount++;
          if (result.hadFallback) globalHadFallback = true;

          if (typeof onBatchComplete === 'function') {
            onBatchComplete(startIndex, result.translated);
          }

          // Delay between batches
          if (i + 1 < totalBatches) {
            const delay = result.hadRateLimit ? ELEVATED_BATCH_DELAY_MS : currentBatchDelay;
            await wait(delay);
          }
        }

        stats.durationMs = performance.now() - startTimeFull;
        Logger.info('Translator', '[CHECKPOINT 6] Translation pipeline complete.');

        return {
          success: true,
          translated: finalResults,
          hadFallback: globalHadFallback,
          stats
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

/**
 * Process a single batch of lines, trying different providers on failure.
 */
async function translateBatchWithFailover(segments, src, tgt, apiKeys, tabId, context, options = {}) {
  const { startKeyIndex = 0, depth = 0, signal } = options;

  // Phase 47: Early exit if globally aborted (55s timeout fired)
  if (signal && signal.aborted) {
    return { translated: segments.map(s => s.text), hadFallback: true, hadRateLimit: false };
  }

  const systemPrompt = `You are a professional subtitle translator for youtube. The input is a list of subtitle lines with timestamps of youtube's auto-generated subtitles.
VIDEO CONTEXT:
${context}

Translate the following subtitle lines from ${src} to ${tgt}.
CRITICAL RULES:
1. PRESERVE THE LINE COUNT EXACTLY. Return exactly ${segments.length} lines, with exact format as the rules below.
2. REQUIRED FORMAT: [HH:MM:SS] {Translated Text}
   Example: [00:00:12] Hello, [00:00:13] Good morning
3. THE TIMESTAMP IS THE POINTER. I use timestamp to sync subtitles. So you must return the same timestamp for each translated line as provided in the input.
4. The input has a timestamp, the output MUST have a corresponding line with the same timestamp. If a sentence spans multiple lines in the input, you MUST split the translation into multiple lines corresponding to each timestamp. Do not merge timestamps.
5. Return ONLY the translated lines. No explanations. The translated text must be in ${tgt}.
6. UNFILTERED & FAITHFUL: Preserve all profanity, slang, and offensive language as-is. Do NOT censor, refine, or "beautify" the translation. If the source is vulgar, the translation MUST be equally vulgar in ${tgt}. 100% honesty to the source is mandatory, even if it is a swear word, slur, curse, profanity, or any other offensive, criminal, illegal language.
`; // Never change UNFILTERED & FAITHFUL rule, it is the most important rule.

  const userPrompt = segments.map(s => `${formatTimestamp(s.startMs)} ${s.text}`).join('\n');

  // Phase 47: Pre-flight payload size check — split BEFORE calling API, not after 413
  const estimatedBytes = (systemPrompt.length + userPrompt.length) * 2; // ×2 for JSON overhead + UTF-8
  if (estimatedBytes > MAX_PAYLOAD_BYTES && segments.length > 2 && depth < MAX_RECURSION_DEPTH) {
    Logger.warn('Translator', `Pre-flight: payload ~${Math.round(estimatedBytes / 1024)}KB exceeds ${Math.round(MAX_PAYLOAD_BYTES / 1024)}KB limit. Auto-splitting ${segments.length} segments.`);
    const mid = Math.floor(segments.length / 2);
    const subContext = depth > 2 ? '' : context; // Preserve context unless very deep split

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
      }
    };
  }

  const failures = [];
  let hadRateLimit = false;
  let had413 = false; // Phase 47: Track if ANY key returned 413 (payload too large for that provider)

  for (let k = startKeyIndex; k < apiKeys.length; k++) {
    // Phase 47: Abort check at each iteration
    if (signal && signal.aborted) {
      return { translated: segments.map(s => s.text), hadFallback: true, hadRateLimit: false };
    }

    const key = apiKeys[k];

    // Phase 47: Skip keys in cooldown (429 protection)
    const cooldownUntil = keyCooldowns.get(key.apiKey) || 0;
    if (Date.now() < cooldownUntil) {
      Logger.debug('Translator', `Skipping key ${k + 1} (${key.provider}) — cooldown active`);
      continue;
    }

    const startTime = performance.now();
    Logger.error('Translator', `[CHECKPOINT 5.1] Trying key ${k + 1}/${apiKeys.length}: ${key.provider} (${key.model})`);

    try {
      // Phase 50.2: Check for streaming mode
      const settings = await browser.storage.local.get(['yousub_streaming_mode']);
      const isStreaming = settings.yousub_streaming_mode === true;

      // Phase 47: Calculate reasonable maxTokens based on actual content size.
      const estimatedOutputTokens = Math.min(segments.length * 100, 8192);

      let result;
      if (isStreaming) {
        result = await Providers.chatStream(
          key.provider,
          key.model,
          key.apiKey,
          userPrompt,
          {
            systemPrompt,
            temperature: 0.1,
            maxTokens: estimatedOutputTokens,
            signal
          },
          (chunk) => {
            if (options.onChunk) options.onChunk(chunk);
          }
        );
      } else {
        result = await Providers.chat(
          key.provider,
          key.model,
          key.apiKey,
          userPrompt,
          {
            systemPrompt,
            temperature: 0.1,
            maxTokens: estimatedOutputTokens,
            signal
          }
        );
      }

      const duration = performance.now() - startTime;

      if (result.success && result.text) {
        const cleanedText = cleanResponse(result.text);

        // Phase 51: Save to Debug History
        saveDebugBatch({
          timestamp: new Date().toISOString(),
          provider: key.provider,
          model: key.model,
          input: userPrompt,
          output: result.text,
          systemPrompt: systemPrompt,
          success: true,
          duration: duration.toFixed(0) + 'ms'
        });

        // [PARSING LOGIC - START]
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
        let propagationCount = 0;
        let lastTranslation = null;

        const resultLines = segments.map(s => {
          const rawTs = formatTimestamp(s.startMs);
          const normTs = normalizeTs(rawTs);

          if (parsedQueues[normTs] && parsedQueues[normTs].length > 0) {
            validLinesCount++;
            return parsedQueues[normTs].shift();
          }
          return s.text;
        });

        const threshold = Math.max(1, Math.floor(segments.length * 0.1)); // 10% threshold

        if (validLinesCount === 0) {
          Logger.warn('Translator', `Parser failure with ${key.provider}. (Matched 0/${segments.length})`);
          HealthManager.report(key.provider, key.apiKey, false, duration);
          continue;
        }

        Logger.debug('Translator', `Parser outcome: ${validLinesCount}/${segments.length} segments matched using ${key.provider}.`);

        if (validLinesCount >= threshold || k === apiKeys.length - 1) {
          HealthManager.report(key.provider, key.apiKey, true, duration);
          return {
            success: true,
            translated: resultLines,
            hadFallback: validLinesCount < segments.length,
            hadRateLimit: false,
            stats: { usage: result.usage, model: result.model }
          };
        } else {
          Logger.warn('Translator', `Quality mismatch (${validLinesCount}/${segments.length}). Failing over.`);
          HealthManager.report(key.provider, key.apiKey, false, duration);
          continue;
        }
      } else if (result.statusCode === 413) {
        // Phase 47: On 413, DON'T split immediately — try other keys first.
        // Different providers have different payload limits (Gemini >> Groq).
        Logger.warn('Translator', `413 from ${key.provider} (depth=${depth}, segs=${segments.length}). Trying next key...`);
        had413 = true;
        continue;
      } else if (result.statusCode === 429) {
        // Phase 47: Set cooldown using Retry-After header if available
        hadRateLimit = true;
        const cooldown = Math.max(KEY_COOLDOWN_MS, result.retryAfterMs || 0);
        keyCooldowns.set(key.apiKey, Date.now() + cooldown);
        Logger.warn('Translator', `Rate limited (429) by ${key.provider}. Cooldown ${cooldown}ms.`);
        HealthManager.report(key.provider, key.apiKey, false, duration, { isTransient: true });
        continue;
      } else {
        Logger.warn('Translator', `${key.provider} returned error: ${result.message}`);
        HealthManager.report(key.provider, key.apiKey, false, duration);
        continue;
      }
    } catch (err) {
      Logger.error('Translator', `Exception with ${key.provider}: ${err.message}`);
      continue;
    }
  }

  // Phase 47: All keys exhausted. If we had 413s, try splitting the batch.
  if (had413 && segments.length > 2 && depth < MAX_RECURSION_DEPTH) {
    Logger.error('Translator', `All keys returned 413. Splitting ${segments.length} segments at depth=${depth}.`);
    const mid = Math.floor(segments.length / 2);
    const part1 = segments.slice(0, mid);
    const part2 = segments.slice(mid);

    // Strip context on splits to reduce payload
    const subContext = depth > 2 ? '' : context;

    const res1 = await translateBatchWithFailover(
      part1, src, tgt, apiKeys, tabId, subContext,
      { startKeyIndex: 0, depth: depth + 1, signal }
    );
    const res2 = await translateBatchWithFailover(
      part2, src, tgt, apiKeys, tabId, subContext,
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
      }
    };
  }

  // Phase 47: If had 413 with very small batch, strip context for one more try
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
      const result = await Providers.chat(key.provider, key.model, key.apiKey, fullTranscript, {
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
