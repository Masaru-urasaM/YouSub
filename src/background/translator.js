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
 * Main translation entry point.
 */
export async function translate(texts, sourceLang, targetLang, tabId = null, onBatchComplete = null) {
  if (!texts || texts.length === 0) return { translated: [], hadFallback: false };

  const src = sourceLang || 'auto';
  const tgt = targetLang || 'vi';

  Logger.info('Translator', `Translating ${texts.length} lines [${src} → ${tgt}]`);
  sendDebugLog(tabId, `Starting translation of ${texts.length} lines → ${tgt}`, '#2dd4bf', true);

  const apiKeys = await APIManager.getValidKeys(); // Phase 13.8: Use all configured keys
  if (!apiKeys || apiKeys.length === 0) {
    Logger.warn('Translator', 'No API keys configured. Returning original texts.');
    return { translated: texts, hadFallback: true };
  }

  const finalResults = new Array(texts.length).fill(null);
  let globalHadFallback = false;

  const context = await generateContextSummary(texts, apiKeys, tabId, src, tgt);
  sendDebugLog(tabId, `Context Summary Ready: ${context.substring(0, 100)}...`, '#6366f1');

  // Process in batches of 500
  for (let i = 0; i * MAX_LINES_PER_BATCH < texts.length; i++) {
    const startIndex = i * MAX_LINES_PER_BATCH;
    const batch = texts.slice(startIndex, startIndex + MAX_LINES_PER_BATCH);
    
    Logger.info('Translator', `Processing batch ${i + 1} (${batch.length} lines, start: ${startIndex})`);
    sendDebugLog(tabId, `Processing batch ${i + 1} (${batch.length} lines)...`, '#a855f7');

    const result = await translateBatchWithFailover(batch, startIndex, src, tgt, apiKeys, tabId, context);
    
    // Merge batch results into final list
    result.translated.forEach((t, j) => {
      finalResults[startIndex + j] = t;
    });

    if (result.hadFallback) globalHadFallback = true;

    if (typeof onBatchComplete === 'function') {
      onBatchComplete(startIndex, result.translated);
    }
  }

  return { translated: finalResults, hadFallback: globalHadFallback };
}

/**
 * Process a single batch of lines, trying different providers on failure.
 */
async function translateBatchWithFailover(lines, startIndex, src, tgt, apiKeys, tabId, context) {
  const systemPrompt = `You are a professional subtitle translator. 
VIDEO CONTEXT:
${context}

Translate the following subtitle lines from ${src} to ${tgt}.
RULES:
1. PRESERVE THE LINE COUNT EXACTLY. Return exactly ${lines.length} lines.
2. REQUIRED FORMAT: [#ID] {Translated Text}
   Example: [#12] Hello, [#13] Good morning
3. THE ID TAG IS A FIXED POINTER. The ID refers to the absolute sentence number in the video. 
   If you merge content, you MUST still provide an entry for every ID (e.g., leave the skipped ID with empty content).
4. ABSOLUTELY NO RENUMBERING. Do not start from 1 unless the first line in this list is actually the first line of the video.
5. Return ONLY the translated lines. No explanations.
6. UNFILTERED & FAITHFUL: Preserve all profanity and slang. 100% honesty to the source is mandatory.`;

  const userPrompt = lines.map((l, i) => `[#${startIndex + i + 1}] ${l}`).join('\n');

  // Loop through available keys until success
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
          temperature: 0.1 // Low temperature for consistency
        }
      );

      const duration = performance.now() - startTime;

      sendDebugLog(tabId, `Request with ${key.provider} (${key.model}) returned success=${!!result.success}`, '#94a3b8');

      if (result.success && result.text) {
        // Log Raw Response for developer visibility
        sendDebugLog(tabId, `RAW RESPONSE:\n${result.text}`, '#6366f1');

        // 1. Clean response (Markdown, noise, etc.)
        const cleanedText = cleanResponse(result.text);

        // 2. Parse result lines by EXACT Line Tag ([#ID])
        const regex = /\[#(\d+)\]\s*([\s\S]*?)(?=\s*\[#\d+\]|$)/g;
        const parsedMap = {};
        let validLinesCount = 0;

        let match;
        while ((match = regex.exec(cleanedText)) !== null) {
          const numStr = match[1];
          const content = match[2].trim();
          const parsedId = parseInt(numStr, 10);
          const idx = parsedId - startIndex - 1; // Map absolute ID → batch relative index (0-indexed)

          if (idx >= 0 && idx < lines.length && parsedMap[idx] === undefined) {
            parsedMap[idx] = content;
            validLinesCount++;
          }
        }

        // Threshold: at least 50% must be parsed correctly to consider this a "success".
        // If it's the last API key, accept whatever we got instead of throwing it all away.
        const threshold = Math.max(1, Math.floor(lines.length * 0.5));

        if (validLinesCount >= threshold || k === apiKeys.length - 1) {
          // Accept the result. Pad missing or empty lines with the original text
          let resultLines = lines.map((originalText, idx) => {
            return parsedMap[idx] !== undefined && parsedMap[idx].trim() !== "" ? parsedMap[idx] : originalText;
          });

          let hadFallback = false;
          if (validLinesCount < lines.length) {
            hadFallback = true;
            Logger.warn('Translator', `Partial translation from ${key.provider}: ${validLinesCount}/${lines.length} lines. Missing filled with original text.`);
            sendDebugLog(tabId, `Partial: ${validLinesCount}/${lines.length} lines. Missing padded with original.`, '#f59e0b');
          }

          await HealthManager.report(key.provider, key.apiKey, true, duration);
          return { translated: resultLines, hadFallback };
        } else {
          Logger.warn('Translator', `Severe line mismatch with ${key.provider}. Got ${validLinesCount}/${lines.length}. Failing over.`);
          sendDebugLog(tabId, `Mismatch with ${key.provider}: Expected ${lines.length}, got ${validLinesCount}.`, '#f59e0b');
          await HealthManager.report(key.provider, key.apiKey, false, duration);
        }
      } else {
        Logger.warn('Translator', `Provider ${key.provider} failed: ${result.message}`);
        await HealthManager.report(key.provider, key.apiKey, false, duration);

        if (result.message.includes('API key')) {
          await APIManager.markKeyFailed(key.provider, key.apiKey, result.message);
        }
      }
    } catch (err) {
      const duration = performance.now() - startTime;
      Logger.error('Translator', `Error during provider call (${key.provider})`, { error: err.message });
      await HealthManager.report(key.provider, key.apiKey, false, duration);
    }

    Logger.info('Translator', `Failover: Trying next available key if any...`);
  }

  return { translated: lines, hadFallback: true };
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
