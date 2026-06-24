# YouSub — Design Decisions Record

> Technical decisions documented here to prevent AI assistants from re-proposing rejected approaches in future sessions.

---

### Decision 1 — Cascade Shift Detection: Multi-Signal Weighted Scoring

**Date**: 2026-05-07
**Status**: RESOLVED

**Problem**: LLMs (especially Llama 3.3 70B) produce cascade shift patterns where content from input[i] leaks into output[i+1]. These shifts have normal word counts per line, making the existing ratio-only detection (`MERGE_RATIO_HIGH = 2.0`) completely blind to them.

**Options considered**:
1. **Lower the ratio threshold** — Pros: simple. Cons: massive false positive rate on verbose translations.
2. **Rough-translation-only verification** — Pros: reuses existing infrastructure. Cons: requires API calls (rate-limited), fails when Google Translate is down.
3. **Offline multi-signal scoring** — Pros: zero API calls, works without rough translation, catches patterns invisible to ratio analysis. Cons: more complex, needs threshold tuning.

**Resolution**: Option 3 chosen. Three weighted signals combined:
- Token-anchor matching (weight 0.4): preserved tokens (numbers, all-caps acronyms) from input[i] must appear in output[i], not neighbors
- Sentence boundary alignment (weight 0.3): terminal punctuation (.?!) must match between input/output
- Per-line length ratio consistency (weight 0.3): outliers vs batch median

Two-signal minimum guardrail: at least 2 of 3 signals must fire to prevent false positives from a single noisy signal. Combined score threshold: 0.6.

**References**: `src/background/merge-fixer.js` — `detectCascadeShifts()`, `_computeLineCascadeScore()`

---

### Decision 2 — Secondary Merge Threshold (MERGE_RATIO_MEDIUM)

**Date**: 2026-05-07
**Status**: RESOLVED

**Problem**: `MERGE_RATIO_HIGH = 2.0` misses small merges where only 2-5 words are absorbed from an adjacent line, producing ratios of 1.3-1.5.

**Options considered**:
1. **Lower MERGE_RATIO_HIGH to 1.5** — Pros: catches small merges. Cons: false positives on naturally verbose translations.
2. **Add secondary threshold with cascade confirmation** — Pros: catches small merges only when offline signals confirm the anomaly. Cons: slightly more complex detection loop.

**Resolution**: Option 2 chosen. Added `MERGE_RATIO_MEDIUM = 1.5`. When ratio is between 1.5 and 2.0, cascade signals are computed for that line. Only if cascade score >= threshold AND two-signal minimum is met, the line is treated as a merge candidate. This avoids false positives on verbose translations while catching genuine small merges.

**References**: `src/background/merge-fixer.js` — `detectMerges()`

---

### Decision 3 — 3-Tier RoughTranslator Architecture

**Date**: 2026-05-07
**Status**: RESOLVED

**Problem**: `RoughTranslator` only used Google Translate scraping via undocumented API endpoint (`translate.googleapis.com`). This is rate-limited, unreliable, and may break without notice.

**Options considered**:
1. **Keep Google-only, add retry/backoff** — Pros: minimal change. Cons: still single point of failure.
2. **Replace Google with Chrome Translator API only** — Pros: on-device, unlimited. Cons: Chrome 138+ only, may not be available in Service Worker.
3. **3-tier fallback chain** — Pros: best availability, graceful degradation. Cons: more code, feature detection complexity.

**Resolution**: Option 3 chosen. Tier 1: Chrome Translator API (on-device, `self.translation.createTranslator` or `self.ai.translator.create`, 3s timeout). Tier 2: Google Translate scraping (existing, 5s timeout). Tier 3: return null (rely on offline cascade signals or proportional split). Availability cached per language pair. Translator instances cached and reused. Public API (`translate`, `translateBatch`) unchanged — zero caller modifications needed.

**Key constraint**: Rough translation is NOT for user display. It exists solely for merge/shift detection word-count comparison. Translation quality is irrelevant.

**References**: `src/background/rough-translator.js`

---

### Decision 4 — Tail Detection Gap Tolerance

**Date**: 2026-05-07
**Status**: RESOLVED

**Problem**: `detectTailAnomalies()` broke immediately on the first non-anomalous line when scanning backward. If a normal line was sandwiched between two anomalous lines at the tail, the anomaly before the gap was never detected.

**Options considered**:
1. **Pre-scan all lines, then find longest anomalous suffix** — Pros: optimal detection. Cons: O(n) pre-computation, more complex.
2. **Allow small gaps in backward scan** — Pros: simple gap counter, handles sandwiched anomalies. Cons: may include a few non-anomalous lines in the tail count.

**Resolution**: Option 2 chosen. Added `TAIL_MAX_GAPS = 2` — up to 2 consecutive non-anomalous lines are bridged. When an anomalous line is found after gaps, the gap lines are included in the tail count. Also added bidirectional overlap check (both `outputLines[i-1]` and `outputLines[i+1]`).

**References**: `src/background/merge-fixer.js` — `detectTailAnomalies()`

---

### Decision 5 — Log Persistence: `storage.session` + ERROR-only `storage.local`

**Date**: 2026-05-07
**Status**: RESOLVED

**Problem**: Log persistence via `storage.local` was disabled in Phase 47-48 because the per-entry read-modify-write cycle caused I/O deadlocks during active translation. This broke the Export Debug Logs feature and `Logger.tail()`.

**Options considered**:
1. **`chrome.storage.session` + ERROR-only `storage.local`** — Pros: session storage is memory-backed (no disk I/O contention), errors survive browser close, batched/debounced writes (5s). Cons: non-error logs lost on browser close.
2. **Fully in-memory buffer, export on demand** — Pros: zero I/O. Cons: logs lost on service worker restart, export unreliable.
3. **Batched debounced writes to `storage.local`** — Pros: full persistence. Cons: re-introduces the I/O pattern that caused the Phase 47-48 deadlocks, requires translation-active flag coordination.

**Resolution**: Option 1 chosen. In-memory ring buffer (10,000 entries) flushed to `storage.session` every 5s (debounced). ERROR entries additionally written to `storage.local` (max 200). Fallback chain for reading: session → error local → in-memory. Firefox 128+ supports `browser.storage.session` (manifest requires 128.0).

**References**: `src/shared/logger.js`

---

### Decision 6 — YouTube Innertube API Fallback for Shorts Caption Tracks

**Date**: 2026-05-07
**Status**: RESOLVED

**Problem**: YouTube Shorts subtitle extraction fails because (1) many Shorts lack a "Show transcript" button (DOM scraping fails), and (2) the 3 existing metadata sources (`movie_player.getPlayerResponse()`, `window.ytInitialPlayerResponse`, `reel.data.playerResponse`) frequently return no caption tracks or tracks with empty `baseUrl` — especially for swiped-to Shorts.

**Options considered**:
1. **Enhanced DOM metadata extraction** — Pros: no new API calls. Cons: fragile, depends on YouTube's DOM structure which changes frequently.
2. **Network request interception** — Pros: gets exact data YouTube uses. Cons: complex timing issues, may miss already-loaded data.
3. **YouTube Innertube API direct call** — Pros: reliable, works for all video types, same-origin (no CORS), returns fresh URLs with valid auth. Cons: uses undocumented API (may change).

**Resolution**: Option 3 chosen. Added `fetchTracksViaInnertube(videoId)` in `main-world-extractor.js`. Calls `POST /youtubei/v1/player` via XHR (not fetch, to avoid YouTube's Service Worker interception). Only fires when no usable tracks (with non-empty `baseUrl`) exist from existing metadata sources. Always resolves (never rejects). 8s XHR timeout + 12s safety timeout. Uses `window.ytcfg` for dynamic API key and client version.

**Key constraint**: Trigger condition checks `tracks.some(t => t.baseUrl)` — not just `tracks.length`. This catches the case where metadata returns tracks with empty `baseUrl` (common on Shorts).

**References**: `src/content/main-world-extractor.js` — `fetchTracksViaInnertube()`

---

### Decision 7 — Foreign Script Detection: Detect-then-Retranslate vs Strip-only

**Date**: 2026-05-07
**Status**: RESOLVED

**Problem**: LLMs (especially Groq/Llama) inject CJK characters into Vietnamese translations. The existing `sanitizeForeignScript()` stripped foreign characters destructively, leaving broken/incomplete text.

**Options considered**:
1. **Strip-only (existing)** — Pros: Simple, no API calls. Cons: Destroys content, "lệnh封锁" becomes "lệnh" (loses meaning)
2. **Detect + re-translate + strip safety net (chosen)** — Pros: Attempts clean re-translation first, falls back to strip. Cons: Extra API call per contaminated batch
3. **Detection in merge-fixer.js** — Pros: All detection in one file. Cons: MergeFixer has 3 return paths requiring detection at each; adds complexity to an already 560-line file; foreign script is content quality issue, not structural

**Resolution**: Option 2, implemented in `translator.js` (not `merge-fixer.js`). Detection runs after MergeFixer completes, uses existing `retranslateShiftedLines()` infrastructure. `sanitizeForeignScript()` remains as final safety net.

**Additional decision**: Greek script (Ͱ-Ͽ) intentionally excluded from detection regex to avoid false positives on math/science content (α, β, γ, π commonly appear in educational subtitles). Can be added if Greek contamination is observed in production.

**References**: `src/background/translator.js` — `detectForeignScriptLines()`, `sanitizeForeignScript()`

---

### Decision 8 — Subtitle Overlay Resize/Move: Dual CSS Positioning Modes

**Date**: 2026-05-12
**Status**: RESOLVED

**Problem**: The subtitle overlay is fixed-position (centered horizontally, pinned to bottom). Users cannot reposition or resize it for different video layouts and screen setups.

**Options considered**:
1. **CSS-only approach with custom properties** — Pros: simple. Cons: cannot support arbitrary positioning, only bottom offset adjustable.
2. **Single positioning mode with offset variables** — Pros: avoids mode switching. Cons: `transform: translateX(-50%)` used for centering conflicts with custom positioning; show/hide animation uses same `transform` property.
3. **Dual CSS modes via `.yousub-custom-position` class** — Pros: clean separation, default mode unchanged, custom mode uses `left`/`top` percentages with `transform: none`. Cons: two code paths.

**Resolution**: Option 3 chosen. Default mode retains current centering (`left: 50%; transform: translateX(-50%); bottom: calc(...)`). Custom mode (`.yousub-custom-position`) sets `left`/`top` as percentages of player dimensions, `bottom: auto`, `transform: none`. Resolves the `transform` conflict since `.yousub-visible` asserts `transform: translateX(-50%)` which would clobber custom positioning.

Layout stored in `yousub_overlay_layout` (separate from `yousub_appearance`). Regular and Shorts layouts stored independently. Percentages survive fullscreen/theater/window resize without recomputation. `ResizeObserver` on player element handles boundary re-clamping. Pointer Events API with `setPointerCapture` ensures drag continues even when pointer leaves the handle element.

**References**: `src/content/overlay.js` — `enterCustomMode()`, `exitCustomMode()`, `attachMoveHandler()`, `attachResizeHandler()`; `src/content/overlay.css` — `.yousub-custom-position`

---

### Decision 9 — Batch Distribution: Round-Robin + Model Rotation

**Date**: 2026-05-14
**Status**: RESOLVED

**Problem**: The translation pipeline always starts every batch from key index 0 (sequential failover). Key 0 absorbs all load until rate-limited, exhausting free-tier quotas while other keys sit idle. Additionally, cooldown is keyed by `apiKey` alone — a 429 on one model (e.g., Groq/llama-70b) blocks all models of the same provider despite separate per-model quotas.

**Options considered**:
1. **Simple round-robin on flat key list** — Pros: minimal change. Cons: doesn't leverage model rotation; cooldown still blocks all models of same key.
2. **Two-tier scheduling: key group round-robin + intra-group model rotation** — Pros: distributes load across keys AND models; model-specific cooldown preserves per-model quotas; health-based ordering for optimal routing. Cons: more complex iteration logic.
3. **Parallel batch execution across keys** — Pros: maximum throughput. Cons: race conditions, duplicate translations, complex merge logic, wastes API quota.

**Resolution**: Option 2 chosen. Two-tier scheduling with 4 new functions: `getCooldownKey()` (model-aware cooldown), `groupByPhysicalKey()`, `sortGroupsByHealth()`, `selectGroupForBatch()`. Batches rotate across key groups; within each group, 429 triggers model rotation (try next model of same provider). 413 skips entire group (payload limit is provider-level). Groq waterfall path unchanged (specialized for oversized payloads). Legacy flat iteration preserved for recursive 413-split calls.

**References**: `src/background/translator.js` — `groupByPhysicalKey()`, `selectGroupForBatch()`, `translateBatchWithFailover()`

---

### Decision 10 — Streaming Timeout Reconciliation: Idle Watchdog + Per-Batch Cap + Completeness Sweep

**Date**: 2026-06-08
**Status**: RESOLVED

**Problem**: Users hit `Translation failed: TIMEOUT_BACKGROUND` on Chrome and Firefox — the first batch rendered, then mid-translation every batch vanished. Root cause: the content script armed a **fixed 60s** deadline (`requestTranslationStreaming`) that was never reset by streaming `CHUNK` progress, while the background allowed itself **100s** (`_translateInternal`). The two budgets were created in separate phases for separate goals (60s = Phase 42-46 UI spinner "Request Heartbeat"; 55s→100s = Phase 47-48 zombie-fetch killer) and never reconciled. For any multi-batch video the 60s content deadline fired first, while the background was still healthy and streaming; `processEntries` then ran `SyncEngine.stop()` + `Overlay.destroy()`, discarding all rendered partials.

**Options considered**:
1. **Just raise the 60s number** — Pros: one-line. Cons: any fixed total-time deadline eventually breaks on a longer video; doesn't fix partial-loss or the orphaned-background burn.
2. **Reset the fixed deadline on each CHUNK** — Pros: simple. Cons: an idle reset alone doesn't bound a single over-amplified/stalled batch that emits no CHUNK for 30-90s.
3. **Idle watchdog (CHUNK-reset) + per-batch background cap + completeness sweep + preserve partials** — Pros: deadline measures *silence* not total time; one batch can't hang the job; long videos finish; partials survive failure; honest completeness guarantee. Cons: larger, touches both content and background protocol.

**Resolution**: Option 3.
- **Watchdog (a)**: content deadline replaced by a 150s idle watchdog re-armed on `CHUNK` **and** on a per-batch `PROGRESS` heartbeat (the background emits one at every batch boundary, success or failure). Deliberately **NOT** reset on `PONG` — that would reduce it to an "is the SW process alive" check (SW death already surfaces as `PORT_DISCONNECTED` via `onDisconnect`). The heartbeat closes a gap found in review: a `CHUNK` is sent only on batch *success*, so several consecutive failing/rate-limited batches (each up to the 90s cap) would otherwise produce >150s of `CHUNK` silence and false-fire the watchdog on a job that is in fact still advancing. With the heartbeat, the watchdog measures true stall (no batch boundary crossed) while the window (150s) still sits above one batch cap (90s) + a sweep cooldown wait (15s) + margin. (Abort propagation was also fixed so the 90s cap is real: `retranslateWithVerification` now honors the abort `signal` — previously its `Providers.chat` calls ran unbounded.)
- **Per-batch cap + scaled backstop (c)**: each batch is wrapped in a 90s `AbortController` chained to `globalAbort`; the fixed 100s job cap is replaced by `computeForceTimeoutMs` (floor 180s, +2.5s/line, ceiling 600s) so total time scales with batch count. The content watchdog now calls `port.disconnect()` on fire, so the background aborts in-flight work instead of running orphaned (~40s of wasted quota under the old design).
- **Completeness sweep**: after the main pass, failed batches (`failedRanges`) are retried up to 3 rounds, cooldown-aware via `soonestCooldownWaitMs` (waits for the soonest key-cooldown expiry, capped at 15s, so the sweep doesn't burn rounds hammering a 429'd key). Recovered batches stream via `onBatchComplete`.
- **Success-semantics flip (deliberate)**: success now requires `anyBatchSucceeded && !incompleteAfterSweep`. A run still missing batches after 3 sweeps returns `success:false` / `INCOMPLETE_AFTER_SWEEP`. This is stricter than the old `anyBatchSucceeded`, honoring the explicit requirement "nếu gặp vấn đề thì trả về lỗi". UX is preserved because the content side keeps the already-streamed partials (preserve-partials path) and shows a soft "Translation incomplete: X/Y" notice instead of wiping the overlay.
- **Preserve partials (b)**: `processEntries` keeps rendered partials on any `success:false` when `SyncEngine.getTranslatedCount() > 0`; only tears down when nothing was translated.
- **Rate-limit UX (d)**: `'cooldown'` failover status is tagged `status:429` so the UI shows a clear `[429]` row + "Rate limited — add more API keys" hint instead of a cryptic `cooldown`.

**Tradeoff accepted**: a video with one permanently-failing batch (e.g. a single exhausted free-tier key) now shows an "incomplete" warning instead of silent success-with-fallback. This is intentional honesty; partials remain on screen. `BATCH_TIMEOUT_MS` (90s) and `STREAM_IDLE_TIMEOUT_MS` (120s) are tunable if real traces show legitimate batches exceeding them.

**References**: `src/content/main.js` — `requestTranslationStreaming` (watchdog), `processEntries` (preserve partials); `src/background/translator.js` — `computeForceTimeoutMs`, `soonestCooldownWaitMs`, per-batch timeout + sweep in `_translateInternal`; `src/content/sync-engine.js` — `getTranslatedCount`.

### Decision 11 — Phase 66 Behavioral Forks: Keep Shipped Cache TTL (30d) and Circuit Threshold (10)

**Date**: 2026-06-23
**Status**: RESOLVED

**Problem**: The Phase 66 audit found two places where a test/comment encoded a different value than the shipped code, forcing a choice between changing live behavior or updating the test/comment:
- **Cache TTL**: `cache.js` ships `TTL_MS = 30 days`, but the file comment and `cache.test.js` fixture (8-day-old entry expected to expire) both encoded a **7-day** intent.
- **Circuit-breaker threshold**: `health.js:65` opens the breaker at `consecutiveFails >= 10`, but `health.test.js` expected it open after **3** failures.

**Options considered**:
1. **Keep shipped behavior, fix the doc/test** — Pros: zero change to v0.2.2 runtime behavior users already rely on; lowest risk; no re-validation of cache/backoff dynamics needed. Cons: the original (possibly intended) 7-day / 3-fail design is overridden by what shipped.
2. **Revert to the doc/test values (7-day TTL, 3-fail threshold)** — Pros: honors the apparent original design intent. Cons: changes shipped behavior — a 7-day TTL shortens cache lifetime (more re-translation → more user API cost), and a 3-fail threshold makes backoff more aggressive (cuts keys sooner); both need browser re-validation. No evidence the shipped values are wrong.

**Resolution**: Option 1 for both (developer decision, 2026-06-23).
- **Cache TTL → keep 30 days.** Corrected the `cache.js` comment ("7-day" → "30-day") and updated the `cache.test.js` fixture (8-day → 31-day) so the test exercises the real 30-day boundary. Rationale: the 30-day value is what users run; shortening it only increases API cost with no demonstrated benefit.
- **Circuit threshold → keep 10.** `health.js` is unchanged; only `health.test.js` was corrected (loop to 10 fails, renamed). The `>= 10` site notes it was "Relaxed from 5", i.e. a deliberate tuning choice, not drift.

**Tradeoff accepted**: the older 7-day / 3-fail "intent" (if it ever was intent) is now formally superseded by the shipped 30-day / 10-fail behavior. Both remain single-constant tunables (`TTL_MS`, the `>= 10` check) if real usage data later argues for a change.

**References**: `src/background/cache.js` (`TTL_MS`), `src/background/health.js:65` (circuit threshold), `tests/unit/cache.test.js`, `tests/unit/health.test.js`; Phase 66 in `ROADMAP.md` / `CHANGELOG.md`.

### Decision 12 — Phase 69 Coverage Strategy: Honest Denominator + Achieved-Level Ratchet (70% = Milestone-7 Exit, not Phase 69)

**Date**: 2026-06-24
**Status**: RESOLVED (developer-approved)

**Problem**: ROADMAP Phase 69 targets "≥70% global coverage." With an honest denominator (all `src/**` minus the vendored `browser-polyfill.js`) the measured baseline was **23%**. Reaching 70% in one phase is structurally impossible without either (a) the Phase 75 `translator.js` refactor (2052 lines at 12% — ~¼ of testable LOC), (b) grinding low-value DOM-glue tests for `tab-translation.js` (818 L), `popup.js`, `options/*` and the entry scripts — all slated for the Phase 76 UI rework and likely to churn, or (c) gaming the metric by excluding orchestration/UI from measurement.

**Options considered**:
1. **Realistic ratchet** — write honest high-value tests now (providers, overlay, translator pure helpers, light content modules), set `coverageThreshold` at the achieved number, and complete the big modules with their own refactor phases (translator → 75, UI → 76). 70% becomes the Milestone-7 *exit* goal. Pros: every test written is durable and meaningful; no churn; no gaming. Cons: Phase 69 lands ~40% global, not 70%.
2. **Force 70% now** — also test UI glue + entries via jsdom. Pros: hits the number this phase. Cons: large effort on brittle, low-value DOM-glue tests that Phase 76 will likely rewrite; effectively wasted work.
3. **Scope the gate to "core logic"** — measure everything but gate only background/content logic modules. Pros: 70%-on-core achievable now. Cons: a scoped gate can read as hiding the UI/entry gap; needs careful documentation to stay honest.

**Resolution**: Option 1 (developer choice, 2026-06-24; advisor concurred). Coverage measured over `src/**` minus vendored libs only (no orchestration/UI exclusions — "hard to test" ≠ "exclude from the metric"). Phase 69 raised global **23% → 39.9%** with +202 honest tests (providers 97%, overlay 61%, page-detector/trusted-types/utils 100%, subtitle-extractor 90%, video-binder 88%, translator helpers 11%→24%). `coverageThreshold` set a hair below the achieved global (lines/stmts 38, branches 34, funcs 36) so it ratchets without blocking minor changes. Deep `translator.js` coverage deferred to Phase 75 (test the extracted modules, not the soon-to-be-rewritten orchestration); UI-glue coverage to Phase 76.

**Tradeoff accepted**: "≥70% global" is reinterpreted as a Milestone-7 exit criterion reached incrementally across Phases 69/75/76, not a Phase-69 deliverable. The threshold must be raised (never lowered) as those phases land.

**References**: `jest.config.cjs` (`collectCoverageFrom`, `coverageThreshold`); `src/background/translator.js` (`_internals`); Phase 69 in `ROADMAP.md` / `CHANGELOG.md`; the 8 new `tests/unit/*.test.js` files.
