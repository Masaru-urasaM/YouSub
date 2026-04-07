import { Logger } from '../shared/logger.js';
import { APIManager } from './api-manager.js';
import { Providers } from './providers.js';
import { HealthManager } from './health.js';

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

const MAX_LINES_PER_BATCH = 500;
const RETRY_ATTEMPTS = 1; // Number of retries with smaller chunks on mismatch

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
 * Main translation entry point.
 * @param {Array} segments - Array of { text, startMs }
 */
export async function translate(segments, sourceLang, targetLang, tabId = null, onBatchComplete = null) {
  if (!segments || segments.length === 0) return { translated: [], hadFallback: false };

  const src = sourceLang || 'auto';
  const tgt = targetLang || 'vi';

  Logger.info('Translator', `Translating ${segments.length} segments [${src} → ${tgt}]`);
  sendDebugLog(tabId, `Starting translation of ${segments.length} segments → ${tgt}`, '#2dd4bf', true);

  const activeKeys = await APIManager.getValidKeys();

  if (activeKeys.length === 0) {
    Logger.error('Translator', 'No valid API keys found.');
    return { success: false, failureReason: 'NO_API_KEYS' };
  }

  const finalResults = new Array(segments.length).fill(null);
  let globalHadFallback = false;
  const allFailuresMap = new Map();

  const context = await generateContextSummary(segments.map(s => s.text), activeKeys, tabId, src, tgt);
  sendDebugLog(tabId, `Context Summary Ready`, '#6366f1');

  // Process in batches
  for (let i = 0; i * MAX_LINES_PER_BATCH < segments.length; i++) {
    const startIndex = i * MAX_LINES_PER_BATCH;
    const batch = segments.slice(startIndex, startIndex + MAX_LINES_PER_BATCH);

    Logger.info('Translator', `Processing batch ${i + 1} (${batch.length} segments)`);
    sendDebugLog(tabId, `Processing batch ${i + 1} (${batch.length} lines)...`, '#a855f7');

    const result = await translateBatchWithFailover(batch, src, tgt, activeKeys, tabId, context);

    // Merge batch results into final list
    result.translated.forEach((t, j) => {
      finalResults[startIndex + j] = t;
    });

    if (result.hadFallback) globalHadFallback = true;
    if (result.failures) {
      result.failures.forEach(f => {
        const key = `${f.provider}:${f.model}`;
        if (!allFailuresMap.has(key)) allFailuresMap.set(key, f);
      });
    }

    if (typeof onBatchComplete === 'function') {
      onBatchComplete(startIndex, result.translated);
    }
  }

  return {
    success: true,
    translated: finalResults,
    hadFallback: globalHadFallback,
    failureReason: globalHadFallback && finalResults.every((r, idx) => segments[idx].text === r) ? 'ALL_PROVIDERS_FAILED' : null,
    failures: Array.from(allFailuresMap.values())
  };
}

/**
 * Process a single batch of lines, trying different providers on failure.
 */
async function translateBatchWithFailover(segments, src, tgt, apiKeys, tabId, context) {
  const systemPrompt = `You are a professional subtitle translator. 
VIDEO CONTEXT:
${context}

Translate the following subtitle lines from ${src} to ${tgt}.
RULES:
1. PRESERVE THE LINE COUNT EXACTLY. Return exactly ${segments.length} lines. 
2. REQUIRED FORMAT: [HH:MM:SS] {Translated Text}
   Example: [00:00:12] Hello, [00:00:13] Good morning
3. THE TIMESTAMP IS THE POINTER. I use timestamp to sync subtitles. So you must return the same timestamp for each translated line as provided in the input.
4. Don't merge content, but you MUST still provide an entry for every timestamp (e.g., leave the skipped timestamp with empty content).
5. Return ONLY the translated lines. No explanations. The translated text must be in ${tgt}. 
6. UNFILTERED & FAITHFUL: Preserve all profanity, slang, and offensive language as-is. Do NOT censor, refine, or "beautify" the translation. If the source is vulgar, the translation MUST be equally vulgar in ${tgt}. 100% honesty to the source is mandatory, even if it is a swear word, slur, curse, profanity, or any other offensive, criminal, illegal language.
`; // Never change UNFILTERED & FAITHFUL rule, it is the most important rule.

  const userPrompt = segments.map(s => `${formatTimestamp(s.startMs)} ${s.text}`).join('\n');
  const failures = [];

  for (let k = 0; k < apiKeys.length; k++) {
    const key = apiKeys[k];
    const startTime = performance.now();

    try {
      const result = await Providers.chat(
        key.provider,
        key.model,
        key.apiKey,
        userPrompt,
        {
          systemPrompt,
          temperature: 0.1
        }
      );

      const duration = performance.now() - startTime;
      sendDebugLog(tabId, `Request with ${key.provider} returned success=${!!result.success}`, '#94a3b8');

      if (result.success && result.text) {
        sendDebugLog(tabId, `RAW RESPONSE RECEIVED (Length: ${result.text.length})`, '#6366f1');

        const cleanedText = cleanResponse(result.text);

        // Parse result lines by Timestamp [HH:MM:SS]
        // We use a Map of queues to handle multiple entries per second
        const regex = /\[(\d{1,2}:\d{2}:\d{2})\]\s*([\s\S]*?)(?=\s*\[\d{1,2}:\d{2}:\d{2}\]|$)/g;
        const parsedQueues = {}; // timestamp -> [content1, content2, ...]
        let totalParsed = 0;

        let match;
        while ((match = regex.exec(cleanedText)) !== null) {
          const timestamp = match[1];
          const content = match[2].trim();

          if (!parsedQueues[timestamp]) parsedQueues[timestamp] = [];
          parsedQueues[timestamp].push(content);
          totalParsed++;
        }

        // Build result array by matching segments to parsedQueues with Propagation
        let validLinesCount = 0;
        let propagationCount = 0;
        let lastTranslation = null;

        const resultLines = segments.map(s => {
          const ts = formatTimestamp(s.startMs).replace(/[\[\]]/g, ''); // Extract HH:MM:SS
          if (parsedQueues[ts] && parsedQueues[ts].length > 0) {
            validLinesCount++;
            lastTranslation = parsedQueues[ts].shift();
            return lastTranslation;
          }
          
          // Propagation logic: If missing and we have a previous translation, use it (merged segments)
          if (lastTranslation) {
            propagationCount++;
            return lastTranslation;
          }

          return s.text; // Absolute fallback to original
        });

        const threshold = Math.max(1, Math.floor(segments.length * 0.5));

        if (validLinesCount >= threshold || k === apiKeys.length - 1) {
          let hadFallback = validLinesCount < segments.length;

          if (propagationCount > 0) {
            Logger.info('Translator', `Propagated ${propagationCount} segments due to line merging.`);
            sendDebugLog(tabId, `Propagated ${propagationCount} translations for merged segments.`, '#38bdf8');
          }

          if (hadFallback && propagationCount === 0) {
            Logger.warn('Translator', `Partial match: ${validLinesCount}/${segments.length}. Missing filled with original.`);
            sendDebugLog(tabId, `Parsed ${validLinesCount}/${segments.length} timestamps. Mismatches kept as original.`, '#f59e0b');
          } else if (hadFallback) {
             sendDebugLog(tabId, `Sync fixed: ${validLinesCount} matched, ${propagationCount} propagated.`, '#22c55e');
          } else {
            sendDebugLog(tabId, `Perfect match! All ${segments.length} timestamps synchronized.`, '#22c55e');
          }

          await HealthManager.report(key.provider, key.apiKey, true, duration);
          return { translated: resultLines, hadFallback };
        } else {
          Logger.warn('Translator', `Severe mismatch with ${key.provider}. Got ${validLinesCount}/${segments.length}. Failing over.`);
          sendDebugLog(tabId, `Mismatch with ${key.provider}: Expected ${segments.length}, got ${validLinesCount}.`, '#f59e0b');
          await HealthManager.report(key.provider, key.apiKey, false, duration);
        }
      } else {
        Logger.warn('Translator', `Provider ${key.provider} failed: ${result.message}`);
        await HealthManager.report(key.provider, key.apiKey, false, duration);
        failures.push({ provider: key.provider, model: key.model, message: result.message });
      }
    } catch (err) {
      const duration = performance.now() - startTime;
      Logger.error('Translator', `Error during provider call (${key.provider})`, { error: err.message });
      await HealthManager.report(key.provider, key.apiKey, false, duration);
      failures.push({ provider: key.provider, model: key.model, message: err.message });
    }
  }

  return { translated: segments.map(s => s.text), hadFallback: true, failures };
}

/**
 * Generate a context summary of the video based on the full transcript.
 */
async function generateContextSummary(texts, apiKeys, tabId, src, tgt) {
  const fullTranscript = texts.join('\n');
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
        const summary = result.text.trim();
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
