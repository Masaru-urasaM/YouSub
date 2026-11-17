import { Logger } from '../shared/logger.js';
import { Providers } from './providers.js';
import { MergeFixer } from './merge-fixer.js';
import '../shared/libs/browser-polyfill.js';
import {
  NON_LATIN_TARGETS,
  FOREIGN_SCRIPT_DETECT,
  MIN_WORDS_FOR_UNTRANSLATED,
  UNTRANSLATED_OVERLAP_THRESHOLD,
  detectForeignScriptLines,
  sanitizeForeignScript,
  detectUntranslatedLines,
  formatTimestamp,
  buildSystemPrompt,
  buildVerificationPrompt,
  parseVerificationResponse,
} from './translator-prompts.js';

export const RE_TRANSLATION_MAX_LINES = 12; // max lines per re-translation API call
export const MAX_RETRANSLATION_ROUNDS = 3; // max detect-and-retry rounds

// Phase B-d: backstop timeout for the SW->content rough back-translation delegate
// (MergeFixer merge verification). The content bridge answers within its own 2500ms
// (all-null on its own timeout), so this 3000ms only fires if the content listener
// never responds at all (e.g. the tab navigated away mid-batch).
export const ROUGH_DELEGATE_TIMEOUT_MS = 3000;

/**
 * Phase 51: Save batch debug info to local storage (max 20)
 */
export async function saveDebugBatch(entry) {
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
export function sendDebugLog(tabId, msg, color = '#cbd5e1', bold = false) {
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

// Phase B-d: build the SW->content rough back-translation delegate for MergeFixer's
// merge verification. Chrome's on-device Translator runs in a document / main-world
// context, NOT the service worker, so the SW delegates to the content script via
// tabs.sendMessage; the content bridge runs the on-device Translator and replies.
export function buildRoughTranslateDelegate(tabId, src) {
  if (!tabId || !src || src === 'auto') return undefined;
  return async (texts, s, t) => {
    const allNull = () => texts.map(() => null);
    try {
      const resp = await Promise.race([
        browser.tabs.sendMessage(tabId, {
          type: 'YOUSUB_ROUGH_TRANSLATE',
          texts,
          src: s,
          tgt: t,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('RoughDelegateTimeout')), ROUGH_DELEGATE_TIMEOUT_MS)
        ),
      ]);
      const arr = resp && resp.translations;
      return Array.isArray(arr) && arr.length === texts.length ? arr : allNull();
    } catch {
      return allNull();
    }
  };
}

export async function retranslateShiftedLines(
  segments,
  lines,
  pendingIndices,
  key,
  tabId,
  options,
  tryKeyFn
) {
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
      const reResult = await tryKeyFn(
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

export async function retranslateWithVerification(
  segments,
  lines,
  pendingIndices,
  key,
  _tabId,
  options
) {
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

// Phase 75c: shared post-success pipeline (merge-fix -> sanitize -> untranslated
// verify -> final sanitize).
export async function finalizeSuccessfulBatch(
  rawLines,
  segments,
  key,
  tabId,
  options,
  hadFallback,
  result,
  tryKeyFn
) {
  let fixedLines;
  if (options._skipMergeFix) {
    fixedLines = rawLines;
  } else {
    const roughTranslate = buildRoughTranslateDelegate(tabId, options.src || 'auto');
    const fixResult = await MergeFixer.fix(
      segments,
      rawLines,
      options.src || 'auto',
      options.tgt || 'vi',
      roughTranslate
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
        options,
        tryKeyFn
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
        options,
        tryKeyFn
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
