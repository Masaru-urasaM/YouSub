import { Logger } from '../shared/logger.js';
import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { APIManager } from './api-manager.js';
import { Providers } from './providers.js';
import { HealthManager } from './health.js';
import { Cache } from './cache.js';
import { cleanResponse } from './translator-prompts.js';
import { saveDebugBatch } from './translator-quality.js';
import { maskApiKey } from '../shared/pipeline-telemetry.js';

/**
 * video-transcriber.js — Gemini YouTube URL Video Transcription Fallback
 *
 * Generates timestamped (and translated) subtitles directly from a public
 * YouTube URL using the user's configured Google Gemini API key when native
 * YouTube transcripts / caption tracks are unavailable.
 *
 * Designed for windowed playback-driven fetching:
 * - Fixed safe window size W = 240s (4 minutes), calibrated with
 *   MEDIA_RESOLUTION_LOW + fps = 0.2 so even two consecutive batches fit
 *   comfortably under ~80% of Free Tier TPM/RPM ceilings.
 */

export const DEFAULT_WINDOW_SEC = 240;
export const DEFAULT_FPS = 0.2;
export const MEDIA_RESOLUTION_LOW = 'MEDIA_RESOLUTION_LOW';
export const VIDEO_REQUEST_TIMEOUT_MS = 90000;
export const GEMINI_VIDEO_FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

const SUBTITLE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          startSec: { type: 'NUMBER' },
          endSec: { type: 'NUMBER' },
          original: { type: 'STRING' },
          translated: { type: 'STRING' },
        },
        required: ['startSec', 'endSec', 'original', 'translated'],
      },
    },
  },
  required: ['lines'],
};

/**
 * Normalize a YouTube video ID (regular watch or Shorts) into a canonical public watch URL.
 */
export function normalizeYouTubeVideoUrl(videoId) {
  if (!videoId || typeof videoId !== 'string') return null;
  const trimmed = videoId.trim();
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(trimmed)) return null;
  return `https://www.youtube.com/watch?v=${trimmed}`;
}

/**
 * Compute start/end boundaries for 0-indexed window `batchIndex`.
 */
export function computeBatchRange(batchIndex, durationSec, windowSec = DEFAULT_WINDOW_SEC) {
  if (
    !Number.isInteger(batchIndex) ||
    batchIndex < 0 ||
    !Number.isFinite(windowSec) ||
    windowSec <= 0
  ) {
    return null;
  }

  const startSec = batchIndex * windowSec;
  const hasKnownDuration = Number.isFinite(durationSec) && durationSec > 0;
  if (hasKnownDuration && startSec >= durationSec) return null;

  const endSec = hasKnownDuration
    ? Math.min((batchIndex + 1) * windowSec, durationSec)
    : (batchIndex + 1) * windowSec;
  if (endSec <= startSec) return null;

  return {
    batchIndex,
    startSec,
    endSec,
    startMs: Math.round(startSec * 1000),
    endMs: Math.round(endSec * 1000),
  };
}

export function getTotalBatches(durationSec, windowSec = DEFAULT_WINDOW_SEC) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  if (!Number.isFinite(windowSec) || windowSec <= 0) return null;
  return Math.ceil(durationSec / windowSec);
}

/**
 * Select a Gemini model suitable for YouTube URL multimodal input.
 */
export function resolveGeminiVideoModel(configuredModel) {
  if (!configuredModel || configuredModel === 'auto' || /^gemini-1\.5-/i.test(configuredModel)) {
    return 'gemini-2.5-flash';
  }
  return configuredModel;
}

function formatSecLabel(sec) {
  const whole = Math.max(0, Math.floor(sec));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function buildGeminiVideoPrompt(targetLang, startSec, endSec) {
  const langObj = YOUSUB_PROVIDERS.languages.find((l) => l.code === targetLang);
  const targetLangName = langObj ? langObj.name : targetLang || 'Vietnamese';
  const startLabel = formatSecLabel(startSec);
  const endLabel = formatSecLabel(endSec);

  return (
    `Transcribe all spoken dialogue in this video clip (${startLabel} to ${endLabel}, i.e. ${startSec}s to ${endSec}s) ` +
    `and translate each subtitle cue naturally into ${targetLangName}.\n` +
    `Rules:\n` +
    `1. Return JSON matching the schema: {"lines":[{"startSec":number,"endSec":number,"original":string,"translated":string}]}.\n` +
    `2. Use ABSOLUTE timestamps in seconds relative to the start of the full video (between ${startSec} and ${endSec}).\n` +
    `3. Split into concise, natural subtitle cues (about 1 to 2 sentences, roughly 2 to 7 seconds each) in chronological order.\n` +
    `4. "original" must be in the spoken language; "translated" must be natural ${targetLangName}.\n` +
    `5. If there is NO spoken speech in this segment (only silence, music, or sound effects), return {"lines":[]}. Never invent or hallucinate dialogue.`
  );
}

export function buildGeminiVideoPayloadOptions({
  videoUrl,
  startSec,
  endSec,
  fps = DEFAULT_FPS,
  targetLang = 'vi',
  model = 'gemini-2.5-flash',
  signal = null,
}) {
  const prompt = buildGeminiVideoPrompt(targetLang, startSec, endSec);
  const supportsThinkingConfig = /^gemini-(?:2\.5|3)/i.test(model);

  return {
    prompt,
    options: {
      temperature: 0.2,
      maxTokens: 65535,
      timeoutMs: VIDEO_REQUEST_TIMEOUT_MS,
      mediaResolution: MEDIA_RESOLUTION_LOW,
      ...(supportsThinkingConfig ? { thinkingBudget: 0 } : {}),
      responseFormat: { type: 'json_schema' },
      responseSchema: SUBTITLE_RESPONSE_SCHEMA,
      parts: [
        {
          fileData: {
            fileUri: videoUrl,
          },
          videoMetadata: {
            startOffset: `${startSec}s`,
            endOffset: `${endSec}s`,
            fps,
          },
        },
        { text: prompt },
      ],
      ...(signal ? { signal } : {}),
    },
  };
}

/**
 * Parse a timestamp value (seconds number, numeric string, or MM:SS / HH:MM:SS) to ms.
 */
export function parseTimestampToMs(val) {
  if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
    return Math.round(val * 1000);
  }
  if (typeof val !== 'string') return NaN;

  const trimmed = val.trim().replace(/^\[|\]$/g, '');
  if (!trimmed) return NaN;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.round(parseFloat(trimmed) * 1000);
  }

  const partsMatch = trimmed.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!partsMatch) return NaN;

  const hours = partsMatch[1] ? parseInt(partsMatch[1], 10) : 0;
  const mins = parseInt(partsMatch[2], 10);
  const secs = parseFloat(partsMatch[3]);
  if (mins >= 60 || secs >= 60) return NaN;
  return Math.round((hours * 3600 + mins * 60 + secs) * 1000);
}

function extractJsonPayload(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = cleanResponse(rawText);
  try {
    return JSON.parse(cleaned);
  } catch {
    const objStart = cleaned.indexOf('{');
    const objEnd = cleaned.lastIndexOf('}');
    if (objStart !== -1 && objEnd > objStart) {
      try {
        return JSON.parse(cleaned.slice(objStart, objEnd + 1));
      } catch {
        /* continue */
      }
    }
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd > arrStart) {
      try {
        return JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Parse, offset-normalize, clamp, sort, and de-overlap Gemini video output entries.
 */
export function sanitizeGeminiVideoEntries(rawText, batchStartMs, batchEndMs) {
  const parsed = extractJsonPayload(rawText);
  if (!parsed) return [];

  const rawLines = Array.isArray(parsed) ? parsed : Array.isArray(parsed.lines) ? parsed.lines : [];
  if (rawLines.length === 0) return [];

  const parsedItems = [];
  for (const item of rawLines) {
    if (!item || typeof item !== 'object') continue;
    const startMs = parseTimestampToMs(item.startSec ?? item.startMs ?? item.start);
    const endMs = parseTimestampToMs(item.endSec ?? item.endMs ?? item.end);
    const original = String(item.original ?? item.source ?? item.text ?? '').trim();
    const translated = String(item.translated ?? item.text ?? item.translation ?? original).trim();

    if (Number.isNaN(startMs) || (!original && !translated)) continue;
    parsedItems.push({
      startMs,
      endMs: Number.isNaN(endMs) ? startMs + 3000 : endMs,
      original: original || translated,
      text: translated || original,
    });
  }

  if (parsedItems.length === 0) return [];

  // Detect whether Gemini returned chunk-relative timestamps (0..window) for a batch > 0.
  const windowMs = Math.max(1000, batchEndMs - batchStartMs);
  let shouldShiftByBatchStart = false;
  if (batchStartMs > 0) {
    const allInRelativeWindow = parsedItems.every(
      (it) => it.startMs >= 0 && it.startMs <= windowMs + 15000
    );
    const hasStrictlyBeforeBatchStart = parsedItems.some(
      (it) => it.startMs < Math.max(0, batchStartMs - 15000)
    );
    const allStrictlyBelowBatchStart = parsedItems.every((it) => it.startMs < batchStartMs);
    if (allInRelativeWindow && (hasStrictlyBeforeBatchStart || allStrictlyBelowBatchStart)) {
      shouldShiftByBatchStart = true;
    }
  }

  const clamped = [];
  for (const item of parsedItems) {
    let startMs = shouldShiftByBatchStart ? item.startMs + batchStartMs : item.startMs;
    let endMs = shouldShiftByBatchStart ? item.endMs + batchStartMs : item.endMs;

    if (endMs <= batchStartMs || startMs >= batchEndMs) continue;
    startMs = Math.max(batchStartMs, Math.min(startMs, batchEndMs));
    endMs = Math.min(batchEndMs, Math.max(startMs + 200, endMs));
    if (endMs <= startMs) continue;

    clamped.push({
      startMs,
      endMs,
      original: item.original,
      text: item.text,
      isAiGenerated: true,
    });
  }

  clamped.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const normalized = [];
  for (const entry of clamped) {
    if (normalized.length > 0) {
      const prev = normalized[normalized.length - 1];
      if (prev.startMs === entry.startMs && prev.endMs === entry.endMs) {
        normalized[normalized.length - 1] = entry;
        continue;
      }
      if (prev.endMs > entry.startMs) {
        prev.endMs = entry.startMs;
        if (prev.endMs <= prev.startMs) {
          normalized.pop();
        }
      }
    }
    normalized.push(entry);
  }

  return normalized;
}

/**
 * Categorize Gemini video API failures so the scheduler knows whether to retry/rotate or abort fatally.
 */
export function classifyGeminiVideoError(status, message = '') {
  const msg = String(message || '').toLowerCase();

  if (
    status === 429 ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('quota')
  ) {
    return { failureReason: 'GEMINI_RATE_LIMITED', retryable: true };
  }

  if (
    status === 401 ||
    msg.includes('api_key_invalid') ||
    msg.includes('api key not valid') ||
    msg.includes('invalid api key')
  ) {
    return { failureReason: 'INVALID_API_KEY', retryable: true };
  }

  const mentionsApiOrModel =
    msg.includes('api key') ||
    msg.includes('model') ||
    msg.includes('billing') ||
    msg.includes('safety');

  if (!mentionsApiOrModel && (!status || status === 400 || status === 403 || status === 404)) {
    const isMediaInaccessible =
      msg.includes('private') ||
      msg.includes('unavailable') ||
      msg.includes('not accessible') ||
      msg.includes('cannot access') ||
      msg.includes('permission') ||
      msg.includes('youtube') ||
      msg.includes('video') ||
      msg.includes('fileuri') ||
      msg.includes('age') ||
      msg.includes('restricted') ||
      status === 403 ||
      status === 404;

    if (isMediaInaccessible) {
      return { failureReason: 'VIDEO_UNAVAILABLE_OR_PRIVATE', retryable: false };
    }
  }

  if (status >= 500 || msg.includes('timed out') || msg.includes('timeout')) {
    return { failureReason: 'GEMINI_TRANSIENT_ERROR', retryable: true };
  }

  return { failureReason: 'GEMINI_ERROR', retryable: true };
}

export async function getActiveGeminiKeys() {
  const keys = await APIManager.getValidKeys();
  return keys
    .filter((k) => {
      if (!k || !k.apiKey) return false;
      if (k.provider === 'google') return true;
      if (k.provider === 'auto') {
        return YOUSUB_PROVIDERS.detectProviderFromKey(k.apiKey) === 'google';
      }
      return false;
    })
    .map((k) => ({ ...k, provider: 'google' }));
}

export async function hasActiveGeminiKey() {
  const keys = await getActiveGeminiKeys();
  return keys.length > 0;
}

/**
 * Transcribe & translate one video time window `[startSec, endSec]` via Gemini YouTube URL input.
 */
export async function transcribeVideoWindow({
  videoId,
  batchIndex,
  startSec,
  endSec,
  durationSec = null,
  targetLang = 'vi',
  windowSec = DEFAULT_WINDOW_SEC,
  fps = DEFAULT_FPS,
  signal = null,
}) {
  if (signal?.aborted) {
    return { success: false, failureReason: 'ABORTED', batchIndex };
  }

  const videoUrl = normalizeYouTubeVideoUrl(videoId);
  if (!videoUrl) {
    return {
      success: false,
      failureReason: 'INVALID_VIDEO_ID',
      error: 'Invalid YouTube video ID',
      batchIndex,
    };
  }

  const range =
    typeof startSec === 'number' && typeof endSec === 'number' && endSec > startSec
      ? {
          batchIndex,
          startSec,
          endSec,
          startMs: Math.round(startSec * 1000),
          endMs: Math.round(endSec * 1000),
        }
      : computeBatchRange(batchIndex, durationSec, windowSec);

  if (!range) {
    return {
      success: false,
      failureReason: 'INVALID_BATCH_RANGE',
      error: 'Batch start exceeds video duration',
      batchIndex,
    };
  }

  const geminiKeys = await getActiveGeminiKeys();
  if (geminiKeys.length === 0) {
    return {
      success: false,
      failureReason: 'NO_GEMINI_KEY',
      error: 'No active Google Gemini API key configured',
      batchIndex,
    };
  }

  let lastError = 'Gemini video transcription failed';
  let lastReason = 'GEMINI_ERROR';
  const triedPairs = new Set();

  for (const keyObj of geminiKeys) {
    const primaryModel = resolveGeminiVideoModel(keyObj.model);
    const candidateModels = [
      primaryModel,
      ...GEMINI_VIDEO_FALLBACK_MODELS.filter((m) => m !== primaryModel),
    ];

    for (const model of candidateModels) {
      if (signal?.aborted) {
        return { success: false, failureReason: 'ABORTED', batchIndex };
      }

      const pairKey = `${keyObj.apiKey.slice(-6)}_${model}`;
      if (triedPairs.has(pairKey)) continue;
      triedPairs.add(pairKey);

      const { prompt, options } = buildGeminiVideoPayloadOptions({
        videoUrl,
        startSec: range.startSec,
        endSec: range.endSec,
        fps,
        targetLang,
        model,
        signal,
      });

      Logger.info(
        'VideoTranscriber',
        `Transcribing ${videoId} batch #${batchIndex + 1} (${range.startSec}s-${range.endSec}s) using ${model}`
      );

      const startTime = performance.now();
      const res = await Providers.chat('google', model, keyObj.apiKey, prompt, options);
      const elapsedMs = Math.round(performance.now() - startTime);

      if (signal?.aborted) {
        return { success: false, failureReason: 'ABORTED', batchIndex };
      }

      if (res.success && typeof res.text === 'string') {
        const entries = sanitizeGeminiVideoEntries(res.text, range.startMs, range.endMs);
        await HealthManager.report('google', keyObj.apiKey, true, elapsedMs);
        await Cache.mergeGeneratedBatch(videoId, targetLang, {
          windowSec,
          durationSec,
          batchIndex,
          entries,
        });
        saveDebugBatch({
          timestamp: new Date().toISOString(),
          provider: 'google',
          model,
          mode: 'gemini-video',
          windowRange: `${range.startSec}s-${range.endSec}s`,
          input: `[Gemini Video URL] ${videoUrl} (${range.startSec}s-${range.endSec}s)\n${prompt}`,
          output: res.text,
          systemPrompt: `mediaResolution=${MEDIA_RESOLUTION_LOW}, fps=${fps}`,
          success: true,
          duration: `${elapsedMs}ms`,
        });

        Logger.info(
          'VideoTranscriber',
          `Batch #${batchIndex + 1} complete for ${videoId}: ${entries.length} entries (${elapsedMs}ms)`,
          {
            videoId,
            batchIndex,
            model,
            keyMask: maskApiKey(keyObj.apiKey),
            entryCount: entries.length,
            elapsedMs,
            usage: res.usage,
          }
        );

        return {
          success: true,
          batchIndex,
          entries,
          model,
          provider: 'google',
          keyMask: maskApiKey(keyObj.apiKey),
          usage: res.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          durationMs: elapsedMs,
          startMs: range.startMs,
          endMs: range.endMs,
        };
      }

      const classified = classifyGeminiVideoError(res.status ?? res.statusCode, res.message);
      lastError = res.message || lastError;
      lastReason = classified.failureReason;

      await HealthManager.report('google', keyObj.apiKey, false, elapsedMs);
      saveDebugBatch({
        timestamp: new Date().toISOString(),
        provider: 'google',
        model,
        mode: 'gemini-video',
        windowRange: `${range.startSec}s-${range.endSec}s`,
        input: `[Gemini Video URL] ${videoUrl} (${range.startSec}s-${range.endSec}s)`,
        output: lastError,
        systemPrompt: `mediaResolution=${MEDIA_RESOLUTION_LOW}, fps=${fps}`,
        success: false,
        duration: `${elapsedMs}ms`,
      });
      Logger.warn(
        'VideoTranscriber',
        `Batch #${batchIndex + 1} failed on ${model} (${classified.failureReason}): ${lastError}`
      );

      if (!classified.retryable) {
        return {
          success: false,
          failureReason: classified.failureReason,
          error: lastError,
          batchIndex,
        };
      }

      // Invalid key: skip remaining models on this same key and try next key.
      if (classified.failureReason === 'INVALID_API_KEY') break;
    }
  }

  return {
    success: false,
    failureReason: lastReason,
    error: lastError,
    batchIndex,
  };
}
