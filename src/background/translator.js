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
const INITIAL_BATCH_DELAY_MS = 50;
const ELEVATED_BATCH_DELAY_MS = 3000;

// Phase 64 (c): Per-batch timeout replaces the old single per-job cap, so total
// job length scales with batch count instead of a hard 60s/100s wall.
const BATCH_TIMEOUT_MS = 90000; // wall-clock cap for one batch (incl. amplification)
const BASE_FORCE_TIMEOUT_MS = 180000; // absolute backstop floor for the whole job
const PER_LINE_TIMEOUT_MS = 2500; // backstop grows with transcript length
const MAX_FORCE_TIMEOUT_MS = 600000; // hard ceiling (10 min) — never run forever

// Phase 64 (sweep): after the main pass, re-check for batches that did not
// translate ("sót") and retry them, up to MAX_SWEEP_ROUNDS rounds.
const MAX_SWEEP_ROUNDS = 3;
const SWEEP_MAX_WAIT_MS = 15000; // cap on waiting for key cooldowns before a sweep retry

// Phase 64 (c): absolute backstop scaled by transcript length.
function computeForceTimeoutMs(segmentCount) {
  return Math.min(
    Math.max(BASE_FORCE_TIMEOUT_MS, (segmentCount || 0) * PER_LINE_TIMEOUT_MS),
    MAX_FORCE_TIMEOUT_MS
  );
}

// Phase 64 (sweep): cooldown-aware pacing — ms to wait before retrying failed
// batches. Pure (cooldown map + now injected) so it is unit-testable. Returns 0
// if any key is already free (or there are no keys); otherwise the time until
// the soonest cooldown expiry, capped at maxWaitMs.
function soonestCooldownWaitMs(activeKeys, cooldownMap, now, maxWaitMs = SWEEP_MAX_WAIT_MS) {
  let soonestFree = null;
  for (const key of activeKeys || []) {
    const until = cooldownMap.get(getCooldownKey(key.apiKey, key.model)) || 0;
    if (until <= now) return 0; // a free key exists — no need to wait
    if (soonestFree === null || until < soonestFree) soonestFree = until;
  }
  if (soonestFree === null) return 0; // no keys
  return Math.min(Math.max(0, soonestFree - now), maxWaitMs);
}

// Phase 47: Anti-deadlock constants
const MAX_CONTEXT_CHARS = 500; // Cap context summary to prevent permanent 413
const MAX_RECURSION_DEPTH = 3; // Stop infinite 413 splits
const KEY_COOLDOWN_MS = 10000; // 10s per-key cooldown after 429
const keyCooldowns = new Map(); // apiKey::model -> cooldown expiry timestamp
const MAX_PAYLOAD_BYTES = 95000; // ~95KB safe limit for Groq (most restrictive provider)
const RE_TRANSLATION_MAX_LINES = 12; // max lines per re-translation API call
const MAX_RETRANSLATION_ROUNDS = 3; // max detect-and-retry rounds
const MIN_WORDS_FOR_UNTRANSLATED = 4;
const UNTRANSLATED_OVERLAP_THRESHOLD = 0.85;

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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NON_LATIN_TARGETS = new Set([
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
const FOREIGN_SCRIPT_DETECT = /[Ѐ-ԯ֐-ۿऀ-৿฀-๿　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
// eslint-disable-next-line no-misleading-character-class, no-irregular-whitespace -- intentional: strips foreign-script (incl. combining/ideographic-space) chars from text
const FOREIGN_SCRIPT_STRIP = /[Ѐ-ԯ֐-ۿऀ-৿฀-๿　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;

function detectForeignScriptLines(lines, tgt) {
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

function sanitizeForeignScript(lines, segments, tgt) {
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

function detectUntranslatedLines(lines, segments, tgt) {
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

async function retranslateShiftedLines(segments, lines, pendingIndices, key, tabId, options) {
  const result = [...lines];
  let remaining = [...new Set(pendingIndices)];
  const src = options.src || 'auto';
  const tgt = options.tgt || 'vi';
  const context = options.context || '';
  const checkForeignScript = !NON_LATIN_TARGETS.has(tgt);

  for (let round = 0; round < MAX_RETRANSLATION_ROUNDS && remaining.length > 0; round++) {
    Logger.debug(
      'Translator',
      `[RE-TRANSLATE] Round ${round + 1}: ${remaining.length} lines (${key.provider})`
    );

    for (let i = 0; i < remaining.length; i += RE_TRANSLATION_MAX_LINES) {
      const chunk = remaining.slice(i, i + RE_TRANSLATION_MAX_LINES);
      const miniSegments = chunk.map((idx) => segments[idx]);

      const miniSystemPrompt = buildSystemPrompt(context, src, tgt, miniSegments.length);
      const miniUserPrompt = miniSegments
        .map((s, idx) => `#${idx + 1} ${formatTimestamp(s.startMs)} ${s.text}`)
        .join('\n');

      const reOptions = { ...options, _skipMergeFix: true, _skipSanitize: true, isLastKey: true };
      const reResult = await tryKeyForBatch(
        key,
        miniSegments,
        miniSystemPrompt,
        miniUserPrompt,
        tabId,
        reOptions
      );

      if (reResult.status === 'success' && reResult.translated.length === chunk.length) {
        for (let j = 0; j < chunk.length; j++) {
          result[chunk[j]] = reResult.translated[j];
        }
      }
    }

    const stillBad = [];
    for (const idx of pendingIndices) {
      const line = result[idx];
      if (!line || (typeof line === 'string' && line.trim() === '')) {
        stillBad.push(idx);
      } else if (
        checkForeignScript &&
        typeof line === 'string' &&
        FOREIGN_SCRIPT_DETECT.test(line)
      ) {
        stillBad.push(idx);
      }
    }

    remaining = stillBad;
    if (remaining.length === 0) {
      Logger.debug('Translator', `[RE-TRANSLATE] All clean after round ${round + 1}`);
      break;
    }
    Logger.debug(
      'Translator',
      `[RE-TRANSLATE] ${remaining.length} lines still problematic after round ${round + 1}`
    );
  }

  for (const idx of pendingIndices) {
    if (!result[idx] || (typeof result[idx] === 'string' && result[idx].trim() === '')) {
      result[idx] = segments[idx].text;
      Logger.warn(
        'Translator',
        `[RE-TRANSLATE] Line ${idx} empty after ${MAX_RETRANSLATION_ROUNDS} rounds, using original`
      );
    }
  }

  return result;
}

async function retranslateWithVerification(segments, lines, pendingIndices, key, tabId, options) {
  const result = [...lines];
  const tgt = options.tgt || 'vi';
  const src = options.src || 'auto';
  const accepted = new Set();
  const signal = options.signal; // Phase 64 (c): honor batch/global abort
  let remaining = [...new Set(pendingIndices)];

  for (let round = 0; round < MAX_RETRANSLATION_ROUNDS && remaining.length > 0; round++) {
    if (signal && signal.aborted) break;
    Logger.debug(
      'Translator',
      `[UNTRANSLATED] Verify round ${round + 1}: ${remaining.length} lines (${key.provider})`
    );

    for (let i = 0; i < remaining.length; i += RE_TRANSLATION_MAX_LINES) {
      if (signal && signal.aborted) break;
      const chunk = remaining.slice(i, i + RE_TRANSLATION_MAX_LINES);
      const systemPrompt = buildVerificationPrompt(src, tgt, chunk.length);
      const userPrompt = JSON.stringify({
        lines: chunk.map((idx, j) => ({ n: j, t: segments[idx].text })),
      });

      try {
        const response = await Providers.chat(key.provider, key.model, key.apiKey, userPrompt, {
          systemPrompt,
          temperature: 0.1,
          maxTokens: chunk.length * 150,
          signal,
        });

        if (response.success && response.text) {
          const parsed = parseVerificationResponse(response.text, chunk.length);
          if (parsed) {
            for (const entry of parsed) {
              const realIdx = chunk[entry.index];
              if (realIdx === undefined) continue;
              if (entry.keep) {
                accepted.add(realIdx);
                Logger.debug(
                  'Translator',
                  `[UNTRANSLATED] Line ${realIdx} confirmed untranslatable by LLM`
                );
              } else if (entry.text) {
                result[realIdx] = entry.text;
              }
            }
          }
        }
      } catch (err) {
        Logger.warn('Translator', `[UNTRANSLATED] Verification call failed: ${err.message}`);
      }
    }

    const stillBad = [];
    for (const idx of remaining) {
      if (accepted.has(idx)) continue;
      const line = result[idx];
      const source = segments[idx]?.text;
      if (!line || !source) continue;
      const sourceWords = source.trim().split(/\s+/);
      if (sourceWords.length <= MIN_WORDS_FOR_UNTRANSLATED) continue;
      if (line.trim() === source.trim()) {
        stillBad.push(idx);
        continue;
      }
      const lineWords = line.trim().toLowerCase().split(/\s+/);
      const srcWords = source.trim().toLowerCase().split(/\s+/);
      const srcSet = new Set(srcWords);
      const shared = lineWords.filter((w) => srcSet.has(w)).length;
      const overlap = shared / Math.max(srcWords.length, lineWords.length);
      if (overlap >= UNTRANSLATED_OVERLAP_THRESHOLD) stillBad.push(idx);
    }

    remaining = stillBad;
    if (remaining.length === 0) {
      Logger.debug('Translator', `[UNTRANSLATED] All resolved after round ${round + 1}`);
      break;
    }
    Logger.debug(
      'Translator',
      `[UNTRANSLATED] ${remaining.length} lines still untranslated after round ${round + 1}`
    );
  }

  return result;
}

function getCooldownKey(apiKey, model) {
  return apiKey + '::' + (model || 'default');
}

function groupByPhysicalKey(activeKeys) {
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

function sortGroupsByHealth(groups) {
  groups.sort((a, b) => (b[0].score || 0.5) - (a[0].score || 0.5));
}

function selectGroupForBatch(keyGroups, batchIndex) {
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
  const parts = tsString.replace(/[[\]]/g, '').split(':');
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
export async function translate(
  segments,
  sourceLang,
  targetLang,
  tabId = null,
  onBatchComplete = null,
  externalSignal = null,
  onProgress = null
) {
  if (!segments || segments.length === 0) return { translated: [], hadFallback: false };

  // Phase 55: Filter out invalid segments before translation
  segments = segments.filter((s) => s && s.text && typeof s.startMs === 'number');
  if (segments.length === 0) return { translated: [], hadFallback: false };

  const src = sourceLang || 'auto';
  const tgt = targetLang || 'vi';

  // Phase 54.2: Dedup — return existing Promise if same video+lang is already translating
  const dedupKey = `${tabId}_${src}_${tgt}`;
  if (inFlightRequests.has(dedupKey)) {
    Logger.info('Translator', `[DEDUP] Returning existing in-flight request for ${dedupKey}`);
    return inFlightRequests.get(dedupKey);
  }

  const translatePromise = _translateInternal(
    segments,
    src,
    tgt,
    tabId,
    onBatchComplete,
    externalSignal,
    onProgress
  );
  inFlightRequests.set(dedupKey, translatePromise);
  try {
    return await translatePromise;
  } finally {
    inFlightRequests.delete(dedupKey);
  }
}

async function _translateInternal(
  segments,
  src,
  tgt,
  tabId,
  onBatchComplete,
  externalSignal,
  onProgress
) {
  Logger.trace('Translator', `[CHECKPOINT 1] Starting translation: ${segments.length} segments`);
  sendDebugLog(
    tabId,
    `Initializing translation pipeline (${segments.length} lines)...`,
    '#2dd4bf',
    true
  );

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

  // Phase 64 (c): Absolute backstop scales with transcript length (floor 180s,
  // +2.5s/line, ceiling 600s) instead of a fixed 100s that long videos blew past.
  const forceTimeoutMs = computeForceTimeoutMs(segments.length);
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

        // Accumulated stats
        const stats = {
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          durationMs: 0,
          model: 'unknown',
          batchCount: 0,
        };

        // Phase 45: Granular Log & Timeout for Context Summary
        Logger.trace('Translator', '[CHECKPOINT 3] Analyzing video context...');
        sendDebugLog(tabId, `Analyzing video context (Max 10s)...`, '#3b82f6');

        let context = '';
        try {
          context = await Promise.race([
            generateContextSummary(
              segments.map((s) => s.text),
              activeKeys,
              tabId,
              src,
              tgt
            ),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('ContextTimeout')), 10000)
            ),
          ]);
          Logger.trace('Translator', '[CHECKPOINT 3.S] Context summary ready.');
        } catch (e) {
          Logger.warn('Translator', `[CHECKPOINT 3.E] Context summary failed: ${e.message}`);
          context = 'General video content.';
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
        let failedRanges = []; // Phase 64 (sweep): batches to re-check at the end

        const keyGroups = groupByPhysicalKey(activeKeys);
        sortGroupsByHealth(keyGroups);
        Logger.trace(
          'Translator',
          `[CHECKPOINT 4] Starting batch processing (${totalLines} lines, ${keyGroups.length} key groups)...`
        );

        while (cursor < totalLines) {
          if (globalAbort.signal.aborted) break; // Phase 64 (c): stop promptly on force-cap / disconnect
          const selected = selectGroupForBatch(keyGroups, batchIndex);
          const primarySlot = selected ? selected.slots[0] : activeKeys[0];
          const batchSize = primarySlot.maxLinesPerBatch || MAX_LINES_PER_BATCH;
          const batch = segments.slice(cursor, cursor + batchSize);

          batchIndex++;
          const batchStartTime = performance.now();
          Logger.trace(
            'Translator',
            `[CHECKPOINT 5] Batch ${batchIndex}: lines ${cursor + 1}-${cursor + batch.length}/${totalLines} (size=${batchSize}, startGroup=${selected?.groupIndex || 0})...`
          );
          sendDebugLog(
            tabId,
            `Translating lines ${cursor + 1}-${cursor + batch.length} / ${totalLines}...`,
            '#a855f7'
          );

          // Phase 64 (c): per-batch timeout — a single stalled/over-amplified
          // batch is aborted (and marked failed) so it can't hang the whole job.
          // batchAbort is chained to globalAbort so the force-cap / port-disconnect
          // still cancels in-flight fetches.
          const batchAbort = new AbortController();
          const linkAbort = () => batchAbort.abort();
          if (globalAbort.signal.aborted) {
            batchAbort.abort();
          } else {
            globalAbort.signal.addEventListener('abort', linkAbort, { once: true });
          }
          let batchTimedOut = false;
          const batchTimer = setTimeout(() => {
            batchTimedOut = true;
            batchAbort.abort();
          }, BATCH_TIMEOUT_MS);

          let result;
          try {
            result = await translateBatchWithFailover(batch, src, tgt, activeKeys, tabId, context, {
              signal: batchAbort.signal,
              startGroupIndex: selected?.groupIndex || 0,
              keyGroups,
            });
          } finally {
            clearTimeout(batchTimer);
            globalAbort.signal.removeEventListener('abort', linkAbort);
          }
          if (batchTimedOut) {
            Logger.warn(
              'Translator',
              `[BATCH_TIMEOUT] Batch ${batchIndex} exceeded ${BATCH_TIMEOUT_MS}ms — marking failed for the completeness sweep.`
            );
          }

          const elapsed = ((performance.now() - batchStartTime) / 1000).toFixed(1);
          Logger.trace(
            'Translator',
            `[BATCH_RESULT] success=${result.success}, hadFallback=${result.hadFallback}, translatedCount=${result.translated?.length}, sample=${result.translated?.[0]?.substring?.(0, 50)}`
          );

          if (result.success) {
            anyBatchSucceeded = true;
            Logger.trace(
              'Translator',
              `[CHECKPOINT 5.S] Batch ${batchIndex} DONE in ${elapsed}s (lines ${cursor + 1}-${cursor + batch.length})`
            );
            sendDebugLog(
              tabId,
              `Lines ${cursor + 1}-${cursor + batch.length} OK (${elapsed}s)`,
              '#10b981'
            );

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
            Logger.warn(
              'Translator',
              `[CHECKPOINT 5.E] Batch ${batchIndex} FAILED (lines ${cursor + 1}-${cursor + batch.length}).`
            );
            failedRanges.push({ start: cursor, segments: batch }); // Phase 64 (sweep)
            batch.forEach((s, j) => {
              if (cursor + j < finalResults.length) {
                finalResults[cursor + j] = s.text;
              }
            });
            if (result.failures) allFailures.push(...result.failures);
            sendDebugLog(
              tabId,
              `Lines ${cursor + 1}-${cursor + batch.length} FAILED — using original text`,
              '#ef4444'
            );
            saveDebugBatch({
              timestamp: new Date().toISOString(),
              provider: 'all',
              model: 'N/A',
              input: batch
                .map((s, i) => `#${i + 1} ${formatTimestamp(s.startMs)} ${s.text}`)
                .join('\n'),
              output: null,
              systemPrompt: null,
              success: false,
              duration: elapsed + 's',
              failures: result.failures || [],
            });
          }

          stats.batchCount++;
          if (result.hadFallback) globalHadFallback = true;

          if (typeof onBatchComplete === 'function' && result.success) {
            onBatchComplete(cursor, result.translated);
          }

          // Phase 64 (a): heartbeat — every batch boundary (success OR failure)
          // is progress, so the content watchdog can tell a stalled background
          // from a slow-but-advancing one without resetting on PONG.
          if (typeof onProgress === 'function') onProgress();

          cursor += batch.length;

          if (cursor < totalLines) {
            const delay = result.hadRateLimit ? ELEVATED_BATCH_DELAY_MS : currentBatchDelay;
            await wait(delay);
          }
        }

        // Phase 64 (sweep): self-check for batches that did not translate and
        // retry them, up to MAX_SWEEP_ROUNDS rounds. Cooldown-aware so we do not
        // burn a round (and quota) hammering a still-rate-limited key.
        let sweepRound = 0;
        while (
          failedRanges.length > 0 &&
          sweepRound < MAX_SWEEP_ROUNDS &&
          !globalAbort.signal.aborted
        ) {
          sweepRound++;
          if (typeof onProgress === 'function') onProgress(); // heartbeat before the cooldown wait
          Logger.info(
            'Translator',
            `[SWEEP] Round ${sweepRound}: re-checking ${failedRanges.length} missed batch(es).`
          );

          const waitMs = soonestCooldownWaitMs(activeKeys, keyCooldowns, Date.now());
          if (waitMs > 0) {
            sendDebugLog(
              tabId,
              `Re-checking ${failedRanges.length} missed batch(es) — waiting ${Math.round(waitMs / 1000)}s for cooldown...`,
              '#f59e0b'
            );
            await wait(waitMs);
          } else {
            sendDebugLog(
              tabId,
              `Re-checking ${failedRanges.length} missed batch(es) (sweep round ${sweepRound})...`,
              '#f59e0b'
            );
          }

          const stillFailed = [];
          for (const range of failedRanges) {
            if (globalAbort.signal.aborted) {
              stillFailed.push(range);
              continue;
            }

            // Per-batch timeout for the retry too (chained to globalAbort).
            const sweepAbort = new AbortController();
            const linkSweep = () => sweepAbort.abort();
            if (globalAbort.signal.aborted) sweepAbort.abort();
            else globalAbort.signal.addEventListener('abort', linkSweep, { once: true });
            const sweepTimer = setTimeout(() => sweepAbort.abort(), BATCH_TIMEOUT_MS);

            let r;
            try {
              r = await translateBatchWithFailover(
                range.segments,
                src,
                tgt,
                activeKeys,
                tabId,
                context,
                {
                  signal: sweepAbort.signal,
                  startGroupIndex: 0,
                  keyGroups,
                }
              );
            } finally {
              clearTimeout(sweepTimer);
              globalAbort.signal.removeEventListener('abort', linkSweep);
            }

            if (r.success) {
              anyBatchSucceeded = true;
              r.translated.forEach((t, j) => {
                if (range.start + j < finalResults.length) finalResults[range.start + j] = t;
              });
              if (r.hadFallback) globalHadFallback = true;
              if (r.stats) {
                stats.totalTokens += r.stats.usage?.totalTokens || 0;
                stats.promptTokens += r.stats.usage?.promptTokens || 0;
                stats.completionTokens += r.stats.usage?.completionTokens || 0;
              }
              if (typeof onBatchComplete === 'function') onBatchComplete(range.start, r.translated);
              sendDebugLog(
                tabId,
                `Recovered missed batch at line ${range.start + 1} (sweep round ${sweepRound})`,
                '#10b981'
              );
            } else {
              if (r.failures) allFailures.push(...r.failures);
              stillFailed.push(range);
            }
            if (typeof onProgress === 'function') onProgress(); // heartbeat each sweep retry
          }
          failedRanges = stillFailed;
        }

        const incompleteAfterSweep = failedRanges.length > 0;
        if (incompleteAfterSweep) {
          Logger.warn(
            'Translator',
            `[SWEEP] ${failedRanges.length} batch(es) still missing after ${sweepRound} sweep round(s).`
          );
          sendDebugLog(
            tabId,
            `${failedRanges.length} batch(es) still failed after ${sweepRound} sweep round(s)`,
            '#ef4444'
          );
        }

        stats.durationMs = performance.now() - startTimeFull;
        Logger.info('Translator', '[CHECKPOINT 6] Translation pipeline complete.');

        // Phase 64 (sweep): a run is successful only if at least one batch
        // succeeded AND nothing remained missed after the sweep. An incomplete
        // result is reported as a failure (the content side keeps the already
        // streamed partials via the preserve-partials path).
        const succeeded = anyBatchSucceeded && !incompleteAfterSweep;
        return {
          success: succeeded,
          translated: finalResults,
          hadFallback: globalHadFallback,
          stats,
          failures: allFailures,
          ...(succeeded
            ? {}
            : {
                failureReason: anyBatchSucceeded ? 'INCOMPLETE_AFTER_SWEEP' : 'ALL_BATCHES_FAILED',
              }),
        };
      } catch (err) {
        Logger.error('Translator', `[CRITICAL_FAIL] ${err.message}`, { stack: err.stack });
        return { success: false, failureReason: 'INTERNAL_TRANSLATOR_ERROR', error: err.message };
      }
    })(),
    new Promise((resolve) =>
      setTimeout(() => {
        Logger.error(
          'Translator',
          `[TIMEOUT_GUARD] Translation aborted after ${Math.round(forceTimeoutMs / 1000)}s safety limit.`
        );
        globalAbort.abort(); // Phase 47: Kill all in-flight fetches
        resolve({ success: false, failureReason: 'TRANSLATOR_FORCE_TIMEOUT' });
      }, forceTimeoutMs)
    ),
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

function buildVerificationPrompt(src, tgt, count) {
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

function parseVerificationResponse(responseText, expectedCount) {
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
function parseJsonResponse(responseText, segments) {
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
    Logger.trace(
      'Translator',
      `[JSON_PARSE] Object format: ${validCount}/${expected} placed by index`
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

// Phase 75c: shared post-success pipeline (merge-fix -> sanitize -> untranslated
// verify -> final sanitize). Extracted verbatim from the two identical blocks
// that followed a successful JSON parse and a successful text parse in
// tryKeyForBatch — behavior-preserving dedup. Callers report health and pass the
// parsed lines + their own hadFallback signal.
async function finalizeSuccessfulBatch(
  rawLines,
  segments,
  key,
  tabId,
  options,
  hadFallback,
  result
) {
  let fixedLines;
  if (options._skipMergeFix) {
    fixedLines = rawLines;
  } else {
    const fixResult = await MergeFixer.fix(
      segments,
      rawLines,
      options.src || 'auto',
      options.tgt || 'vi'
    );
    fixedLines = fixResult.lines;
    const pendingCount = fixResult.pendingIndices.length;
    if (pendingCount > 0) {
      Logger.info(
        'Translator',
        `[MERGE_FIX] Shift detected: ${pendingCount} lines pending re-translation (${key.provider})`
      );
      sendDebugLog(
        tabId,
        `MergeFixer: ${pendingCount} shifted lines, re-translating...`,
        '#f59e0b'
      );
      fixedLines = await retranslateShiftedLines(
        segments,
        fixedLines,
        fixResult.pendingIndices,
        key,
        tabId,
        options
      );
      sendDebugLog(
        tabId,
        `MergeFixer: Re-translation done (${pendingCount} lines filled)`,
        '#10b981'
      );
    } else {
      Logger.trace(
        'Translator',
        `[MERGE_FIX] Clean batch - no merges (${segments.length} lines, ${key.provider})`
      );
    }

    const contaminated = detectForeignScriptLines(fixedLines, options.tgt || 'vi');
    if (contaminated.length > 0) {
      Logger.info(
        'Translator',
        `[SANITIZE] Foreign script in ${contaminated.length} lines, re-translating (${key.provider})`
      );
      sendDebugLog(
        tabId,
        `Foreign script: ${contaminated.length} contaminated lines, re-translating...`,
        '#f59e0b'
      );
      fixedLines = await retranslateShiftedLines(
        segments,
        fixedLines,
        contaminated,
        key,
        tabId,
        options
      );
      sendDebugLog(tabId, `Foreign script: Re-translation done`, '#10b981');
    }

    const untranslated = detectUntranslatedLines(fixedLines, segments, options.tgt || 'vi');
    if (untranslated.length > 0) {
      Logger.info(
        'Translator',
        `[UNTRANSLATED] ${untranslated.length} lines may be untranslated, verifying (${key.provider})`
      );
      sendDebugLog(
        tabId,
        `Untranslated: ${untranslated.length} lines, verifying with LLM...`,
        '#f59e0b'
      );
      fixedLines = await retranslateWithVerification(
        segments,
        fixedLines,
        untranslated,
        key,
        tabId,
        options
      );
      sendDebugLog(tabId, `Untranslated: Verification done`, '#10b981');
    }
  }
  const finalLines = options._skipSanitize
    ? fixedLines
    : sanitizeForeignScript(fixedLines, segments, options.tgt || 'vi');
  return {
    status: 'success',
    translated: finalLines,
    hadFallback,
    hadRateLimit: false,
    stats: { usage: result.usage, model: result.model },
  };
}

// Phase 57: Try a single API key for a batch. Returns structured status.
// Phase D6 (DEFERRED): provider call with transient-retry (timeouts + 5xx).
// Extracted verbatim from tryKeyForBatch — behavior-preserving. Loops up to
// RETRY_ATTEMPTS times, retrying only transient failures, and returns the final
// { result, duration }. (Both stay undefined if an aborted signal breaks the loop
// before the first attempt — the caller's existing try/catch then surfaces that as
// a thrown 'exception', matching the prior inline behavior.)
async function callProviderWithRetry({
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

// Phase D6 (DEFERRED): timestamp text parser. Extracted verbatim from
// tryKeyForBatch — behavior-preserving; mirrors parseJsonResponse's shape. Maps
// [HH:MM:SS]-tagged response text back onto segments by normalized timestamp
// (queued FIFO per tag), keeping the original segment text where no tag matched.
// Returns { lines, validCount }.
function parseTimestampedText(responseText, segments) {
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

async function tryKeyForBatch(key, segments, systemPrompt, userPrompt, tabId, options = {}) {
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
    Logger.trace(
      'Translator',
      `[JSON_MODE] Enabled for ${key.provider} (${segments.length} segments)`
    );
  }

  try {
    const settings = await browser.storage.local.get(['yousub_streaming_mode']);
    const isStreaming = settings.yousub_streaming_mode === true && !useJsonMode;
    const estimatedOutputTokens = useJsonMode
      ? Math.min(segments.length * 130, 16384)
      : Math.min(segments.length * 100, 8192);

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
              options,
              jsonResult.hadMismatch || jsonResult.validCount < segments.length,
              result
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
          options,
          validLinesCount < segments.length,
          result
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
      .map((s, i) => `#${i + 1} ${formatTimestamp(s.startMs)} ${s.text}`)
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
async function translateBatchWithFailover(
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

        switch (result.status) {
          case 'success':
            return {
              success: true,
              translated: result.translated,
              hadFallback: result.hadFallback,
              hadRateLimit: false,
              stats: result.stats,
            };
          case '429':
            hadRateLimit = true;
            failures.push({
              provider: key.provider,
              model: key.model,
              status: 429,
              message: result.message,
            });
            break;
          case '413':
            had413 = true;
            skip413Group = true;
            failures.push({
              provider: key.provider,
              model: key.model,
              status: 413,
              message: result.message,
            });
            break;
          case 'cooldown':
            // Phase 64 (d): surface rate-limit cooldown as a 429 so the UI shows
            // a clear "[429] rate limited" row instead of a cryptic "cooldown".
            hadRateLimit = true;
            failures.push({
              provider: key.provider,
              model: key.model,
              status: 429,
              message: 'Key on cooldown (rate limited)',
            });
            break;
          case 'aborted':
            return {
              translated: segments.map((s) => s.text),
              hadFallback: true,
              hadRateLimit: false,
            };
          default:
            failures.push({
              provider: key.provider,
              model: key.model,
              message: result.message || result.status,
            });
            break;
        }
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

      switch (result.status) {
        case 'success':
          return {
            success: true,
            translated: result.translated,
            hadFallback: result.hadFallback,
            hadRateLimit: false,
            stats: result.stats,
          };
        case '429':
          hadRateLimit = true;
          failures.push({
            provider: key.provider,
            model: key.model,
            status: 429,
            message: result.message,
          });
          break;
        case '413':
          had413 = true;
          failures.push({
            provider: key.provider,
            model: key.model,
            status: 413,
            message: result.message,
          });
          break;
        case 'cooldown':
          // Phase 64 (d): surface rate-limit cooldown as a 429 (see group loop above).
          hadRateLimit = true;
          failures.push({
            provider: key.provider,
            model: key.model,
            status: 429,
            message: 'Key on cooldown (rate limited)',
          });
          break;
        case 'aborted':
          return {
            translated: segments.map((s) => s.text),
            hadFallback: true,
            hadRateLimit: false,
          };
        default:
          failures.push({
            provider: key.provider,
            model: key.model,
            message: result.message || result.status,
          });
          break;
      }
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

/**
 * Generate a context summary of the video based on the full transcript.
 */
async function generateContextSummary(texts, apiKeys, tabId, src, _tgt) {
  // Phase 37: Sample only the first 100 lines for context to save tokens and stay within TPM
  const sampleTexts = texts.slice(0, 100);
  const fullTranscript = sampleTexts.join('\n');
  const summaryPrompt = `You are a professional content analyzer.
Below is the FULL transcript of a video in ${src}. 
Provide a about 200 words summary in English of the video's topic, context, and key terms to help a translator keep consistency (especially for pronouns and specialized vocabulary). 
Return ONLY the summary.`;

  sendDebugLog(tabId, 'Analyzing FULL transcript for video context...', '#3b82f6');

  for (const key of apiKeys) {
    try {
      // Phase 57: Per-provider payload awareness — truncate for Groq if too large
      let transcript = fullTranscript;
      if (key.provider === 'groq') {
        const estimatedBytes = (summaryPrompt.length + transcript.length) * 2;
        if (estimatedBytes > MAX_PAYLOAD_BYTES) {
          const maxChars = Math.floor(MAX_PAYLOAD_BYTES / 2) - summaryPrompt.length - 200;
          transcript = transcript.substring(0, Math.max(1000, maxChars));
          Logger.trace(
            'Translator',
            `Truncated transcript to ${transcript.length} chars for Groq context summary`
          );
        }
      }

      const result = await Providers.chat(key.provider, key.model, key.apiKey, transcript, {
        systemPrompt: summaryPrompt,
        temperature: 0.3,
      });

      if (result.success && result.text) {
        let summary = result.text.trim();
        if (summary.length > MAX_CONTEXT_CHARS) {
          summary = summary.substring(0, MAX_CONTEXT_CHARS) + '...';
        }
        Logger.info(
          'Translator',
          'Context summary generated: ' + summary.substring(0, 100) + '...'
        );
        return summary;
      }

      if (result.statusCode === 429) {
        Logger.trace('Translator', `Context summary: 429 from ${key.provider}, trying next...`);
      }
    } catch {
      Logger.warn('Translator', `Failed to generate summary with ${key.provider}`);
    }
  }
  return 'General video content.';
}

/**
 * Noise reduction: Strip common LLM artifacts to extract raw subtitle lines.
 */
function cleanResponse(text) {
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
    Logger.error('Translator', 'Failed to save debug batch', { error: e.message });
  }
}

/**
 * Helper: Forward important debug info directly to content script's console
 */
function sendDebugLog(tabId, msg, color = '#cbd5e1', bold = false) {
  if (!tabId) return;
  try {
    browser.tabs
      .sendMessage(tabId, {
        type: 'YOUSUB_DEBUG_LOG',
        msg,
        color,
        bold,
      })
      .catch(() => {}); // Catch if tab is closed
  } catch {}
}

export const _internals = {
  detectForeignScriptLines,
  sanitizeForeignScript,
  NON_LATIN_TARGETS,
  detectUntranslatedLines,
  parseVerificationResponse,
  MIN_WORDS_FOR_UNTRANSLATED,
  UNTRANSLATED_OVERLAP_THRESHOLD,
  // Phase 64: timeout scaling + sweep cooldown pacing (pure, unit-tested)
  computeForceTimeoutMs,
  soonestCooldownWaitMs,
  getCooldownKey,
  BATCH_TIMEOUT_MS,
  BASE_FORCE_TIMEOUT_MS,
  MAX_FORCE_TIMEOUT_MS,
  MAX_SWEEP_ROUNDS,
  SWEEP_MAX_WAIT_MS,
  // Phase 69: additional pure helpers exposed for unit testing (no behavior change)
  formatTimestamp,
  normalizeTs,
  buildSystemPrompt,
  buildJsonSystemPrompt,
  buildJsonUserPrompt,
  buildVerificationPrompt,
  getProviderJsonConfig,
  parseJsonResponse,
  parseTimestampedText,
  cleanResponse,
  partitionKeysByProvider,
  splitForGroqPayload,
  groupByPhysicalKey,
  sortGroupsByHealth,
  selectGroupForBatch,
  MAX_PAYLOAD_BYTES,
};
