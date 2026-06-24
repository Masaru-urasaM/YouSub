# AI Memory — YouSub Project

## Project Overview
**Status**: v0.2.2 — Phases 0-68 complete (Milestone 7: Professionalization & Hardening, Phases 65-77 in progress)
**Current Milestone**: M7: Professionalization & Hardening (M1-M6 done; post-M6 Phases 62-64 done)
**Last Updated**: 2026-06-24

## Implementation Log

### Milestone 1: MVP (2026-04-03)
- **Phase 1-10**: Project initialization, Manifest V3, SPA navigation, video binding, transcript extraction, Lingva translation, overlay, sync engine, MVP integration.

### Milestone 2: Features (2026-04-03 — 2026-04-04)
- **Phase 12**: Transcript DOM Scraping (bypasses Bot Detection).
- **Phase 13-13.9**: Settings UI, Provider Registry, BYOK Key Management, Multi-provider engine, Health/Circuit Breaker.
- **Phase 14-16**: Dual subtitles, UI customization, structured JSONL logging.
- **Phase 17-22**: Error handling, edge cases (Shorts, Livestreams), caching (LRU/TTL), performance optimization, test infrastructure, cross-browser (Firefox/Edge).

### Milestone 3: Robustness (2026-04-06 — 2026-04-09)
- **Phase 23-35.10**: Visual polish, packaging, translation stabilization, context-aware batching, Absolute ID tracking, ESM refactor, cache transparency.
- **Phases 36-48**: Trusted Types, batch sizing, service worker lifecycle, anti-deadlock overhaul, sequential splitting.

### Milestone 4: Quality (2026-04-10 — 2026-04-25)
- **Phase 50.1-50.7**: YouTube Shorts support, streaming translation (SSE), Ollama local LLM, security hardening, Shorts stability.
- **Phase 52-56**: Service worker lifecycle, cache atomicity, event listener cleanup, null safety, retry logic, request dedup, code quality, popup language selector.
- **Phase 57**: Logger TRACE level, smart Groq payload distribution.
- **Phase 58-59.2**: JSON structured output, merge detection & auto-fix, MergeFixer bug fixes, Google Translate verification, shift-aware realignment.
- **Phase 60-60.1**: Pipeline error visibility, quota diagnostics, rate-limit display.

### Milestone 5: Distribution (2026-05-07)
- **Phase 49**: Production bundling & log management. Log persistence via `storage.session`, console output hygiene, build pipeline v2.0.

### Milestone 6: Expansion (2026-05-07)
- **Phase 61**: Cascade shift detection, 3-tier RoughTranslator.
- **Phase 51.1**: Shorts extraction resilience — YouTube Innertube API fallback for caption tracks.

### Post-M6 Enhancements (2026-05-12 — 2026-06-08)
- **Phase 62**: Subtitle overlay resize/move/reset — dual CSS positioning modes, per-layout storage (regular vs Shorts).
- **Phase 63**: Smart batch distribution — round-robin key groups + intra-group model rotation, model-aware cooldown.
- **Phase 64**: Streaming timeout robustness — 150s idle watchdog, per-batch 90s cap, completeness sweep, preserve-partials (fixes TIMEOUT_BACKGROUND). Browser-verified 2026-06-23.

### Milestone 7: Professionalization & Hardening (in progress, from 2026-06-23)
- **Phase 65**: Commit Phase 64 + version-truth sync (0.2.1 → 0.2.2 across all surfaces). See ROADMAP.md for Phases 66-77.
- **Phase 66**: Fix correctness blockers + hardening. B2 SyncEngine start/stop race (arrow callback + `if (!videoElement) return` guard) — real code fix; B4 was a *test* bug (circuit opens at 10, test expected 3) — test fixed, `health.js` unchanged; B3 kept 30-day cache TTL (fixed comment + test fixture); B1 `esc()` hardening on error-toast captures (test deferred → Phase 68). 198→202 pass / 17→15 fail (217 total). New: `sync-engine-race.test.js`. Kept shipped behavior (TTL 30, circuit 10) — see Decision 11.
- **Phase 67**: Dev-tooling foundation (67a-d). ESLint 9 flat config + Prettier + `.editorconfig`/`.nvmrc`; `package.json` metadata (license AGPL-3.0-only, removed dangling `main`); lint cleaned to **0 problems** (dead-code removal, behavior-preserved, −176 lines); repo-wide Prettier format (52 files, commit `50462db`, + `.git-blame-ignore-revs`); husky + lint-staged pre-commit (lint-staged only, not `npm test`). Tests 202/15 unchanged. New deps: eslint, @eslint/js, globals, prettier, husky, lint-staged.
- **Phase 68**: Test recovery — **test-only, no production code touched**. Fixed all 15 red tests across 3 suites: `subtitle-parser`(6) + `sync-engine`(5) swapped `eval(scriptContent)` → direct ESM `import` (sync-engine needs `jest.unstable_mockModule('overlay.js')` since it calls the imported binding); `api-manager`(4) set `yousub_model_rotation:false` to isolate failover/circuit/sort. Updated stale assertions to shipped behavior (renderSubtitles 4th `isTranslated` arg; `decodeHtml` strips inline tags; hide-on-gap needs prior valid index). Added 1 rotation-on expansion test. **218/218 pass, 0 fail** (was 202/15). DEFERRED D1 (`esc()` test) re-pointed to Phase 75 (main.js entry has top-level side effects; needs `esc()` extracted to utils first).

## Key Concepts
- **Extraction**: Hybrid pipeline (DOM scraping + Innertube API fallback + XHR fetch).
- **Translation**: Batch-based LLM with Full-transcript Context Summary, JSON structured output.
- **Parsing**: Global Absolute ID matching (`[#ID]`) for precise alignment.
- **Cache**: Signature-based (Video ID) with LRU/TTL management.
- **Merge Detection**: Multi-signal weighted scoring (token anchors, sentence boundaries, length ratio).
- **Logging**: `storage.session` ring buffer (10K entries), ERROR dual-path to `storage.local`.
- **Build**: Zero-build-tool packaging with pre/post validation, metadata injection.
