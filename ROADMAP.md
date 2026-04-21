# YouSub — Development Roadmap

> **Hub**: [YOUSUB_PROJECT_SPEC.md](YOUSUB_PROJECT_SPEC.md) (architecture, data flow, appendices)
> **Version**: 6.0
> **Last updated**: 2026-04-21
> **Total phases**: 52 (Phases 0-56 = archived/done, Phase 49 = in progress, Phase 51.1 = pending)

---

## INSTRUCTIONS FOR AI ASSISTANT — READ THIS ENTIRE SECTION BEFORE EVERY SESSION

### How to Use This Document

This file is the **single source of truth** for all development work on YouSub. Before doing ANY work, you MUST:

1. Read `GEMINI.md` — contains hard rules for your behavior
2. Read this file (`ROADMAP.md`) — contains what to do next
3. Read `ROADMAP_DONE.md` — contains what has already been completed
4. Read `YOUSUB_DESIGN_DECISIONS.md` — contains past decisions (do NOT re-propose rejected approaches)

For architecture diagrams, data flows, folder structure, YouTube references, and API specs — see [YOUSUB_PROJECT_SPEC.md](YOUSUB_PROJECT_SPEC.md).

### Phase Execution Protocol — STRICTLY ENFORCED

```
ONE PROMPT = ONE PHASE. NO EXCEPTIONS.
```

**Rules**:
1. **Never execute more than one phase in a single prompt.** If you finish Phase N, STOP. Do NOT start Phase N+1.
2. **After finishing a phase**: run tests, verify everything works, report results, then propose the next phase.
3. **If a phase has problems**: stay on that phase. Fix the problems before proposing the next phase.
4. **If a phase is too large**: split it into sub-phases (e.g., Phase 5a, Phase 5b). Each sub-phase = one prompt.
5. **Always wait for developer confirmation** before starting the next phase.

### After Each Phase — Mandatory Checklist

After completing any phase, you MUST do ALL of the following:

- [ ] Run all tests and verify they pass
- [ ] Update `ROADMAP.md` — change the phase status to `DONE (YYYY-MM-DD)`
- [ ] Update `CHANGELOG.md` — add entry under `## [Unreleased]`
- [ ] Update `YOUSUB_DESIGN_DECISIONS.md` — if any decisions were made
- [ ] Check if the completed phase should be archived to `ROADMAP_DONE.md`
- [ ] Report to developer: what was done, test results, any issues found
- [ ] Propose the next phase and wait for confirmation

### Prompt Pattern for Developer

To start a phase, the developer will say something like:
```
Execute Phase N: [Phase Title]
```
When you receive this, follow the GEMINI.md workflow: Present -> Discuss -> Choose -> Plan -> Code.

---

## BUILD ORDER — QUICK REFERENCE

| Phase | Description | Status | Milestone |
|-------|-------------|--------|-----------|
| 0-50.7 | Core infrastructure, premium UI, smart extraction, incremental translation, ESM Refactor, Streaming (SSE), Ollama Support, Security (Trusted Types), Shorts Stability | DONE (2026-04-10) | M6 |
| 49 | Production Bundling & Log Management | IN_PROGRESS | M5 |
| 51.1 | Resolve Shorts Metadata/Transcript Extraction Failure | TODO | M6 |
| 52.1 | **Critical: Service Worker Lifecycle & Message Safety** | DONE (2026-04-21) | M3 |
| 52.2 | **Critical: Cache Atomicity & DOM Freshness** | DONE (2026-04-21) | M3 |
| 53.1 | **High: Event Listener & Observer Cleanup** | DONE (2026-04-21) | M3 |
| 53.2 | **High: Null Safety & Callback Guards** | DONE (2026-04-21) | M3 |
| 54.1 | **Medium: Retry Logic & Timeout Hardening** | DONE (2026-04-21) | M3 |
| 54.2 | **Medium: Request Dedup & Port/Stream Cleanup** | DONE (2026-04-21) | M3 |
| 55 | **Low: Code Quality Polish** | DONE (2026-04-21) | M4 |
| 56 | **Feature: Popup Language Selector** | DONE (2026-04-21) | M2 |

> **Status format**: `DONE (YYYY-MM-DD)` · `IN PROGRESS` · `BLOCKED (reason)` · `TODO` = not started
>
> **Milestone key**: M1 = MVP, M2 = Features, M3 = Robustness, M4 = Quality, M5 = Distribution, M6 = Expansion

---

## DETAILED PHASE SPECIFICATIONS

### Phase 49 — Production Bundling & Log Management
- **Goal**: Finalize build pipeline and log rotation for production.
- **Status**: IN_PROGRESS

### Phase 51.1 — Shorts Extraction Resilience
- **Goal**: Fix "Could not find subtitles" on certain Shorts.
- **Problem**: Some Shorts lack a transcript button and metadata extraction is failing to find the correct `baseUrl`.
- **Status**: TODO (User Investigation Pending)

---

### Phase 52.1 — Critical: Service Worker Lifecycle & Message Safety
- **Goal**: Prevent message loss and silent failures caused by MV3 Service Worker termination.
- **Files**: `src/background/service-worker.js`, `src/content/main.js`, `src/background/providers.js`, `src/background/translator.js`
- **Status**: DONE (2026-04-21)
- **Summary**: Added keepalive PING/PONG (25s), per-port AbortController with disconnect→abort cascade, chatStream external signal wiring, cache-check 10s timeout guard.

### Phase 52.2 — Critical: Cache Atomicity & DOM Freshness
- **Goal**: Eliminate cache corruption from concurrent writes and stale overlay attachment.
- **Files**: `src/background/cache.js`, `src/content/overlay.js`
- **Status**: DONE (2026-04-21)
- **Summary**: Atomic cache write (data + metadata in single `storage.set()`), `_evictIfNeeded()` uses same metadata snapshot, overlay `show()` verifies `playerElement.isConnected` + active reel check for Shorts.

### Phase 53.1 — High: Event Listener & Observer Cleanup
- **Goal**: Fix memory leaks from accumulated event listeners and observers.
- **Files**: `src/content/overlay.js`, `src/content/main.js`, `src/content/subtitle-extractor.js`, `src/content/video-binder.js`
- **Status**: DONE (2026-04-21)
- **Summary**: Storage listener tracked and removed in `destroy()`, message listener guarded against duplicates, extractor uses one-shot pattern, observer callback wrapped in try/catch with cleanup.

### Phase 53.2 — High: Null Safety & Callback Guards
- **Goal**: Prevent null dereference crashes and double callback invocations.
- **Files**: `src/content/main-world-extractor.js`, `src/content/video-binder.js`
- **Status**: DONE (2026-04-21)
- **Summary**: Null guard for `host` in transcript segment parser (DOM race between check and assignment), `callbackFired` flag in `onVideoFound` with reset in `unbind()`.

### Phase 54.1 — Medium: Retry Logic & Timeout Hardening
- **Goal**: Re-enable automatic retries and add safety timeouts across the pipeline.
- **Files**: `src/background/translator.js`, `src/content/main-world-fetcher.js`, `src/content/subtitle-parser.js`
- **Status**: DONE (2026-04-21)
- **Summary**: `RETRY_ATTEMPTS = 2` with exponential backoff (1s, 3s) for transient failures only (timeouts, 5xx). 20s safety timeout on XHR fetcher. Specific JSON.parse error messages for debugging.

### Phase 54.2 — Medium: Request Dedup & Port/Stream Cleanup
- **Goal**: Prevent API waste from duplicate requests and improve diagnostics.
- **Files**: `src/background/service-worker.js`, `src/background/translator.js`, `src/content/sync-engine.js`
- **Status**: DONE (2026-04-21)
- **Summary**: `inFlightRequests` Map deduplicates concurrent translations for same tab+lang. `activePorts` Map tracks port lifecycle. `updatePartial()` validates startIndex bounds. `failures` array populated with provider/model/status detail.

### Phase 55 — Low: Code Quality Polish
- **Goal**: Eliminate code duplication, standardize patterns, and clean up minor issues.
- **Files**: `src/shared/utils.js` (new), `src/background/api-manager.js`, `src/background/providers.js`, `src/background/health.js`, `src/background/translator.js`, `src/content/overlay.js`
- **Status**: DONE (2026-04-21)
- **Summary**: `sanitizeKey()` centralized in `src/shared/utils.js`, 3 files updated to import. `keyCooldowns` periodic cleanup (60s). Segment validation before translation. Overlay status type whitelist. Tasks 2-3 deferred: `var` usage is consistent in MAIN world IIFE; background `console.*` are styled debug traces.
- **Deferred**: Task 2 (var→const in extractor IIFE — inconsistent with file style), Task 3 (styled console traces intentional)

### Phase 56 — Feature: Popup Language Selector
- **Goal**: Allow users to change target translation language directly from the Popup without opening Settings.
- **Files**: `src/popup/popup.html`, `src/popup/popup.js`, `src/popup/popup.css`
- **Status**: DONE (2026-04-21)
- **Summary**: `<select>` dropdown populated from `YOUSUB_PROVIDERS.languages` (15 langs, no auto). Saves to `targetLang` in storage on change. Syncs bidirectionally with Options page via `storage.onChanged`. Dark glassmorphism styling with custom arrow.
