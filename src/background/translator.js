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

const MAX_LINES_PER_BATCH = 20;
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
    return texts;
  }

  // Split into batches
  const batches = [];
  for (let i = 0; i < texts.length; i += MAX_LINES_PER_BATCH) {
    batches.push(texts.slice(i, i + MAX_LINES_PER_BATCH));
  }

  const results = [];
  let hadFallback = false;

  // Process each batch
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    Logger.info('Translator', `Processing batch ${i+1}/${batches.length} (${batch.length} lines)`);
    sendDebugLog(tabId, `Processing batch ${i+1}/${batches.length} (${batch.length} lines)...`, '#a855f7');

    const translatedBatch = await translateBatchWithFailover(batch, src, tgt, apiKeys, tabId);

    // Ensure we always have a result (original strings if LLM failed)
    if (translatedBatch && translatedBatch.length === batch.length) {
      results.push(...translatedBatch);
    } else {
      hadFallback = true;
      const reason = !translatedBatch ? "Failover exhausted or provider error" : `Line mismatch (Expected ${batch.length}, got ${translatedBatch.length})`;
      Logger.error('Translator', `Batch ${i+1} failed Line Count check. ${reason}. Using original text.`);
      sendDebugLog(tabId, `Batch ${i+1} FAILED: ${reason}. Using original text.`, '#f43f5e', true);
      results.push(...batch);
    }
  }

  return { translated: results, hadFallback };
}

/**
 * Process a single batch of lines, trying different providers on failure.
 */
async function translateBatchWithFailover(lines, src, tgt, apiKeys, tabId) {
  const systemPrompt = `You are a professional subtitle translator. 
Translate the following subtitle lines from ${src} to ${tgt}.
RULES:
1. Translate each line independently.
2. PRESERVE THE LINE COUNT EXACTLY. You MUST return exactly ${lines.length} lines.
3. Use the following format for each line: {Line Number}| {Translated Text}
   Example: 1| Xin chào, 2| Chào buổi sáng
4. Each output line should correspond to exactly one input line.
5. Do NOT add any explanations, numbering, or citations.
6. Do NOT merge lines. If a line is empty, return only the line number followed by a pipe and an empty string (e.g. 5| ).
7. Return ONLY the translated lines in the specified format.`;

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
          max_tokens: 2000,
          temperature: 0.1 // Low temperature for consistency
        }
      );

      const duration = performance.now() - startTime;
      
      sendDebugLog(tabId, `Request with ${key.provider} (${key.model}) returned success=${!!result.success}`, '#94a3b8');
 
      if (result.success && result.text) {
        // 1. Clean response (Markdown, noise, etc.)
        const cleanedText = cleanResponse(result.text);
        
        // 2. Parse result lines (Handling numbering format N| Text)
        let resultLines = cleanedText.split('\n')
          .filter(l => l.includes('|')) // Only lines that actually have the separator
          .map(l => {
            const pipeIndex = l.indexOf('|');
            let content = l.substring(pipeIndex + 1).trim();
            
            // Sometimes models return "1| 1| Text" or similar noise
            content = content.replace(/^\d+[|]\s*/, ''); 
            
            return content;
          });
        
        if (resultLines.length === lines.length) {
          await HealthManager.report(key.provider, key.apiKey, true, duration);
          return resultLines;
        } else {
          Logger.warn('Translator', `Line count mismatch with ${key.provider}. Expected ${lines.length}, got ${resultLines.length}.`);
          Logger.info('Translator', 'Raw result snippet (first 100 chars): ' + result.text.substring(0, 100));
          sendDebugLog(tabId, `Mismatch with ${key.provider}: Expected ${lines.length}, got ${resultLines.length}.`, '#f59e0b');
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
    }).catch(() => {}); // Catch if tab is closed
  } catch(e) {}
}
