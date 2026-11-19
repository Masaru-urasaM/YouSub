import { Logger } from '../shared/logger.js';
import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { PipelineTelemetry, maskApiKey } from '../shared/pipeline-telemetry.js';
import {
  TRANSLATION_STYLE_KEY,
  CUSTOM_PROMPT_KEY,
  CUSTOM_GLOSSARY_KEY,
} from '../shared/constants.js';
import { buildTranslationGuidanceBlock } from '../shared/video-context.js';
import { APIManager } from './api-manager.js';
import { Providers } from './providers.js';
import '../shared/libs/browser-polyfill.js';
import {
  MAX_PAYLOAD_BYTES,
  MIN_WORDS_FOR_UNTRANSLATED,
  UNTRANSLATED_OVERLAP_THRESHOLD,
  NON_LATIN_TARGETS,
  detectForeignScriptLines,
  sanitizeForeignScript,
  detectUntranslatedLines,
  formatTimestamp,
  normalizeTs,
  cleanResponse,
  buildSystemPrompt,
  getProviderJsonConfig,
  buildJsonSystemPrompt,
  buildJsonUserPrompt,
  buildVerificationPrompt,
  parseVerificationResponse,
  parseJsonResponse,
  parseTimestampedText,
  partitionKeysByProvider,
  splitForGroqPayload,
} from './translator-prompts.js';
import {
  saveDebugBatch,
  sendDebugLog,
  buildRoughTranslateDelegate,
  ROUGH_DELEGATE_TIMEOUT_MS,
} from './translator-quality.js';
import {
  SWEEP_MAX_WAIT_MS,
  keyCooldowns,
  wait,
  getCooldownKey,
  soonestCooldownWaitMs,
  groupByPhysicalKey,
  sortGroupsByHealth,
  selectGroupForBatch,
  translateBatchWithFailover,
} from './translator-failover.js';

/**
 * translator.js — Multi-Provider LLM Translation Engine (Orchestrator)
 *
 * Extracted helpers live in:
 * - translator-prompts.js  (prompts, JSON/text parsers, sanitization, Groq sizing)
 * - translator-quality.js  (MergeFixer verification, retranslation, debug log helpers)
 * - translator-failover.js (key grouping, cooldowns, retry loop, Groq waterfall, 413 splits)
 */

// Critical: MAX_LINES_PER_BATCH is not the problem. STOP MENTIONING IT, STOP CHANGING IT, STOP TALKING ABOUT IT. STOP THINKING ABOUT IT.

const MAX_LINES_PER_BATCH = 50;
const INITIAL_BATCH_DELAY_MS = 50;
const ELEVATED_BATCH_DELAY_MS = 3000;

// Phase 64 (c): Per-batch timeout replaces the old single per-job cap.
const BATCH_TIMEOUT_MS = 90000;
const BASE_FORCE_TIMEOUT_MS = 180000;
const PER_LINE_TIMEOUT_MS = 2500;
const MAX_FORCE_TIMEOUT_MS = 600000;

// Phase 64 (sweep): retry missed batches up to MAX_SWEEP_ROUNDS rounds.
const MAX_SWEEP_ROUNDS = 3;
const MAX_CONTEXT_CHARS = 500; // Cap context summary to prevent permanent 413

// Phase 54.2: Request deduplication — track in-flight translations by videoId+lang
const inFlightRequests = new Map();

function computeForceTimeoutMs(segmentCount) {
  return Math.min(
    Math.max(BASE_FORCE_TIMEOUT_MS, (segmentCount || 0) * PER_LINE_TIMEOUT_MS),
    MAX_FORCE_TIMEOUT_MS
  );
}

/**
 * Partition segments into fixed-size batches carrying timestamp bounds so
 * playhead seek events can prioritize arbitrary regions cleanly.
 */
export function buildBatchQueue(segments, batchSize = MAX_LINES_PER_BATCH) {
  const safeSize = Math.max(1, Number.isInteger(batchSize) ? batchSize : MAX_LINES_PER_BATCH);
  const batches = [];
  let cursor = 0;
  let batchIndex = 0;

  while (cursor < segments.length) {
    const slice = segments.slice(cursor, cursor + safeSize);
    const nextSeg = segments[cursor + slice.length];
    const startMs = slice[0]?.startMs ?? 0;
    const lastSeg = slice[slice.length - 1];
    const endMs =
      typeof lastSeg?.endMs === 'number'
        ? lastSeg.endMs
        : typeof nextSeg?.startMs === 'number'
          ? nextSeg.startMs
          : (lastSeg?.startMs ?? startMs) + 5000;

    batches.push({
      batchIndex,
      start: cursor,
      end: cursor + slice.length,
      length: slice.length,
      startMs,
      endMs,
      segments: slice,
      status: 'PENDING',
      provider: '',
      model: '',
      keyMask: '',
      durationMs: 0,
      isSeekTarget: false,
    });
    cursor += slice.length;
    batchIndex++;
  }

  return batches;
}

/**
 * Map a playback position in milliseconds to the batch index covering it.
 */
export function findBatchIndexForPlayhead(batches, playheadMs) {
  if (!Array.isArray(batches) || batches.length === 0) return 0;
  const targetMs =
    typeof playheadMs === 'number' && Number.isFinite(playheadMs) ? Math.max(0, playheadMs) : 0;
  if (targetMs === 0) return 0;

  let anchor = 0;
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    if (b.startMs <= targetMs) {
      anchor = i;
    }
    if (targetMs >= b.startMs && targetMs < b.endMs) {
      return i;
    }
  }
  return anchor;
}

/**
 * Select the next PENDING batch according to Seek-Aware Priority:
 * 1) Current playhead batch, 2) 1-batch lookahead, 3) forward batches, 4) earlier backfill.
 */
export function selectNextPendingBatchIndex(batches, playheadMs = 0) {
  if (!Array.isArray(batches) || batches.length === 0) return -1;
  const anchorIdx = findBatchIndexForPlayhead(batches, playheadMs);

  if (batches[anchorIdx] && batches[anchorIdx].status === 'PENDING') {
    return anchorIdx;
  }
  if (anchorIdx + 1 < batches.length && batches[anchorIdx + 1].status === 'PENDING') {
    return anchorIdx + 1;
  }
  for (let i = anchorIdx + 2; i < batches.length; i++) {
    if (batches[i].status === 'PENDING') return i;
  }
  for (let i = 0; i < anchorIdx; i++) {
    if (batches[i].status === 'PENDING') return i;
  }
  return -1;
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
  onProgress = null,
  options = {}
) {
  if (!segments || segments.length === 0) return { translated: [], hadFallback: false };

  // Phase 55: Filter out invalid segments before translation
  segments = segments.filter((s) => s && s.text && typeof s.startMs === 'number');
  if (segments.length === 0) return { translated: [], hadFallback: false };

  const src = sourceLang || 'auto';
  const tgt = targetLang || 'vi';

  // Phase 54.2: Dedup — return existing Promise if same tab+video+lang is already translating
  const dedupKey = `${tabId}_${options?.videoId || ''}_${src}_${tgt}`;
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
    onProgress,
    options
  );
  inFlightRequests.set(dedupKey, translatePromise);
  try {
    return await translatePromise;
  } finally {
    inFlightRequests.delete(dedupKey);
  }
}

async function runBatchWithTimeout(batch, src, tgt, activeKeys, tabId, context, globalAbort, opts) {
  const batchAbort = new AbortController();
  const linkAbort = () => batchAbort.abort();
  if (globalAbort.signal.aborted) {
    batchAbort.abort();
  } else {
    globalAbort.signal.addEventListener('abort', linkAbort, { once: true });
  }
  let timedOut = false;
  const batchTimer = setTimeout(() => {
    timedOut = true;
    batchAbort.abort();
  }, BATCH_TIMEOUT_MS);

  let result;
  try {
    result = await translateBatchWithFailover(batch, src, tgt, activeKeys, tabId, context, {
      ...opts,
      signal: batchAbort.signal,
    });
  } finally {
    clearTimeout(batchTimer);
    globalAbort.signal.removeEventListener('abort', linkAbort);
  }
  return { result, timedOut };
}

function buildTelemetryBatches(batches, currentPlayheadMs) {
  const anchorIdx = findBatchIndexForPlayhead(batches, currentPlayheadMs);
  const nextLookahead = selectNextPendingBatchIndex(batches, currentPlayheadMs);
  return batches.map((b, idx) => ({
    batchIndex: b.batchIndex,
    startLine: b.start + 1,
    endLine: b.end,
    startMs: b.startMs,
    endMs: b.endMs,
    status: b.status === 'PENDING' && idx === nextLookahead ? 'PREFETCH' : b.status,
    provider: b.provider || '',
    model: b.model || '',
    keyMask: b.keyMask || '',
    durationMs: b.durationMs || 0,
    isSeekTarget:
      b.isSeekTarget || (idx === anchorIdx && b.status !== 'DONE' && currentPlayheadMs > 0),
  }));
}

async function _translateInternal(
  segments,
  src,
  tgt,
  tabId,
  onBatchComplete,
  externalSignal,
  onProgress,
  options = {}
) {
  const videoId = options.videoId || '';
  const getPlayheadMs =
    typeof options.getPlayheadMs === 'function'
      ? options.getPlayheadMs
      : () => options.initialPlayheadMs || 0;

  Logger.trace('Translator', `[CHECKPOINT 1] Starting translation: ${segments.length} segments`);
  sendDebugLog(
    tabId,
    `Initializing translation pipeline (${segments.length} lines)...`,
    '#2dd4bf',
    true
  );

  const globalAbort = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) {
      globalAbort.abort();
    } else {
      externalSignal.addEventListener('abort', () => globalAbort.abort(), { once: true });
    }
  }

  const forceTimeoutMs = computeForceTimeoutMs(segments.length);
  return await Promise.race([
    (async () => {
      try {
        Logger.trace('Translator', '[CHECKPOINT 2] Fetching valid keys...');
        const activeKeys = await APIManager.getValidKeys();

        if (!activeKeys || activeKeys.length === 0) {
          Logger.warn('Translator', '[CHECKPOINT 2.E] No valid API keys found.');
          if (videoId) {
            PipelineTelemetry.update(videoId, {
              stage: 'ERROR',
              error: { failureReason: 'NO_API_KEYS', message: 'No active API keys configured' },
            });
          }
          return { success: false, failureReason: 'NO_API_KEYS' };
        }
        Logger.trace('Translator', `[CHECKPOINT 2.S] ${activeKeys.length} keys loaded.`);

        const finalResults = new Array(segments.length).fill(null);
        let globalHadFallback = false;
        const stats = {
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          durationMs: 0,
          model: 'unknown',
          provider: '',
          batchCount: 0,
        };

        Logger.trace('Translator', '[CHECKPOINT 3] Analyzing video context...');
        sendDebugLog(tabId, `Analyzing video context (Max 10s)...`, '#3b82f6');

        let guidance = '';
        try {
          let styleId = options.styleId;
          let customPrompt = options.customPrompt;
          let glossary = options.glossary;
          if (styleId === undefined && customPrompt === undefined && glossary === undefined) {
            const storedStyle = await browser.storage.local
              .get([TRANSLATION_STYLE_KEY, CUSTOM_PROMPT_KEY, CUSTOM_GLOSSARY_KEY])
              .catch(() => ({}));
            styleId = storedStyle?.[TRANSLATION_STYLE_KEY] || 'natural';
            customPrompt = storedStyle?.[CUSTOM_PROMPT_KEY] || '';
            glossary = storedStyle?.[CUSTOM_GLOSSARY_KEY] || {};
          }
          guidance = buildTranslationGuidanceBlock({
            styleId: styleId || 'natural',
            customPrompt: customPrompt || '',
            glossary: glossary || {},
            videoTitle: options.videoTitle || '',
            channelName: options.channelName || '',
          });
        } catch {
          guidance = '';
        }

        let context = '';
        try {
          context = await Promise.race([
            generateContextSummary(
              segments.map((s) => s.text),
              activeKeys,
              tabId,
              src,
              tgt,
              { videoTitle: options.videoTitle || '', channelName: options.channelName || '' }
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

        if (context.length > MAX_CONTEXT_CHARS) {
          context = context.substring(0, MAX_CONTEXT_CHARS) + '...';
        }
        if (guidance) {
          context = `${guidance}\n${context}`.slice(0, 1200);
        }

        const startTimeFull = performance.now();
        const totalLines = segments.length;
        let dispatchSeq = 0;
        let anyBatchSucceeded = false;
        let completedCueCount = 0;
        const allFailures = [];
        const recordedFailovers = [];
        const verificationTotals = {
          status: 'clean',
          mergeFixes: 0,
          cascadeShifts: 0,
          retranslatedLines: 0,
          foreignScriptFixes: 0,
          untranslatedFixes: 0,
        };
        let failedRanges = [];

        const keyGroups = groupByPhysicalKey(activeKeys);
        sortGroupsByHealth(keyGroups);
        const queueBatchSize = activeKeys[0]?.maxLinesPerBatch || MAX_LINES_PER_BATCH;
        const batches = buildBatchQueue(segments, queueBatchSize);

        Logger.trace(
          'Translator',
          `[CHECKPOINT 4] Starting seek-aware batch processing (${totalLines} lines, ${batches.length} batches, ${keyGroups.length} key groups)...`
        );

        const initialRoutes = activeKeys.map((k, idx) => {
          const prov =
            k.provider === 'auto'
              ? YOUSUB_PROVIDERS.detectProviderFromKey(k.apiKey) || k.provider
              : k.provider;
          return {
            provider: prov,
            model: YOUSUB_PROVIDERS.resolveModel(prov, k.model),
            keyMask: maskApiKey(k.apiKey),
            score: k.score ?? 0.5,
            status: idx === 0 ? 'active' : 'standby',
          };
        });

        const emitTelemetry = (stage, extra = {}) => {
          if (!videoId) return;
          const phMs = getPlayheadMs();
          PipelineTelemetry.update(videoId, (snap) => ({
            ...snap,
            stage,
            playheadMs: phMs,
            playheadBatchIndex: findBatchIndexForPlayhead(batches, phMs),
            router: {
              ...snap.router,
              activeProvider: stats.provider || initialRoutes[0]?.provider || '',
              activeModel:
                stats.model && stats.model !== 'unknown'
                  ? stats.model
                  : initialRoutes[0]?.model || '',
              routes: initialRoutes.map((r) => ({
                ...r,
                status:
                  r.provider === stats.provider && r.model === stats.model
                    ? 'active'
                    : recordedFailovers.some(
                          (f) => f.fromProvider === r.provider && f.fromModel === r.model
                        )
                      ? 'failover'
                      : r.status,
              })),
              failovers: recordedFailovers.slice(-20),
              ...(extra.router || {}),
            },
            verification: { ...verificationTotals },
            batches: buildTelemetryBatches(batches, phMs),
            sink: {
              ...snap.sink,
              syncedCues: completedCueCount,
              totalCues: totalLines,
              ...(extra.sink || {}),
            },
            metrics: {
              ...stats,
              durationMs: Math.round(performance.now() - startTimeFull),
              completedBatches: batches.filter((b) => b.status === 'DONE').length,
            },
            ...(extra.error ? { error: extra.error } : {}),
          }));
        };

        emitTelemetry('ROUTE');

        while (true) {
          if (globalAbort.signal.aborted) break;

          const currentPlayheadMs = getPlayheadMs();
          const nextIdx = selectNextPendingBatchIndex(batches, currentPlayheadMs);
          if (nextIdx === -1) break;

          const anchorIdx = findBatchIndexForPlayhead(batches, currentPlayheadMs);
          const batchDesc = batches[nextIdx];
          const cursor = batchDesc.start;
          const batch = batchDesc.segments;

          const selected = selectGroupForBatch(keyGroups, dispatchSeq);
          const isSeekPriorityJump =
            nextIdx !== dispatchSeq && (nextIdx === anchorIdx || nextIdx === anchorIdx + 1);
          batchDesc.status = 'IN_FLIGHT';
          batchDesc.isSeekTarget = currentPlayheadMs > 0 && nextIdx === anchorIdx;
          dispatchSeq++;

          if (isSeekPriorityJump) {
            Logger.info(
              'Translator',
              `[SEEK_PRIORITY] Jumping to batch #${batchDesc.batchIndex + 1} (lines ${cursor + 1}-${cursor + batch.length}) for playhead ${currentPlayheadMs}ms`
            );
          }

          emitTelemetry('ROUTE');

          const batchStartTime = performance.now();
          Logger.trace(
            'Translator',
            `[CHECKPOINT 5] Batch ${batchDesc.batchIndex + 1}/${batches.length}: lines ${cursor + 1}-${cursor + batch.length}/${totalLines} (size=${batch.length}, startGroup=${selected?.groupIndex || 0})...`
          );
          sendDebugLog(
            tabId,
            `Translating lines ${cursor + 1}-${cursor + batch.length} / ${totalLines}...`,
            '#a855f7'
          );

          const { result, timedOut } = await runBatchWithTimeout(
            batch,
            src,
            tgt,
            activeKeys,
            tabId,
            context,
            globalAbort,
            { startGroupIndex: selected?.groupIndex || 0, keyGroups }
          );
          if (timedOut) {
            Logger.warn(
              'Translator',
              `[BATCH_TIMEOUT] Batch ${batchDesc.batchIndex + 1} exceeded ${BATCH_TIMEOUT_MS}ms — marking failed for the completeness sweep.`
            );
          }

          const elapsedMs = Math.round(performance.now() - batchStartTime);
          const elapsed = (elapsedMs / 1000).toFixed(1);
          Logger.trace(
            'Translator',
            `[BATCH_RESULT] success=${result.success}, hadFallback=${result.hadFallback}, translatedCount=${result.translated?.length}, sample=${result.translated?.[0]?.substring?.(0, 50)}`
          );

          if (result.failures && result.failures.length > 0) {
            const toProv = result.stats?.provider || '';
            const toModel = result.stats?.model || '';
            for (const f of result.failures) {
              recordedFailovers.push({
                ts: Date.now(),
                fromProvider: f.provider,
                fromModel: f.model,
                toProvider: toProv,
                toModel: toModel,
                reason: f.status ? `HTTP ${f.status}` : f.message || 'error',
              });
            }
          }

          if (result.success) {
            anyBatchSucceeded = true;
            batchDesc.status = 'DONE';
            batchDesc.durationMs = elapsedMs;
            completedCueCount += batch.length;
            Logger.trace(
              'Translator',
              `[CHECKPOINT 5.S] Batch ${batchDesc.batchIndex + 1} DONE in ${elapsed}s (lines ${cursor + 1}-${cursor + batch.length})`
            );
            sendDebugLog(
              tabId,
              `Lines ${cursor + 1}-${cursor + batch.length} OK (${elapsed}s)`,
              '#10b981'
            );

            result.translated.forEach((t, j) => {
              if (cursor + j < finalResults.length) finalResults[cursor + j] = t;
            });

            if (result.stats) {
              stats.totalTokens += result.stats.usage?.totalTokens || 0;
              stats.promptTokens += result.stats.usage?.promptTokens || 0;
              stats.completionTokens += result.stats.usage?.completionTokens || 0;
              stats.model = result.stats.model || stats.model;
              stats.provider = result.stats.provider || stats.provider;
              batchDesc.model = result.stats.model || '';
              batchDesc.provider = result.stats.provider || '';
              batchDesc.keyMask = result.stats.keyMask || '';

              if (result.stats.verification) {
                verificationTotals.mergeFixes += result.stats.verification.mergeFixes || 0;
                verificationTotals.foreignScriptFixes +=
                  result.stats.verification.foreignScriptFixes || 0;
                verificationTotals.untranslatedFixes +=
                  result.stats.verification.untranslatedFixes || 0;
                if (
                  verificationTotals.mergeFixes > 0 ||
                  verificationTotals.foreignScriptFixes > 0 ||
                  verificationTotals.untranslatedFixes > 0
                ) {
                  verificationTotals.status = 'fixed';
                }
              }
            }
          } else {
            batchDesc.status = 'FAILED';
            batchDesc.durationMs = elapsedMs;
            Logger.warn(
              'Translator',
              `[CHECKPOINT 5.E] Batch ${batchDesc.batchIndex + 1} FAILED (lines ${cursor + 1}-${cursor + batch.length}).`
            );
            failedRanges.push({
              start: cursor,
              batchIndex: batchDesc.batchIndex,
              segments: batch,
            });
            batch.forEach((s, j) => {
              if (cursor + j < finalResults.length) finalResults[cursor + j] = s.text;
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

          if (typeof options.onStatsUpdate === 'function') {
            options.onStatsUpdate({
              ...stats,
              durationMs: performance.now() - startTimeFull,
            });
          }

          emitTelemetry('VERIFY', {
            router: {
              keyMask: result.stats?.keyMask || '',
              latencyMs: elapsedMs,
            },
          });

          if (typeof onBatchComplete === 'function' && result.success) {
            onBatchComplete(cursor, result.translated);
          }

          if (typeof onProgress === 'function') onProgress();

          const remainingPending = selectNextPendingBatchIndex(batches, getPlayheadMs());
          if (remainingPending !== -1) {
            const delay = result.hadRateLimit ? ELEVATED_BATCH_DELAY_MS : INITIAL_BATCH_DELAY_MS;
            await wait(delay);
          }
        }

        let sweepRound = 0;
        while (
          failedRanges.length > 0 &&
          sweepRound < MAX_SWEEP_ROUNDS &&
          !globalAbort.signal.aborted
        ) {
          sweepRound++;
          if (typeof onProgress === 'function') onProgress();
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

            if (batches[range.batchIndex]) batches[range.batchIndex].status = 'IN_FLIGHT';
            emitTelemetry('ROUTE');

            const { result: r } = await runBatchWithTimeout(
              range.segments,
              src,
              tgt,
              activeKeys,
              tabId,
              context,
              globalAbort,
              { startGroupIndex: 0, keyGroups }
            );

            if (r.success) {
              anyBatchSucceeded = true;
              if (batches[range.batchIndex]) {
                batches[range.batchIndex].status = 'DONE';
                batches[range.batchIndex].model = r.stats?.model || '';
                batches[range.batchIndex].provider = r.stats?.provider || '';
              }
              completedCueCount += range.segments.length;
              r.translated.forEach((t, j) => {
                if (range.start + j < finalResults.length) finalResults[range.start + j] = t;
              });
              if (r.hadFallback) globalHadFallback = true;
              if (r.stats) {
                stats.totalTokens += r.stats.usage?.totalTokens || 0;
                stats.promptTokens += r.stats.usage?.promptTokens || 0;
                stats.completionTokens += r.stats.usage?.completionTokens || 0;
                stats.model = r.stats.model || stats.model;
                stats.provider = r.stats.provider || stats.provider;
              }
              if (typeof onBatchComplete === 'function') onBatchComplete(range.start, r.translated);
              sendDebugLog(
                tabId,
                `Recovered missed batch at line ${range.start + 1} (sweep round ${sweepRound})`,
                '#10b981'
              );
            } else {
              if (batches[range.batchIndex]) batches[range.batchIndex].status = 'FAILED';
              if (r.failures) allFailures.push(...r.failures);
              stillFailed.push(range);
            }
            emitTelemetry('VERIFY');
            if (typeof onProgress === 'function') onProgress();
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

        const succeeded = anyBatchSucceeded && !incompleteAfterSweep;
        const failureReason = succeeded
          ? undefined
          : incompleteAfterSweep
            ? 'INCOMPLETE_AFTER_SWEEP'
            : 'ALL_BATCHES_FAILED';

        emitTelemetry(succeeded ? 'COMPLETE' : 'ERROR', {
          sink: { syncedCues: completedCueCount, totalCues: totalLines },
          ...(failureReason ? { error: { failureReason } } : {}),
        });

        return {
          success: succeeded,
          translated: finalResults,
          hadFallback: globalHadFallback,
          stats,
          failures: allFailures,
          ...(failureReason ? { failureReason } : {}),
        };
      } catch (err) {
        Logger.error('Translator', 'Fatal translation error', {
          error: err.message,
          stack: err.stack?.split('\n').slice(0, 3).join(' | '),
        });
        if (videoId) {
          PipelineTelemetry.update(videoId, {
            stage: 'ERROR',
            error: { failureReason: 'TRANSLATOR_CRASH', message: err.message },
          });
        }
        return { success: false, failureReason: 'TRANSLATOR_CRASH', error: err.message };
      }
    })(),
    new Promise((resolve) =>
      setTimeout(() => {
        Logger.error('Translator', `Force timeout after ${forceTimeoutMs / 1000}s`);
        globalAbort.abort();
        if (videoId) {
          PipelineTelemetry.update(videoId, {
            stage: 'ERROR',
            error: { failureReason: 'TRANSLATOR_FORCE_TIMEOUT' },
          });
        }
        resolve({ success: false, failureReason: 'TRANSLATOR_FORCE_TIMEOUT' });
      }, forceTimeoutMs)
    ),
  ]);
}

/**
 * Generate a context summary of the video based on the full transcript.
 */
async function generateContextSummary(texts, apiKeys, tabId, src, _tgt, meta = {}) {
  const sampleTexts = texts.slice(0, 100);
  const metaHeader =
    meta.videoTitle || meta.channelName
      ? `Video title: "${meta.videoTitle || ''}". Channel: "${meta.channelName || ''}".\n`
      : '';
  const fullTranscript = sampleTexts.join('\n');
  const summaryPrompt = `You are a professional content analyzer.
${metaHeader}Below is the FULL transcript of a video in ${src}. 
Provide a about 200 words summary in English of the video's topic, context, and key terms to help a translator keep consistency (especially for pronouns and specialized vocabulary). 
Return ONLY the summary.`;

  sendDebugLog(tabId, 'Analyzing FULL transcript for video context...', '#3b82f6');

  for (const key of apiKeys) {
    try {
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
        maxTokens: 800,
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

export const _internals = {
  detectForeignScriptLines,
  sanitizeForeignScript,
  NON_LATIN_TARGETS,
  detectUntranslatedLines,
  parseVerificationResponse,
  MIN_WORDS_FOR_UNTRANSLATED,
  UNTRANSLATED_OVERLAP_THRESHOLD,
  computeForceTimeoutMs,
  soonestCooldownWaitMs,
  getCooldownKey,
  BATCH_TIMEOUT_MS,
  BASE_FORCE_TIMEOUT_MS,
  MAX_FORCE_TIMEOUT_MS,
  MAX_SWEEP_ROUNDS,
  SWEEP_MAX_WAIT_MS,
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
  buildRoughTranslateDelegate,
  ROUGH_DELEGATE_TIMEOUT_MS,
  buildBatchQueue,
  findBatchIndexForPlayhead,
  selectNextPendingBatchIndex,
};
