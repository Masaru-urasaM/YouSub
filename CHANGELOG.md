# Changelog

All notable changes to the YouSub project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Smart Batch Distribution — Round-Robin + Model Rotation (2026-05-14)

**Added**
- `getCooldownKey(apiKey, model)` — model-aware cooldown key (`apiKey::model`), isolates per-model rate limits so a 429 on one model no longer blocks other models of the same provider
- `groupByPhysicalKey(activeKeys)` — groups expanded virtual key slots by physical API key for round-robin scheduling
- `sortGroupsByHealth(groups)` — sorts key groups by health score (best-first) once per translation call
- `selectGroupForBatch(keyGroups, batchIndex)` — round-robin batch selector that skips fully-cooled-down groups
- Two-tier failover in `translateBatchWithFailover()`: outer loop rotates across key groups (round-robin), inner loop rotates across models within a group (model rotation on 429)

**Changed**
- `_translateInternal()` — batch loop now builds key groups and uses round-robin group selection instead of always starting from key index 0
- `translateBatchWithFailover()` — standard failover section replaced with group-based iteration; legacy flat iteration preserved for recursive 413-split calls
- Cooldown Map key changed from `apiKey` to `apiKey::model` at 3 call sites (`getFirstAvailableKey`, `tryKeyForBatch` check, `tryKeyForBatch` 429 handler)
- 413 errors now skip the entire key group (same provider = same payload limit for all models)

**Tests**: 185 tests passing (17 pre-existing failures unchanged), build verified for Chrome and Firefox

### Subtitle Overlay Resize, Move & Reset (2026-05-12)

**Added**
- Interactive resize from 4 corners — drag to change overlay width/height, minimum 200x40px enforced
- Move handle at top-center edge — drag to reposition overlay anywhere within video player
- Reset handle at bottom-center edge — click to restore default centered position
- 6 handle DOM elements (`.yousub-handle`) with visual indicators: dots at corners, bars at center edges, appear on hover
- `yousub_overlay_layout` storage key — persists custom position/size as percentages of player dimensions, separate for regular videos and Shorts
- `ResizeObserver` on player element — re-clamps overlay position on fullscreen, theater mode, or window resize
- Boundary clamping: overlay can never leave the video player area
- `isDragging` guard in `Overlay.hide()` — prevents SyncEngine from hiding overlay during user interaction
- `.yousub-custom-position` CSS mode — switches from default centering to absolute positioning with user-defined coordinates
- `.yousub-dragging` CSS class — disables `backdrop-filter` and `box-shadow` during drag for smooth performance

**Changed**
- `overlay.js` — added 250 lines of resize/move/reset logic with Pointer Events API and `setPointerCapture` for reliable drag tracking
- `overlay.css` — added 85 lines for custom position mode, handle styles, and drag performance class
- `Overlay.destroy()` — now cleans up `ResizeObserver`, handle elements, and layout state

**Tests**: Build verified (`npm run package`), 185 tests passing (17 pre-existing failures unchanged), manual browser testing confirmed all interactions working

### Foreign Script Contamination Detection — Issue 1 (2026-05-07)

**Added**
- `detectForeignScriptLines(lines, tgt)` in `translator.js` — detects lines containing non-expected script characters (CJK, Cyrillic, Arabic, Hebrew, Devanagari, Bengali, Thai, Hangul, CJK Compatibility)
- Foreign script re-translation pipeline — contaminated lines are re-translated via existing `retranslateShiftedLines()` before fallback stripping
- `FOREIGN_SCRIPT_DETECT` / `FOREIGN_SCRIPT_STRIP` regex constants — expanded Unicode coverage beyond original inline regex
- `_internals` export in `translator.js` for testing
- `tests/unit/translator-sanitize.test.js` — 30 tests covering detection + sanitization

**Changed**
- `sanitizeForeignScript()` now accepts `segments` parameter — strip-to-empty lines fall back to original source text instead of returning empty string
- `sanitizeForeignScript()` regex expanded to cover Arabic, Hebrew, Devanagari, Bengali, Thai, CJK Compatibility (previously only Cyrillic + CJK + Hangul)

**Tests**: 30 new (translator-sanitize), 141 total across translator-sanitize + merge-fixer + logger suites

### Shorts Extraction Resilience — Phase 51.1 (2026-05-07)

**Added**
- `fetchTracksViaInnertube(videoId)` in `main-world-extractor.js` — YouTube Innertube API fallback for caption track extraction when all 3 metadata sources fail
- Innertube conditional block in `run()` — bridges metadata extraction gap for Shorts and swiped videos

**Fixed**
- "Could not find subtitles" on certain YouTube Shorts — caused by missing transcript button and stale metadata sources failing to provide caption tracks
- Swiped Shorts caption extraction — `ytInitialPlayerResponse` is stale after swiping; Innertube API provides fresh tracks with valid `baseUrl`

### Production Bundling & Log Management — Phase 49 (2026-05-07)

**Added**
- `Logger._bufferEntry()` — in-memory ring buffer (10,000 entries) with debounced flush to `chrome.storage.session` every 5s
- ERROR-level dual-path persistence — errors written to both `storage.session` and `storage.local` (max 200 entries, survives browser close)
- `Logger._readAllLogs()` — fallback chain: session storage → error storage → in-memory buffer
- `devLog()`, `devWarn()` exported from `constants.js` — production-gated console helpers
- `window.YouSub.devLog`, `window.YouSub.devWarn` — global access for MAIN world scripts
- `BUILD_DATE`, `BUILD_HASH` fields in `Constants` — injected during build from git metadata
- `chrome.storage.session` mock in `tests/mocks/chrome.js`
- `tests/unit/logger.test.js` — 15 new tests (buffering, flush, rotation, export, format)
- Pre-build validation in `package.js` — version sync, file existence, IS_PRODUCTION check
- Post-build ZIP verification — manifest validity, platform transforms, IS_PRODUCTION=true
- Stale dist/ artifact cleanup — removes old ZIPs before build
- Asset exclusion patterns — `*.zip`, `*-original.*`, `*.docx` skipped during packaging

**Changed**
- `logger.js` rewritten — replaced disabled `_persist()` with batch+debounce `storage.session` architecture
- `options.js` `exportLogs()` — now delegates to `Logger.export()`, shows entry count
- `package.js` fully rewritten — v2.0 with validation, cleanup, metadata, verification pipeline
- 140 raw `console.log/warn` calls replaced with `devLog`/`devWarn` across 15 source files
- 6 raw console calls in `providers.js` routed through `Logger.trace`/`Logger.warn`
- 1 raw `console.error` in `translator.js` routed through `Logger.error`

**Fixed**
- Export Debug Logs always showed "No logs found" — storage was never written since Phase 52
- Duplicate event listener on export button in `options.js` (bound twice at lines 66-72)
- Production builds leaked 140+ debug messages in DevTools despite `IS_PRODUCTION: true`
- Build ZIP contained junk files (`icon128-original.png`, `icons.zip`, `.docx`) — ZIP size reduced ~25%
- Stale dist/ artifacts accumulated across builds (old version ZIPs never cleaned)

**Tests**: 156 total (139 passed, 17 pre-existing failures), +15 new logger tests, 0 regressions

### Patched Tail Detection — Phase 61a (2026-05-07)

**Fixed**
- `detectTailAnomalies()` broke immediately on first non-anomalous line scanning backward — hallucinated tail content sandwiched between normal lines was never detected, preventing shift detection path from activating
- Overlap check only compared with next line (`outputLines[i+1]`) — lines with high overlap to previous line (`outputLines[i-1]`) were missed

**Changed**
- Added `TAIL_MAX_GAPS = 2` constant — gap counter allows up to 2 consecutive normal lines before breaking backward scan; gap lines are included in tail count when a subsequent anomaly is found
- Overlap detection now checks both neighbors (i-1 and i+1) bidirectionally

**Tests**: 65 → 69 (+4 new: gap bridging, bidirectional overlap, gap limit, multi-gap bridging)

### Offline Cascade Shift Detection — Phase 61b (2026-05-07)

**Added**
- `extractPreservedTokens(text)` — extracts numbers and all-caps acronyms (2+ chars); returns empty for CJK input
- `computeTokenAnchorScore()` — measures token misplacement between output line and its neighbors (score 0-1)
- `computeBoundaryAlignmentScore()` — compares terminal punctuation (.?!) between input/output (0=match, 1=mismatch)
- `computeLengthOutlierScore()` — per-line length ratio deviation from batch median (clamped 0-1)
- `computeMedianRatio()` — computes median word-count ratio across batch
- `detectCascadeShifts()` — main orchestrator combining 3 weighted signals with two-signal minimum guardrail
- `_computeLineCascadeScore()` — shared per-line scoring used by both `detectCascadeShifts` and `detectMerges`
- Constants: `CASCADE_SCORE_THRESHOLD=0.6`, `CASCADE_TOKEN_WEIGHT=0.4`, `CASCADE_BOUNDARY_WEIGHT=0.3`, `CASCADE_LENGTH_WEIGHT=0.3`, `CASCADE_MIN_BATCH_SIZE=5`, `MERGE_RATIO_MEDIUM=1.5`

**Changed**
- `detectMerges()` now has secondary threshold: when ratio is 1.5-2.0, runs cascade signals to confirm small merges that the 2.0 threshold would miss
- `MergeFixer.fix()` runs `detectCascadeShifts()` after tail anomaly check, before merge detection loop; returns `pendingIndices` for re-translation
- `_internals` export expanded with 6 new functions

**Tests**: 69 → 96 (+27 new: extractPreservedTokens, computeTokenAnchorScore, computeBoundaryAlignmentScore, computeLengthOutlierScore, computeMedianRatio, detectCascadeShifts unit + integration)

### 3-Tier RoughTranslator — Phase 61c (2026-05-07)

**Added**
- Tier 1: Chrome Translator API support — feature-detects `self.translation.canTranslate` / `self.ai.translator.capabilities`, creates on-device translator with 3s timeout, caches availability per language pair and translator instances per pair
- Tier 2: Google Translate scraping — extracted existing logic to `_translateWithGoogle()`, unchanged behavior
- Tier 3: returns null when both tiers fail (offline signals / proportional split in merge-fixer)
- `_internals` export for test access to internal state/functions
- New test file `tests/unit/rough-translator.test.js` with 14 tests

**Changed**
- `rough-translator.js` rewritten from 26 to 97 lines with 3-tier fallback chain
- Public API (`translate`, `translateBatch`) signature unchanged — zero caller modifications needed

**Tests**: 14 new tests (Chrome available, Chrome fallback, Google fallback, both fail, batch, caching)

### Enhanced Quota/Rate-Limit Display on API Key Test — Phase 60.1 (2026-04-25)

**Fixed**
- [BUG] `row.querySelector('.quota-detail')` in `tab-translation.js:481` referenced undefined `row` variable (should be `rowDev`), causing quota display to silently crash on every test. Quota info was never visible despite being fetched.
- [BUG] Anthropic rate-limit headers (`anthropic-ratelimit-*`) were never captured — code only checked `x-ratelimit-*` prefix. Anthropic quota info now extracted via provider-specific header mapping.
- [BUG] DeepSeek balance of 0 (user out of credits) was displayed as nothing due to `parseFloat("0") || null` evaluating to `null`. Fixed with explicit `isNaN()` check.

**Added**
- `fetchQuota()` method in `providers.js` — dedicated quota API calls for OpenRouter (`/api/v1/auth/key`) and DeepSeek (`/user/balance`) with 5s timeout, non-blocking (never breaks test flow)
- `quotaEndpoint` field in `providers-registry.js` for OpenRouter and DeepSeek
- `buildQuotaDisplay()` helper in `tab-translation.js` — provider-aware quota formatting with color-coded warnings (`--warning` at <10%, `--error` at <3%)
- Anthropic input/output token breakdown display (separate from aggregate tok/min)
- OpenRouter free tier display (`Used: $X.XX (free tier)`)
- DeepSeek balance display with zero-balance danger styling
- `.quota-detail`, `.quota-warn`, `.quota-danger` CSS classes in `options.css`

**Changed**
- Quota display separator changed from ` | ` to ` · ` for consistency
- Inline styles on `.quota-detail` replaced with CSS class
- `existingQuota.textContent` replaced with `existingQuota.innerHTML` for span-based color coding

### Translation Pipeline Error Visibility & Quota Diagnostics — Phase 60 (2026-04-25)

**Fixed**
- [CRITICAL] `_translateInternal()` always returned `success: true` even when ALL translation batches failed, causing UI to show "Translation complete!" with original (untranslated) text. Now tracks `anyBatchSucceeded` flag and returns `success: false` with `failureReason: 'ALL_BATCHES_FAILED'` when no batch succeeded.
- [CRITICAL] `onBatchComplete` callback fired with original text when batches failed, sending CHUNK messages with untranslated text to SyncEngine. Now gated on `result.success`.
- [HIGH] `SyncEngine.updatePartial()` and `updateSubtitles()` unconditionally marked all entries as "translated" via `translatedIndices.add()`. Now compares `text !== original` before marking.
- [HIGH] Context summary `generateContextSummary()` set `keyCooldowns` on 429 from Groq, poisoning the batch translation phase — all Groq models using the same API key were blocked even though different models might work. Removed cooldown side-effect.
- [MEDIUM] Error messages from provider API responses (quota details, retry timing) were lost in `tryKeyForBatch()` — returned `{ status: '429' }` without `message`. Now propagates `result.message` through entire chain.

**Added**
- Detailed failure overlay: when translation fails, UI shows per-provider breakdown with provider name, model, HTTP status, quota used/limit, and retry timing. Deduped, limited to 5 entries.
- `failures` array propagation through all translation paths: sequential failover, Groq waterfall (`processGroqWaterfall`), non-Groq fallback (`fallbackToNonGroq`), and recursive 413 split. Each entry includes `{ provider, model, status, message }`.
- Rate limit header extraction in `providers.js handleResponse()`: captures `x-ratelimit-remaining-tokens`, `x-ratelimit-remaining-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-limit-requests` from OpenAI-compatible provider responses on success.
- Quota detail parsing from 429 error bodies: regex extraction of `Limit/Used/Requested` numbers and `retryIn` timing from Groq-style error messages. Stored as `quotaDetail` field.
- Test button quota display in settings: after successful test, shows remaining tokens/requests per minute with percentage. Warning color (#f59e0b) when remaining < 10% of limit.
- Failed batch diagnostic logging: `sendDebugLog` (red) + `saveDebugBatch` for failed batches — previously only successful batches were logged, leaving no trace when translation failed.

**Changed**
- `translateBatchWithFailover()` sequential path: failures array now includes `message` field for 429 and 413 entries.
- `processGroqWaterfall()`: new `failures` array tracks per-key failures in switch cases; returned alongside existing fields.
- `fallbackToNonGroq()`: new `failures` array tracks non-cooldown failures; included in return.
- Groq waterfall return in `translateBatchWithFailover`: merges `groqFailures` + `fallbackFailures`.
- Recursive 413 split return: merges `res1.failures` + `res2.failures`.
- `main.js` ERROR handler: extracts `failures` from response and builds detailed HTML error message.

### Shift-Aware MergeFixer + LLM Re-translation — Phase 59.2 (2026-04-24)

**Added**
- Shift pattern detection in `merge-fixer.js`: `detectTailAnomalies()` scans backward for garbage tail lines (short, repeated 4-grams, inter-line word overlap, exact duplicates). `findShiftCandidates()` uses lower threshold (`SHIFT_RATIO_MIN >= 1.8`) gated by tail anomaly detection to catch borderline merges missed by classic `> 2.0` check.
- `buildRealignment()` — realigns shifted output lines by inserting empty slots at merge positions and truncating garbage tail. Returns `{ lines, pendingIndices }` for downstream re-translation.
- `retranslateShiftedLines()` in `translator.js` — sends pending segments as mini-batch to same LLM provider with `_skipMergeFix: true` to prevent recursion. Falls back to original source text on failure.
- Helper functions: `detectInternalRepetition()` (4-gram repetition), `computeWordOverlap()` (word-set Jaccard).
- Constants: `SHIFT_RATIO_MIN=1.8`, `SHIFT_MAX_SCAN=4`, `TAIL_NGRAM_SIZE=4`, `TAIL_OVERLAP_THRESHOLD=0.5`, `MAX_SHIFT_CANDIDATES=6`, `RE_TRANSLATION_MAX_LINES=12`.
- 19 new unit tests: detectTailAnomalies(4), detectInternalRepetition(2), computeWordOverlap(2), findShiftCandidates(3), buildRealignment(4), fix() shift-aware integration(4).

**Changed**
- `MergeFixer.fix()` return type: `string[]` → `{ lines: string[], pendingIndices: number[] }`. Shift path runs first (tail detection gates), classic path unchanged.
- Both `MergeFixer.fix()` call sites in `translator.js` (JSON mode line 555, text parser line 637) updated to handle new return type and trigger re-translation when `pendingIndices.length > 0`.

**Tests**: 65 total (46 previous + 19 new), all passing.

### Google Translate Verification + Best-Fit Merge Count — Phase 59.1 (2026-04-24)

**Added**
- `verifyAndRefineMerge()` — same-language verification step before merge fixing. Compares Google Translate baseline (VI) vs LLM output (VI) to confirm merge is real (`verifyRatio >= 1.3`). Rejects false alarms where LLM was simply verbose.
- Best-fit algorithm for merge count: accumulates Google translations of successive segments, picks j with `|accumulated/llmLen - 1.0|` closest to zero. Can adjust absorbed count UP or DOWN from initial heuristic detection.
- Overlap-safe scan bound (`nextMergePos`) prevents best-fit from claiming segments belonging to adjacent merges.
- 9 new unit tests: `verifyAndRefineMerge` direct tests (confirm, reject, best-fit correct/up/down, fallback, partial) + `fix()` integration tests (false alarm rejection, pipeline adjustment).
- Constants: `VERIFY_THRESHOLD = 1.3`, `MAX_BEST_FIT_DIFF = 0.35`, `MAX_SCAN_EXTRA = 2`.

**Changed**
- `fix()` inner loop: replaced direct `translateBatch(absorbedTexts)` with `verifyAndRefineMerge()` call. Google translations are now batched for current + candidate segments in one call, reused for both verification and anchor extraction. Zero wasted API calls.

**Tests**: 46 total (37 previous + 9 new), all passing.

### MergeFixer Bug Fixes + Unit Tests — Phase 59 (2026-04-24)

**Fixed**
- [CRITICAL] `detectMerges()` false positive: removed forced `absorbed = 1` when no subsequent lines show merge evidence. Verbose but correct translations (e.g., "Yeah" → 3-word Vietnamese) no longer trigger merge detection and subsequent corruption via proportional split.
- [MEDIUM] Short segment false positives: added `MIN_WORDS_FOR_RATIO_CHECK = 4` guard. Segments with fewer than 4 input words skip ratio-based merge detection entirely.
- [MEDIUM] CJK word counting: `wordCount()` now detects CJK text (Japanese, Chinese, Korean) via Unicode ranges and uses character-based counting (chars / 2) instead of whitespace split. Prevents systematic false positives for CJK target languages.
- [LOW] Partial anchor recovery in `fix()`: when some rough translations succeed and others fail, successful anchors are used for precise splitting while failed segments get proportional fallback within their range only.

**Added**
- `tests/unit/merge-fixer.test.js` — 37 unit tests covering `detectMerges()`, `fix()`, `wordCount()`, `proportionalSplit()`, `extractAnchorWords()`, `findAnchorInText()`, false positive regression tests for all 3 bug fixes.
- `_internals` export in `merge-fixer.js` for direct unit testing of internal functions.

**Tests**: 37 new tests, all passing. No regressions in existing test suites.

### JSON Structured Output + Merge Detection & Auto-Fix — Phase 58 (2026-04-22)

**Added**
- `src/background/rough-translator.js` — Google Translate unofficial endpoint wrapper for free rough translations. `translate()` single text, `translateBatch()` concurrent. 5s timeout, graceful null on failure.
- `src/background/merge-fixer.js` — post-processing module to detect and fix LLM line merges. `detectMerges()` scans word-count ratios (>2.0 merged, <0.5 displaced). `fix()` uses Google Translate anchors to find precise split points. Proportional fallback when anchors fail. Processes merges right-to-left to preserve indices.
- `getProviderJsonConfig()` in translator.js — returns provider-specific JSON mode config. Gemini gets `responseSchema` with `minItems`/`maxItems` for constrained decoding. OpenAI-style gets `response_format: { type: "json_object" }`.
- `buildJsonSystemPrompt()` — simplified prompt requesting JSON `{"lines": [...]}` array. No timestamp format rules. Preserves UNFILTERED & FAITHFUL rule.
- `buildJsonUserPrompt()` — zero-indexed `[0] text` format, no timestamps.
- `parseJsonResponse()` — JSON parser with regex fallback extraction, array length validation, original-text padding for missing elements.
- `supportsJsonMode` flag on all 9 providers in `providers-registry.js` (true: google, openai, groq, deepseek, xai, mistral; false: anthropic, openrouter, ollama).
- `gemini-2.5-flash` model added to Google provider (set as default).

**Changed**
- `tryKeyForBatch()` now operates in dual-mode: JSON-first with text-fallback. Detects provider JSON support, builds appropriate prompts, parses JSON array by index instead of timestamp regex. Streaming disabled for JSON mode.
- `callOpenAIStyle()` in providers.js conditionally adds `response_format` to payload.
- `callGemini()` conditionally adds `responseMimeType` + `responseSchema` to `generationConfig`.
- All `tryKeyForBatch` callers (`processGroqWaterfall`, `fallbackToNonGroq`, `translateBatchWithFailover`) now pass `context/src/tgt` in options for JSON prompt building.
- `splitForGroqPayload()` uses JSON prompt sizes for payload estimation when Groq supports JSON mode.
- `manifest.json` — added `https://translate.googleapis.com/*` to host_permissions.
- `maxTokens` estimate increased for JSON mode: `segments.length * 130` (vs `* 100`), cap `16384`.

**Tests**: Manual — load extension, translate YouTube video, verify `[JSON_MODE]` and `[ANCHOR]`/`[FALLBACK]` logs in Service Worker console. Verify previously-shifted subtitles now align correctly.

### Logger TRACE Level + Smart Groq Payload Distribution — Phase 57 (2026-04-22)

**Added**
- `Logger.trace()` — new log level that always prints via `console.log()` regardless of `IS_PRODUCTION`, replacing the hack of using `Logger.error()` for debug checkpoints. Chrome Extensions panel now shows 0 fake errors during normal translation.
- `buildSystemPrompt()` — extracted system prompt template into reusable function for Groq waterfall and standard failover.
- `tryKeyForBatch()` — extracted per-key translation attempt into standalone function returning structured status (`success`, `413`, `429`, `cooldown`, `parse_fail`, etc.).
- `partitionKeysByProvider()` — splits API key array into `{ groqKeys, nonGroqKeys }` preserving health-score ordering.
- `splitForGroqPayload()` — pre-calculates segment chunk boundaries to stay within Groq's 95KB payload limit using binary search.
- `processGroqWaterfall()` — sticky-until-fail waterfall: distributes chunks across Groq keys, advancing cursor only on failure (429/error), maximizing each key's quota.
- `fallbackToNonGroq()` — sends unprocessed chunks to non-Groq providers unsplit (Google/OpenAI handle much larger payloads).
- Per-provider transcript truncation in `generateContextSummary()` — Groq keys receive truncated transcript fitting within payload limit; non-Groq keys receive full transcript.

**Changed**
- 10 checkpoint `Logger.error()` calls in `translator.js` converted to `Logger.trace()` (normal-flow diagnostics).
- 4 failure-with-fallback `Logger.error()` calls converted to `Logger.warn()` (e.g., no API keys, batch failed, 413 split).
- 2 fetch diagnostic `Logger.error()` calls in `providers.js` converted to `Logger.trace()`.
- `translateBatchWithFailover()` now uses Groq-conditional pre-flight routing instead of provider-agnostic binary split. Non-Groq providers no longer trigger unnecessary 95KB payload splitting.
- `tail()` color map updated: TRACE level shown in cyan (`#06b6d4`).

**Tests**: Manual verification required — load unpacked extension, translate a long video, verify Chrome Extensions panel shows 0 errors on success; verify Groq waterfall distributes chunks across keys in Service Worker console.

### Feature: Popup Language Selector — Phase 56 (2026-04-21)

**Added**
- Language selector dropdown in Popup UI — allows users to change target translation language (15 languages) directly without opening Settings.
- Dropdown populated dynamically from `YOUSUB_PROVIDERS.languages` (excluding `auto`).
- Bidirectional sync with Options page via `storage.onChanged` listener.
- Dark glassmorphism styling with custom SVG dropdown arrow, matching existing Popup theme.

**Changed**
- `updateLanguageUI()` now syncs both the Translate button text and the dropdown selection.

### Code Quality Polish — Phase 55 (2026-04-21)

**Added**
- `src/shared/utils.js` — centralized `sanitizeKey()` function, eliminating 3 duplicate copies across `api-manager.js`, `providers.js`, `health.js`.
- Periodic cleanup for `keyCooldowns` Map in translator (every 60s) to prevent unbounded growth.
- Segment validation before translation — filters out entries missing `text` or `startMs`.

**Changed**
- Overlay `showStatus()` now whitelists CSS class type parameter (`info`, `success`, `warning`, `error`), preventing injection of arbitrary class names.
- `manifest.json` updated with `src/shared/utils.js` in `web_accessible_resources`.

### Request Dedup & Port/Stream Cleanup — Phase 54.2 (2026-04-21)

**Added**
- Request deduplication in translator: concurrent `translate()` calls for the same tab+language return the existing in-flight Promise instead of spawning duplicate API requests.
- Active port tracking in service worker via `activePorts` Map with connection timestamps and tab IDs for debugging.
- `failures` array now populated with provider name, model, HTTP status, and retry-after duration for diagnostic display.

**Fixed**
- `SyncEngine.updatePartial()` now validates `startIndex` type and bounds before merging, and stops at array boundary to prevent out-of-bounds writes.

### Retry Logic & Timeout Hardening — Phase 54.1 (2026-04-21)

**Added**
- Automatic retry with exponential backoff (1s, 3s) for transient API failures (timeouts, 5xx errors). 4xx errors (429, 413) continue to use existing cooldown/split mechanisms without retry.
- Secondary 20s safety timeout on XHR fetcher as fallback if `xhr.timeout` (15s) doesn't fire. Aborts XHR and sends error response.

**Changed**
- `RETRY_ATTEMPTS` restored from 0 to 2 (was disabled in Phase 47 anti-deadlock work).
- `JSON.parse()` calls in subtitle parser now produce specific error messages distinguishing parse failures from fetch failures.

### Null Safety & Callback Guards — Phase 53.2 (2026-04-21)

**Fixed**
- Null dereference crash in `main-world-extractor.js` transcript parser when `host` element disappears between DOM check and assignment (race condition on YouTube SPA navigation).
- Double callback invocation in `video-binder.js` prevented with `callbackFired` flag — guards against simultaneous initial-check and MutationObserver both finding the video element.

### Event Listener & Observer Cleanup — Phase 53.1 (2026-04-21)

**Fixed**
- Memory leak: `chrome.storage.onChanged` listeners now stored and removed in `overlay.js` `destroy()`, preventing accumulation across overlay recreations.
- Duplicate `chrome.runtime.onMessage` listener registration in `main.js` guarded with flag.
- `subtitle-extractor.js` now uses one-shot pattern — message listener removed immediately after callback fires.
- `video-binder.js` MutationObserver callback wrapped in try/catch with automatic cleanup on exception.

### Cache Atomicity & DOM Freshness — Phase 52.2 (2026-04-21)

**Changed**
- `Cache.set()` now writes data and metadata in a single atomic `storage.local.set()` call, preventing race conditions between concurrent translation requests.
- `_evictIfNeeded()` operates on the same metadata snapshot used by `Cache.set()` instead of re-reading from storage.

**Fixed**
- Stale overlay attachment after SPA navigation: `Overlay.show()` now verifies `playerElement` is still connected to DOM and is the active player (Shorts reel check) before rendering. Destroys and recreates overlay if stale.

### Service Worker Lifecycle & Message Safety — Phase 52.1 (2026-04-21)

**Added**
- Keepalive heartbeat (PING/PONG every 25s) for streaming port connections to prevent MV3 Service Worker termination during long translations.
- Per-port AbortController in service worker that cancels in-flight API requests when the content script disconnects.
- External abort signal parameter in `translate()` for port-level cancellation cascade.
- Timeout guard (10s) for cache-check `sendMessage` to prevent silent stalls on extension reload.

**Fixed**
- `chatStream()` now properly wires external abort signals, matching the existing pattern in `chat()`. Previously, abort signals from the translator's global timeout were silently ignored during streaming translations.
- All `port.postMessage()` calls in service worker are now wrapped in try/catch to prevent unhandled exceptions after port disconnect.

### Shorts Stability & Video Binding — Phase 50.7 (2026-04-10)

**Added**
- Active Reel Targeting: Enhanced `video-binder.js` to prioritize `ytd-reel-video-renderer[is-active] video` for precise synchronization on YouTube Shorts.
- Visibility Enforcement: Added an `isVisible` check to ensure the extension only binds to the video element currently in the viewport, ignoring hidden/cached reels.

**Changed**
- Synchronization Safety: Hardened `sync-engine.js` to skip processing when a video becomes invisible (e.g., during swiping), preventing "stuck" or "ghost" subtitles.

**Fixed**
- Global Syntax Error: Resolved a fatal `Missing catch or finally` error in `main-world-extractor.js` that blocked initialization on some layouts.
- Stale Timestamp Tracking: Fixed issue where switching Shorts would leave the previous video's subtitles frozen on screen.

### Security Hardening (Trusted Types) & Crash Recovery — Phase 50.6 (2026-04-10)

**Added**
- Global Exception Boundaries: Wrapped `MainWorldExtractor` and `MainWorldFetcher` in high-level `try-catch` blocks to prevent unhandled errors from crashing the main world context.
- Trusted Types Policy Injection: Created `yousub-extractor-policy` and `yousub-fetcher-policy` to ensure DOM manipulation (HTML/Scripts) complies with YouTube's strict security policies.

**Changed**
- Sanitized DOM Updates: Replaced direct `innerHTML` assignments with a `setSafeHTML` helper function across all main-world scripts.
- Multi-Language Support: Added Vietnamese localization support (`"mô tả"`) to the Shorts description menu crawler.

**Fixed**
- Security policy violations (TrustedHTML) that were preventing script injection on modern YouTube layouts.
- Crash-on-error behavior where a single failure in the extraction pipeline would break the entire extension lifecycle until page reload.

### Local LLM Support (Ollama) — Phase 50.3 (2026-04-10)

**Added**
- Ollama Integration: Support for locally hosted Ollama instances via the OpenAI-compatible v1 chat completions API.
- Dynamic Permission Management: Implemented `optional_host_permissions` for `http://localhost/*` and `http://127.0.0.1/*`, allowing users to grant access only when needed.
- Local Model Synchronization: Added a "Refresh Models" feature that dynamically fetches available Ollama models (Llama, Mistral, etc.) via a background proxy to bypass CORS.
- Connection UI: Added a "Connect Ollama" button in the Translation settings for a seamless one-click setup.

**Changed**
- API Header Logic: Updated `providers.js` to omit the `Authorization` header when no API key is provided, ensuring compatibility with local endpoints.

**Fixed**
- Restricted CORS access issues when calling localhost from extension settings pages.

### Streaming Translation (SSE) & Real-time Delivery — Phase 50.2 (2026-04-10)

**Added**
- Port-based Messaging Architecture: Switched to `chrome.runtime.connect` for translation requests to enable long-lived connections and incremental chunk delivery.
- LLM Streaming Support: Implemented `chatStream` in `providers.js` with specialized SSE parsers for OpenAI (delta), Anthropic (content_block_delta), and Gemini (stream JSON).
- Streaming Mode Toggle: Added a new setting in the Options UI to allow users to choose between standard batch delivery and real-time word-by-word streaming.

**Changed**
- Background Translator Orchestration: Updated `translator.js` to accept callbacks for stream chunks, forwarding raw AI output to the frontend as it arrives.
- Content Script Responsiveness: Modified `main.js` to apply partial translation updates to the `SyncEngine` immediately upon chunk reception, significantly reducing perceived latency.

**Fixed**
- UI lag during long-form video translation by eliminating the need to wait for full batch completion (50+ lines) before rendering initial results.
- Message bus bottlenecks by utilizing dedicated Port communication for heavy data streams.

### YouTube Shorts Support & Security Hardening — Phase 50.1 (2026-04-10)

**Added**
- Specialized YouTube Shorts Support: Implementation of "Active Reel" detection and extraction logic. Targeted `ytd-reel-video-renderer[is-active]` to find the correct player on Shorts pages.
- Shorts-specific UI Adaptation: Added `.yousub-shorts` CSS class and logic in `overlay.js` to automatically adjust width and bottom-offset specifically for the vertical Shorts player.

**Changed**
- TrustedHTML Security Enforcement: Switched from inline `innerHTML` assignments to mandatory `TrustedTypes.toSafeHTML()` usage across `overlay.js` and `main.js` to comply with YouTube's strict security policy.
- MainWorldExtractor Robustness: Updated video ID extraction to handle path-based identifiers (`/shorts/VIDEO_ID`) when the `v` URL parameter is absent.
- Module Import Resilience: Converted `Overlay` and `Main` to use explicit ESM imports for `TrustedTypes`, eliminating race conditions and ensuring policy initialization.

**Fixed**
- "TrustedHTML assignment" crash that blocked the overlay from appearing on modern YouTube layouts.
- Subtitle extraction failure on Shorts caused by incorrect selector targeting and missing video ID handling.
- Overlay overlap with Shorts action buttons and metadata by increasing default bottom offset for vertical views.

### Anti-Deadlock & Stability Overhaul — Phases 47–48 (2026-04-09)

**Added**
- Global Abort Protocol: Integrated `AbortController` in `translator.js` to immediately terminate all pending `fetch` requests when the 55s safety timeout is reached, stopping background zombie tasks.
- Payload Pre-flight Check: Added Byte-size estimation logic to automatically split batches *before* submission if they exceed 95KB, preventing 413 (Payload Too Large) errors on Groq.
- Key Cooldown Mechanism: Implemented a 10s per-key lockout after 429 errors to prevent rapid-fire spamming of rate-limited API keys.
- Sequential Recursive Splitting: Modified recursive splitting to execute sequentially rather than in parallel, eliminating request spikes that caused concurrent 429/413 errors.

**Changed**
- Logger I/O Optimization: Completely disabled storage persistence for logs during active translation. Logs are now strictly console-only to eliminate Service Worker I/O deadlocks.
- Context Capping: Fixed `VIDEO CONTEXT` length at 500 characters within the system prompt to ensure payload stability across all AI models.
- Success Flag Propagation: Standardized the `success` return flag across all translation paths (recursive and failover) to ensure the UI correctly displays Vietnamese results.

**Fixed**
- "Original Text Only" display bug caused by missing success indicators in split batches.
- Persistent 413 errors on Groq even with small line counts by stripping context in deep recursive calls.
- Infinite logging loop/spam after translation failure.


### Pipeline Stability & Performance — Phases 42–46 (2026-04-08)

**Added**
- Request Heartbeat: 60-second timeout for background requests in `main.js` to ensure the loading spinner always hides.
- Robust Routing: Central `try/catch` and `async/await` refactor for `service-worker.js` and `api-manager.js`.
- Adaptive Rate Limit Handling: Exponential backoff (respecting `Retry-After`) for 429 errors.
- Context Summary Safeguard: 10-second timeout for video analysis calls to prevent pipeline hangs.
- Granular Diagnostic Logging: Detailed "check-in" logs in Background Console (Analyzing → Summary Ready → Batching).

**Changed**
- Key Manager Robustness: Replaced nested promises with clean `async/await` to prevent silent crashes in `getValidKeys`.
- I/O Performance: Centralized storage access in `APIManager` (O(1) fetch instead of O(N) per key).
- Circuit Breaker Relaxed: Increased threshold to 10 consecutive failures to reduce premature key lockouts.

**Fixed**
- Infinite "Loading" UI state caused by silent background crashes.
- `Extension context invalidated` hang when extension reloads without page refresh.
- Potential `TypeError` in Key Scoring logic when encountering new API keys.
- Key Hash Mismatches: Shared `sanitizeKey` logic across all background modules.

### Security & Stability — Phases 36–41 (2026-04-08)

**Added**
- Trusted Types compliance for YouTube's CSP restrictions (`src/shared/trusted-types.js`)
- Health Summary Protocol for real-time API status in Popup UI
- Smart extraction pre-check to handle pre-opened transcript panels

**Changed**
- Zero-width character sanitization across all key-handling modules
- API key `.trim()` enforcement at input, storage, and execution layers
- Batch size optimized to 400 lines; context sampling capped at 100 segments
- 1-second throttle between batch requests to prevent rate limiting
- Strict translation verification — returns failure if all batches fail
- Explicit `host_permissions` for all LLM provider domains (Manifest V3)
- `stream: false` added to OpenAI-style payloads for provider compatibility

**Fixed**
- Fatal `wait is not defined` crash in translator pipeline
- "Green Dot / Red Text" UI state desync in Popup
- Popup hanging indefinitely on health check responses
- API registry bug where auto-detection accessed properties on a string

### Subtitle Sync & Pipeline Hardening — Phases 35.1–35.19 (2026-04-06 → 2026-04-08)

**Added**
- Timestamp-based translation tracking (`[HH:MM:SS]`) replacing numeric IDs
- Translation propagation for merged segments (sticky fill)
- Incremental subtitle display — batches render as they arrive
- Cache transparency — UI distinguishes cache hits from live translations
- Detailed API failure notifications with provider/model breakdown
- Strict error enforcement — pipeline halts on config/API errors
- Production logging flag with automatic build-time override (`IS_PRODUCTION`)
- Broadcast cache invalidation across all open YouTube tabs
- Live API health updates with pulse-red animation for failures
- Custom confirmation modal (glassmorphism) replacing native `confirm()`

**Changed**
- ESM migration — 9+ files converted to standard `import/export`
- Manifest simplified to single entry point + `web_accessible_resources`
- Architecture moved from global `window.YouSub` to explicit module imports
- Incremental merge logic replacing all-or-nothing subtitle updates
- Rigid `[#ID]` identifier tagging with alignment recovery on missing IDs
- Global absolute IDs (video-wide `[#501]`) eliminating per-batch numbering resets

## [0.2.1] — 2026-04-06

### Translation Engine Optimization — Phases 32–35 (2026-04-06)

**Added**
- Incremental subtitle display with batch-by-batch streaming
- Gemini safety filter bypass (`BLOCK_NONE` for all harm categories)
- Interactive error toasts with direct "Open Settings" link
- `YOUSUB_OPEN_SETTINGS` message handler for in-page settings access

**Changed**
- `max_tokens` reduced to 20 for API key validation (was 32,768)
- Provider `chat()` accepts optional `maxTokens` parameter
- Translator supports batch-completion callbacks for streaming UI

## [0.2.0] — 2026-04-06

### Popup UI & Cache Management — Phase 31 (2026-04-06)

**Added**
- "Clear Page Cache" button in Popup for current video
- `Cache.removeByVideoId` for per-video cache purge
- Multi-line API health display with online model names

### Subtitle Appearance & Translation Quality — Phases 23–30 (2026-04-05 → 2026-04-06)

**Added**
- Full-transcript context summary (`generateContextSummary`) for translation batches
- Numbered envelope strategy (`N| Original`) for line count preservation
- Smart regex parser for robust extraction from AI responses
- Dynamic control bar offset for subtitle positioning
- Overlay loading spinner during extraction/translation
- Persistent translation toggle in Popup with visual states
- Signature-based cache with video ID verification

**Changed**
- Adaptive batch sizing with context optimization
- Sparse backfill strategy for partial LLM outputs
- `max_tokens` standardized across providers (uncapped for translation, minimal for testing)
- CSS variables for subtitle positioning with smooth transition animations

### Features & Visual Polish — Phases 14–23 (2026-04-03 → 2026-04-04)

**Added**
- Dual subtitle display (original + translated simultaneously)
- Full appearance customization (font size, color, opacity, position)
- Real-time subtitle preview in Settings
- Premium "Slate & Rose" UI with glassmorphism effects
- Automated packaging via `scripts/package.js`
- Cross-browser support (Chrome, Firefox, Edge) with `webextension-polyfill`
- Test suite — 31 unit tests at 94% coverage (Jest + JSDOM)
- Performance optimization — O(1) subtitle lookup, DOM caching, throttled updates
- Translation caching with LRU eviction (100 videos) and 7-day TTL
- Hybrid extraction engine (XHR primary, DOM scraping fallback)
- YouTube Shorts support and live stream detection
- Error handling with toast notifications and API health indicators
- Structured debug logging (JSON Lines) with export functionality

**Changed**
- Overlay upgraded to vertical Flexbox for multi-line support
- Provider health tracking with circuit breaker states and visual badges
- Cleanup logic refined for SPA navigation (zero memory leaks)

### Foundation & Core Infrastructure — Phases 1–13 (2026-04-03)

**Added**
- Manifest V3 Chrome extension foundation
- SPA-aware YouTube page detection and video player binding
- Subtitle track discovery via MAIN world script injection
- Subtitle fetching and parsing (JSON3 + XML formats)
- Translation pipeline with background service worker proxy
- Multi-provider LLM engine (OpenAI, Gemini, Anthropic, Groq, DeepSeek, xAI, Mistral, OpenRouter)
- API key management UI with CRUD, testing, validation, and failover
- Provider & model registry (`src/shared/providers-registry.js`)
- Full Settings page with tabbed navigation (Translation, Appearance, About)
- Popup UI for quick actions and status display
- Centralized JSON logger (`src/shared/logger.js`)
- Design decisions documentation (`YOUSUB_DESIGN_DECISIONS.md`)
