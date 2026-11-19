import { Logger } from '../shared/logger.js';
import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { Providers } from './providers.js';
import { HealthManager } from './health.js';
import '../shared/libs/browser-polyfill.js';
import {
  MAX_PAYLOAD_BYTES,
  formatTimestamp,
  buildSystemPrompt,
  getProviderJsonConfig,
  buildJsonSystemPrompt,
  buildJsonUserPrompt,
  parseJsonResponse,
  parseTimestampedText,
  partitionKeysByProvider,
  splitForGroqPayload,
} from './translator-prompts.js';
import { saveDebugBatch, finalizeSuccessfulBatch } from './translator-quality.js';

export const RETRY_ATTEMPTS = 2;
export const RETRY_DELAYS_MS = [1000, 3000];
export const BATCH_REQUEST_TIMEOUT_MS = 35000;
export const SWEEP_MAX_WAIT_MS = 15000; // cap on waiting for key cooldowns before a sweep retry
export const MAX_RECURSION_DEPTH = 3; // Stop infinite 413 splits
export const KEY_COOLDOWN_MS = 10000; // 10s per-key cooldown after 429
export const keyCooldowns = new Map(); // apiKey::model -> cooldown expiry timestamp

// Phase 55: Periodic cleanup for keyCooldowns to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of keyCooldowns) {
    if (now >= expiry) keyCooldowns.delete(key);
  }
}, 60000);

/**
 * Helper: Sleep for ms
 */
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getCooldownKey(apiKey, model) {
  return apiKey + '::' + (model || 'default');
}

// Phase 64 (sweep): cooldown-aware pacing — ms to wait before retrying failed batches.
export function soonestCooldownWaitMs(activeKeys, cooldownMap, now, maxWaitMs = SWEEP_MAX_WAIT_MS) {
  let soonestFree = null;
  for (const key of activeKeys || []) {
    const until = cooldownMap.get(getCooldownKey(key.apiKey, key.model)) || 0;
    if (until <= now) return 0; // a free key exists — no need to wait
    if (soonestFree === null || until < soonestFree) soonestFree = until;
  }
  if (soonestFree === null) return 0; // no keys
  return Math.min(Math.max(0, soonestFree - now), maxWaitMs);
}

export function groupByPhysicalKey(activeKeys) {
  const groups = [];
  const groupMap = new Map();
  for (const slot of activeKeys) {
    const existing = groupMap.get(slot.apiKey);
    if (existing) {
      existing.push(slot);
    } else {
      const newGroup = [slot];
      groupMap.set(slot.apiKey, newGroup);
      groups.push(newGroup);
    }
  }
  return groups;
}

export function sortGroupsByHealth(groups) {
  groups.sort((a, b) => (b[0].score || 0.5) - (a[0].score || 0.5));
}

export function selectGroupForBatch(keyGroups, batchIndex) {
  const numGroups = keyGroups.length;
  if (numGroups === 0) return null;
  const now = Date.now();
  for (let attempt = 0; attempt < numGroups; attempt++) {
    const idx = (batchIndex + attempt) % numGroups;
    const group = keyGroups[idx];
    const hasAvailable = group.some((slot) => {
      const cd = keyCooldowns.get(getCooldownKey(slot.apiKey, slot.model)) || 0;
      return now >= cd;
    });
    if (hasAvailable) return { groupIndex: idx, slots: group };
  }
  return { groupIndex: batchIndex % numGroups, slots: keyGroups[batchIndex % numGroups] };
}

// Phase D6 (DEFERRED): provider call with transient-retry (timeouts + 5xx).
export async function callProviderWithRetry({
  key,
  effectiveUserPrompt,
  effectiveSystemPrompt,
  jsonApiOptions,
  isStreaming,
  estimatedOutputTokens,
  signal,
  onChunk,
}) {
  let result;
  let duration;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (signal && signal.aborted) break;

    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] || 3000;
      Logger.warn(
        'Translator',
        `Retry ${attempt}/${RETRY_ATTEMPTS} for ${key.provider} after ${delay}ms...`
      );
      await wait(delay);
    }

    const attemptStart = performance.now();
    if (isStreaming) {
      result = await Providers.chatStream(
        key.provider,
        key.model,
        key.apiKey,
        effectiveUserPrompt,
        {
          systemPrompt: effectiveSystemPrompt,
          temperature: 0.1,
          maxTokens: estimatedOutputTokens,
          timeoutMs: BATCH_REQUEST_TIMEOUT_MS,
          signal,
        },
        (chunk) => {
          if (onChunk) onChunk(chunk);
        }
      );
    } else {
      result = await Providers.chat(key.provider, key.model, key.apiKey, effectiveUserPrompt, {
        systemPrompt: effectiveSystemPrompt,
        temperature: 0.1,
        maxTokens: estimatedOutputTokens,
        timeoutMs: BATCH_REQUEST_TIMEOUT_MS,
        signal,
        ...jsonApiOptions,
      });
    }
    duration = performance.now() - attemptStart;

    const isTransient =
      !result.success &&
      ((result.message && result.message.includes('Timeout')) ||
        (result.statusCode && result.statusCode >= 500));
    if (!isTransient || attempt === RETRY_ATTEMPTS) break;
  }
  return { result, duration };
}

export async function tryKeyForBatch(key, segments, systemPrompt, userPrompt, tabId, options = {}) {
  const { signal, onChunk, isLastKey = false } = options;

  if (signal && signal.aborted) {
    return { status: 'aborted' };
  }

  const cooldownUntil = keyCooldowns.get(getCooldownKey(key.apiKey, key.model)) || 0;
  if (Date.now() < cooldownUntil) {
    Logger.debug('Translator', `Skipping ${key.provider}/${key.model} — cooldown active`);
    return { status: 'cooldown' };
  }

  Logger.trace('Translator', `Trying key: ${key.provider} (${key.model})`);

  // Phase 58: Detect JSON mode support for this provider (resolving 'auto' keys first)
  const effectiveProvider =
    key.provider === 'auto'
      ? YOUSUB_PROVIDERS.detectProviderFromKey(key.apiKey) || key.provider
      : key.provider;
  const jsonConfig = getProviderJsonConfig(effectiveProvider, segments.length);
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
    Logger.trace(
      'Translator',
      `[JSON_MODE] Enabled for ${key.provider} (${segments.length} segments)`
    );
  }

  try {
    const settings = await browser.storage.local.get(['yousub_streaming_mode']);
    const isStreaming = settings.yousub_streaming_mode === true && !useJsonMode;
    const estimatedOutputTokens = useJsonMode
      ? Math.min(Math.max(1500, segments.length * 130), 16384)
      : Math.min(Math.max(1024, segments.length * 100), 8192);

    const { result, duration } = await callProviderWithRetry({
      key,
      effectiveUserPrompt,
      effectiveSystemPrompt,
      jsonApiOptions,
      isStreaming,
      estimatedOutputTokens,
      signal,
      onChunk,
    });

    if (result.success && result.text) {
      saveDebugBatch({
        timestamp: new Date().toISOString(),
        provider: key.provider,
        model: key.model,
        input: effectiveUserPrompt,
        output: result.text,
        systemPrompt: effectiveSystemPrompt,
        success: true,
        duration: duration.toFixed(0) + 'ms',
      });

      // Phase 58: Try JSON parsing first when JSON mode was used
      if (useJsonMode) {
        const jsonResult = parseJsonResponse(result.text, segments);
        if (jsonResult) {
          Logger.debug(
            'Translator',
            `[JSON_MODE] Parsed ${jsonResult.validCount}/${segments.length} lines from ${key.provider}`
          );
          const threshold = Math.max(1, Math.floor(segments.length * 0.1));
          if (jsonResult.validCount >= threshold || isLastKey) {
            HealthManager.report(key.provider, key.apiKey, true, duration);
            return await finalizeSuccessfulBatch(
              jsonResult.lines,
              segments,
              key,
              tabId,
              { ...options, _isIndexedJson: true },
              jsonResult.hadMismatch || jsonResult.validCount < segments.length,
              result,
              tryKeyForBatch
            );
          }
          Logger.warn(
            'Translator',
            `[JSON_MODE] Quality low (${jsonResult.validCount}/${segments.length}). Trying text parser.`
          );
        } else {
          Logger.warn(
            'Translator',
            `[JSON_MODE] JSON parse failed for ${key.provider}. Trying text parser.`
          );
        }
      }

      // Text-based parser (timestamp regex) — primary for non-JSON, fallback for JSON failures
      const { lines: resultLines, validCount: validLinesCount } = parseTimestampedText(
        result.text,
        segments
      );

      const threshold = Math.max(1, Math.floor(segments.length * 0.1));

      if (validLinesCount === 0) {
        Logger.warn(
          'Translator',
          `Parser failure with ${key.provider}. (Matched 0/${segments.length})`
        );
        HealthManager.report(key.provider, key.apiKey, false, duration);
        return { status: 'parse_fail' };
      }

      Logger.debug(
        'Translator',
        `Parser outcome: ${validLinesCount}/${segments.length} matched via ${key.provider}.`
      );

      if (validLinesCount >= threshold || isLastKey) {
        HealthManager.report(key.provider, key.apiKey, true, duration);
        return await finalizeSuccessfulBatch(
          resultLines,
          segments,
          key,
          tabId,
          { ...options, _isIndexedJson: false },
          validLinesCount < segments.length,
          result,
          tryKeyForBatch
        );
      } else {
        Logger.warn(
          'Translator',
          `Quality mismatch (${validLinesCount}/${segments.length}). Failing over.`
        );
        HealthManager.report(key.provider, key.apiKey, false, duration);
        return { status: 'quality_fail' };
      }
    } else if (result.statusCode === 413) {
      Logger.warn('Translator', `413 from ${key.provider} (segs=${segments.length}).`);
      HealthManager.report(key.provider, key.apiKey, false, duration);
      return { status: '413', message: result.message };
    } else if (result.statusCode === 429) {
      const cooldown = Math.max(KEY_COOLDOWN_MS, result.retryAfterMs || 0);
      keyCooldowns.set(getCooldownKey(key.apiKey, key.model), Date.now() + cooldown);
      Logger.warn(
        'Translator',
        `Rate limited (429) by ${key.provider}/${key.model}. Cooldown ${cooldown}ms.`
      );
      HealthManager.report(key.provider, key.apiKey, false, duration, { isTransient: true });
      return { status: '429', cooldown, message: result.message };
    } else {
      Logger.warn('Translator', `${key.provider} returned error: ${result.message}`);
      HealthManager.report(key.provider, key.apiKey, false, duration);
      return { status: 'error', message: result.message };
    }
  } catch (err) {
    Logger.error('Translator', `Exception with ${key.provider}: ${err.message}`, {
      provider: key.provider,
      model: key.model,
      segmentCount: segments?.length,
      stack: err?.stack ? String(err.stack).split('\n').slice(0, 3).join(' | ') : undefined,
    });
    return { status: 'exception', message: err.message };
  }
}

// Phase 57: Sticky-until-fail waterfall across Groq keys
async function processGroqWaterfall(chunks, groqKeys, src, tgt, tabId, context, options = {}) {
  const { signal } = options;
  const results = new Array(chunks.length).fill(null);
  let currentKeyIndex = 0;
  let hadRateLimit = false;
  const allStats = {
    usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
    model: 'unknown',
  };
  const unprocessedChunks = [];
  const failures = [];

  for (let i = 0; i < chunks.length; i++) {
    if (signal && signal.aborted) {
      for (let j = i; j < chunks.length; j++)
        unprocessedChunks.push({ index: j, segments: chunks[j] });
      break;
    }

    const chunkSegments = chunks[i];
    const systemPrompt = buildSystemPrompt(context, src, tgt, chunkSegments.length);
    const userPrompt = chunkSegments
      .map((s, idx) => `#${idx + 1} ${formatTimestamp(s.startMs)} ${s.text}`)
      .join('\n');
    let chunkDone = false;

    while (currentKeyIndex < groqKeys.length && !chunkDone) {
      if (signal && signal.aborted) break;

      const key = groqKeys[currentKeyIndex];
      const result = await tryKeyForBatch(key, chunkSegments, systemPrompt, userPrompt, tabId, {
        signal,
        onChunk: options.onChunk,
        isLastKey: currentKeyIndex === groqKeys.length - 1,
        context,
        src,
        tgt,
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
          failures.push({
            provider: key.provider,
            model: key.model,
            status: 429,
            message: result.message,
          });
          currentKeyIndex++;
          break;
        case '413':
          failures.push({
            provider: key.provider,
            model: key.model,
            status: 413,
            message: result.message,
          });
          currentKeyIndex = groqKeys.length;
          break;
        case 'cooldown':
          currentKeyIndex++;
          break;
        case 'aborted':
          currentKeyIndex = groqKeys.length;
          break;
        default:
          failures.push({
            provider: key.provider,
            model: key.model,
            message: result.message || result.status,
          });
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
  const userPrompt = segments
    .map((s, i) => `#${i + 1} ${formatTimestamp(s.startMs)} ${s.text}`)
    .join('\n');
  const failures = [];

  for (let k = 0; k < nonGroqKeys.length; k++) {
    if (signal && signal.aborted) break;
    const key = nonGroqKeys[k];
    const result = await tryKeyForBatch(key, segments, systemPrompt, userPrompt, tabId, {
      signal,
      onChunk: options.onChunk,
      isLastKey: k === nonGroqKeys.length - 1,
      context,
      src,
      tgt,
    });
    if (result.status === 'success') {
      return {
        success: true,
        translated: result.translated,
        hadFallback: result.hadFallback,
        stats: result.stats,
      };
    }
    if (result.status === 'aborted') break;
    if (result.status !== 'cooldown') {
      failures.push({
        provider: key.provider,
        model: key.model,
        status: result.status === '429' ? 429 : result.status === '413' ? 413 : 0,
        message: result.message,
      });
    }
  }

  return {
    success: false,
    translated: segments.map((s) => s.text),
    hadFallback: true,
    stats: {},
    failures,
  };
}

/**
 * Process a single batch of lines, trying different providers on failure.
 * Phase 57: Groq-aware routing with waterfall distribution.
 */
export async function translateBatchWithFailover(
  segments,
  src,
  tgt,
  apiKeys,
  tabId,
  context,
  options = {}
) {
  const { startKeyIndex = 0, startGroupIndex = 0, keyGroups, depth = 0, signal } = options;

  if (signal && signal.aborted) {
    return { translated: segments.map((s) => s.text), hadFallback: true, hadRateLimit: false };
  }

  const systemPrompt = buildSystemPrompt(context, src, tgt, segments.length);
  const userPrompt = segments
    .map((s, i) => `#${i + 1} ${formatTimestamp(s.startMs)} ${s.text}`)
    .join('\n');
  const estimatedBytes = (systemPrompt.length + userPrompt.length) * 2;

  // Phase 57: Groq-aware pre-flight — split and waterfall across Groq keys
  const { groqKeys, nonGroqKeys } = partitionKeysByProvider(apiKeys);
  const payloadExceedsGroq = estimatedBytes > MAX_PAYLOAD_BYTES;

  if (
    groqKeys.length > 0 &&
    payloadExceedsGroq &&
    segments.length > 2 &&
    depth < MAX_RECURSION_DEPTH
  ) {
    Logger.trace(
      'Translator',
      `Payload ~${Math.round(estimatedBytes / 1024)}KB exceeds Groq limit. Groq waterfall with ${groqKeys.length} keys.`
    );

    const chunks = splitForGroqPayload(segments, src, tgt, context);
    Logger.trace('Translator', `Split into ${chunks.length} Groq-sized chunks.`);

    const {
      results,
      unprocessedChunks,
      hadRateLimit,
      stats,
      failures: groqFailures,
    } = await processGroqWaterfall(chunks, groqKeys, src, tgt, tabId, context, {
      signal,
      onChunk: options.onChunk,
    });

    let fallbackFailures = [];
    if (unprocessedChunks.length > 0 && nonGroqKeys.length > 0) {
      Logger.trace(
        'Translator',
        `${unprocessedChunks.length} chunks remaining. Falling back to non-Groq providers.`
      );
      const remainingSegments = [];
      const indexMap = [];
      for (const { index, segments: segs } of unprocessedChunks) {
        indexMap.push({
          chunkIndex: index,
          baseOffset: remainingSegments.length,
          count: segs.length,
        });
        remainingSegments.push(...segs);
      }

      const fallback = await fallbackToNonGroq(
        remainingSegments,
        nonGroqKeys,
        src,
        tgt,
        tabId,
        context,
        { signal, onChunk: options.onChunk }
      );
      fallbackFailures = fallback.failures || [];

      if (fallback.success) {
        for (const { chunkIndex, baseOffset, count } of indexMap) {
          results[chunkIndex] = {
            status: 'success',
            translated: fallback.translated.slice(baseOffset, baseOffset + count),
            hadFallback: fallback.hadFallback,
            stats: fallback.stats,
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
        finalTranslated.push(...chunks[i].map((s) => s.text));
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
      failures: mergedFailures,
    };
  }

  // Round-robin group failover (or legacy sequential if keyGroups not provided)
  const failures = [];
  let hadRateLimit = false;
  let had413 = false;

  const recordSlotResult = (key, result) => {
    switch (result.status) {
      case 'success':
        return {
          done: true,
          value: {
            success: true,
            translated: result.translated,
            hadFallback: result.hadFallback,
            hadRateLimit: false,
            stats: result.stats,
            ...(failures.length > 0 ? { failures: [...failures] } : {}),
          },
        };
      case '429':
        hadRateLimit = true;
        failures.push({
          provider: key.provider,
          model: key.model,
          status: 429,
          message: result.message,
        });
        return { done: false };
      case '413':
        had413 = true;
        failures.push({
          provider: key.provider,
          model: key.model,
          status: 413,
          message: result.message,
        });
        return { done: false, skipGroup: true };
      case 'cooldown':
        hadRateLimit = true;
        failures.push({
          provider: key.provider,
          model: key.model,
          status: 429,
          message: 'Key on cooldown (rate limited)',
        });
        return { done: false };
      case 'aborted':
        return {
          done: true,
          value: {
            translated: segments.map((s) => s.text),
            hadFallback: true,
            hadRateLimit: false,
          },
        };
      default:
        failures.push({
          provider: key.provider,
          model: key.model,
          message: result.message || result.status,
        });
        return { done: false };
    }
  };

  if (keyGroups && keyGroups.length > 0) {
    const numGroups = keyGroups.length;
    for (let g = 0; g < numGroups; g++) {
      const groupIdx = (startGroupIndex + g) % numGroups;
      const group = keyGroups[groupIdx];
      let skip413Group = false;

      for (let m = 0; m < group.length; m++) {
        if (signal && signal.aborted) {
          return {
            translated: segments.map((s) => s.text),
            hadFallback: true,
            hadRateLimit: false,
          };
        }
        if (skip413Group) break;

        const key = group[m];
        const isLastSlot = g === numGroups - 1 && m === group.length - 1;
        const result = await tryKeyForBatch(key, segments, systemPrompt, userPrompt, tabId, {
          signal,
          onChunk: options.onChunk,
          isLastKey: isLastSlot,
          context,
          src,
          tgt,
        });

        const outcome = recordSlotResult(key, result);
        if (outcome.done) return outcome.value;
        if (outcome.skipGroup) skip413Group = true;
      }
    }
  } else {
    for (let k = startKeyIndex; k < apiKeys.length; k++) {
      if (signal && signal.aborted) {
        return { translated: segments.map((s) => s.text), hadFallback: true, hadRateLimit: false };
      }

      const key = apiKeys[k];
      const result = await tryKeyForBatch(key, segments, systemPrompt, userPrompt, tabId, {
        signal,
        onChunk: options.onChunk,
        isLastKey: k === apiKeys.length - 1,
        context,
        src,
        tgt,
      });

      const outcome = recordSlotResult(key, result);
      if (outcome.done) return outcome.value;
    }
  }

  // Safety net: all keys exhausted with 413 — recursive split
  if (had413 && segments.length > 2 && depth < MAX_RECURSION_DEPTH) {
    Logger.warn(
      'Translator',
      `All keys returned 413. Splitting ${segments.length} segments at depth=${depth}.`
    );
    const mid = Math.floor(segments.length / 2);
    const subContext = depth > 2 ? '' : context;

    const res1 = await translateBatchWithFailover(
      segments.slice(0, mid),
      src,
      tgt,
      apiKeys,
      tabId,
      subContext,
      { startKeyIndex: 0, depth: depth + 1, signal }
    );
    const res2 = await translateBatchWithFailover(
      segments.slice(mid),
      src,
      tgt,
      apiKeys,
      tabId,
      subContext,
      { startKeyIndex: 0, depth: depth + 1, signal }
    );

    return {
      success: res1.success && res2.success,
      translated: [...res1.translated, ...res2.translated],
      hadFallback: res1.hadFallback || res2.hadFallback,
      hadRateLimit: res1.hadRateLimit || res2.hadRateLimit,
      stats: {
        usage: {
          totalTokens:
            (res1.stats?.usage?.totalTokens || 0) + (res2.stats?.usage?.totalTokens || 0),
          promptTokens:
            (res1.stats?.usage?.promptTokens || 0) + (res2.stats?.usage?.promptTokens || 0),
          completionTokens:
            (res1.stats?.usage?.completionTokens || 0) + (res2.stats?.usage?.completionTokens || 0),
        },
        model: res1.stats?.model || res2.stats?.model,
      },
      failures: [...(res1.failures || []), ...(res2.failures || [])],
    };
  }

  if (had413 && segments.length <= 2 && depth < MAX_RECURSION_DEPTH && context) {
    Logger.warn(
      'Translator',
      `413 with ${segments.length} segments. Stripping context for final retry.`
    );
    return await translateBatchWithFailover(segments, src, tgt, apiKeys, tabId, '', {
      startKeyIndex: 0,
      depth: depth + 1,
      signal,
    });
  }

  return {
    success: false,
    translated: segments.map((s) => s.text),
    hadFallback: true,
    hadRateLimit,
    failures,
  };
}
