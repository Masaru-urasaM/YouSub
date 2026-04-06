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

const MAX_LINES_PER_BATCH = 100;
const RETRY_ATTEMPTS = 1; // Number of retries with smaller chunks on mismatch



/**
 * Main translation entry point.
 */
export async function translate(texts, sourceLang, targetLang, tabId = null) {
  if (!texts || texts.length === 0) return [];

  const src = sourceLang || 'auto';
  const tgt = targetLang || 'vi';

  Logger.info('Translator', `Translating ${texts.length} lines [${src} → ${tgt}]`);
  sendDebugLog(tabId, `Starting translation of ${texts.length} lines → ${tgt}`, '#2dd4bf', true);

  const apiKeys = await APIManager.getValidKeys();
  if (apiKeys.length === 0) {
    Logger.warn('Translator', 'No API keys configured. Returning original texts.');
    return { translated: texts, hadFallback: true };
  }

  // Split into batches
  const batches = [];
  for (let i = 0; i < texts.length; i += MAX_LINES_PER_BATCH) {
    batches.push(texts.slice(i, i + MAX_LINES_PER_BATCH));
  }

  const results = [];
  let hadFallback = false;

  // 1.5 Generate Context Summary
  const context = await generateContextSummary(texts, apiKeys, tabId, src, tgt);
  sendDebugLog(tabId, `Context Summary Ready: ${context.substring(0, 100)}...`, '#6366f1');

  // Process each batch
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    Logger.info('Translator', `Processing batch ${i + 1}/${batches.length} (${batch.length} lines)`);
    sendDebugLog(tabId, `Processing batch ${i + 1}/${batches.length} (${batch.length} lines)...`, '#a855f7');

    const translatedResult = await translateBatchWithFailover(batch, src, tgt, apiKeys, tabId, context);

    // Ensure we always have a result (original strings if LLM failed)
    if (translatedResult && translatedResult.lines && translatedResult.lines.length === batch.length) {
      results.push(...translatedResult.lines);
      if (translatedResult.isPartial) {
        hadFallback = true;
        Logger.warn('Translator', `Batch ${i + 1} had a partial response. hadFallback activated to avoid caching.`);
      }
    } else {
      hadFallback = true;
      const reason = !translatedResult ? "Failover exhausted or provider error" : `Line mismatch (Expected ${batch.length})`;
      Logger.error('Translator', `Batch ${i + 1} failed Line Count check. ${reason}. Using original text.`);
      sendDebugLog(tabId, `Batch ${i + 1} FAILED: ${reason}. Using original text.`, '#f43f5e', true);
      results.push(...batch);
    }
  }

  return { translated: results, hadFallback };
}

/**
 * Process a single batch of lines, trying different providers on failure.
 */
async function translateBatchWithFailover(lines, src, tgt, apiKeys, tabId, context) {
  const systemPrompt = `You are a professional subtitle translator. 
VIDEO CONTEXT:
${context}

Translate the following subtitle lines from ${src} to ${tgt}. The returned result must be 100% in the ${tgt} language, and cannot be in any other language.
RULES:
1. Translate each line independently.
2. PRESERVE THE LINE COUNT EXACTLY. You MUST return exactly ${lines.length} lines.
3. Use the following format for each line: {Line Number}| {Translated Text}
   Example: 1| Hello, 2| Good morning
   * If a line is empty, return only the line number followed by a pipe and an empty string (e.g. 5| ). 
4. Each output line should correspond to exactly one input line.
5. Do NOT add any explanations, numbering, or citations.
6. Do NOT merge lines. Never merge 2 lines into 1, even if the content is related, even if the speaker is the same, even if the content is a continuation of the previous line. This must be ABSOLUTELY followed.
7. Return ONLY the translated lines in the specified format.
8. UNFILTERED & FAITHFUL: Preserve all profanity, slang, and offensive language as-is. Do NOT censor, refine, or "beautify" the translation. If the source is vulgar, the translation MUST be equally vulgar in ${tgt}. 100% honesty to the source is mandatory, even if it is a swear word, slur, curse, profanity, or any other offensive, criminal, illegal language.`;

  const userPrompt = lines.map((l, i) => `${i + 1}| ${l}`).join('\n');

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
        // 1. Clean response (Markdown, noise, etc.)
        const cleanedText = cleanResponse(result.text);

        // 2. Parse result lines by EXACT Line Number
        // NEW: Smart Regex Parser (diệt lời nguyền 9 câu)
        // Quét toàn bộ text để tìm các mẫu: [Số] | [Nội dung]
        // Regex này chấp nhận mọi kiểu khoảng trắng và không bị ngắt bởi dấu xuống dòng
        const regex = /(\d+)\s*[|]\s*([\s\S]*?)(?=\s*\d+\s*[|]|$)/g;
        const parsedMap = {};
        let validLinesCount = 0;

        const matches = [...cleanedText.matchAll(regex)];
        
        matches.forEach(match => {
          const numStr = match[1];
          const content = match[2].trim();
          const idx = parseInt(numStr, 10) - 1; // 0-indexed

          // Chỉ chấp nhận nếu chỉ số nằm trong phạm vi của batch hiện tại
          if (idx >= 0 && idx < lines.length && parsedMap[idx] === undefined) {
            parsedMap[idx] = content;
            validLinesCount++;
          }
        }); 
        
        // Threshold: at least 50% must be parsed correctly to consider this a "success".
        // If it's the last API key, accept whatever we got instead of throwing it all away.
        const threshold = Math.max(1, Math.floor(lines.length * 0.5));

        if (validLinesCount >= threshold || k === apiKeys.length - 1) {
          // Accept the result. Pad missing or empty lines with the original text (user requested fallback to original without shifting).
          let resultLines = lines.map((originalText, idx) => {
            return parsedMap[idx] && parsedMap[idx].trim() !== "" ? parsedMap[idx] : originalText;
          });

          let isPartial = false;
          if (validLinesCount < lines.length) {
            isPartial = true;
            Logger.warn('Translator', `Partial translation from ${key.provider}: ${validLinesCount}/${lines.length} lines. Missing filled with original text.`);
            sendDebugLog(tabId, `Partial: ${validLinesCount}/${lines.length} lines. Missing padded with original.`, '#f59e0b');
          }

          await HealthManager.report(key.provider, key.apiKey, true, duration);
          return { lines: resultLines, isPartial };
        } else {
          Logger.warn('Translator', `Severe line mismatch with ${key.provider}. Got ${validLinesCount}/${lines.length}. Failing over.`);
          Logger.info('Translator', 'Raw result snippet (first 100 chars): ' + result.text.substring(0, 100));
          sendDebugLog(tabId, `Mismatch with ${key.provider}: Expected ${lines.length}, got ${validLinesCount}.`, '#f59e0b');
          sendDebugLog(tabId, `Raw Response Sample: ${result.text.substring(0, 200)}...`, '#94a3b8');
          await HealthManager.report(key.provider, key.apiKey, false, duration);
        }
      } else {
        Logger.warn('Translator', `Provider ${key.provider} failed: ${result.message}`);
        await HealthManager.report(key.provider, key.apiKey, false, duration);

        // If it's a structural failure (Invalid Key, Permissions), mark it
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

  return null; // Signals failure to the caller
}

/**
 * Generate a context summary of the video based on the full transcript.
 */
async function generateContextSummary(texts, apiKeys, tabId, src, tgt) {
  const fullTranscript = texts.join('\n');
  const summaryPrompt = `You are a professional content analyzer.
Below is the FULL transcript of a video in ${src}. 
Provide a 2-3 sentence summary in English of the video's topic, context, and key terms to help a translator keep consistency (especially for pronouns and specialized vocabulary). 
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
