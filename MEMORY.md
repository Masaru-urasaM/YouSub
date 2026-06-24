# AI Memory — YouSub Project

## Project Overview
**Status**: v0.2.2 — Phases 0-74 complete (Milestone 7: Professionalization & Hardening, Phases 65-77 in progress)
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
- **Phase 69** (Coverage, [EPIC]): honest denominator (`src/**` minus vendored polyfill) baseline **23%**. Decision 12 (developer-approved): "70% global" reframed as Milestone-7 exit (reached across 69/75/76), not one phase. Did the honest winnable work via a 4-agent parallel workflow (each gated green + lint/prettier, no `src/` edits): providers.js 0.35%→97%, overlay.js 6%→61%, translator pure-helpers (via expanded `_internals`) 11%→24%, page-detector/trusted-types/utils 100%, subtitle-extractor 90%, video-binder 88%. **+202 tests (218→420)**, **global 23%→40%**. Added `collectCoverageFrom` + `coverageThreshold` ratchet (38/34/36) to jest.config; added storage-level `chrome.storage.onChanged` to the mock. DEFERRED D3 (providers cosmetic timeout msg). translator deep coverage→75, UI glue→76.
- **Phase 70** (CI): created `.github/workflows/test.yml` (push/PR → npm ci → lint → format:check → test+coverage-gate → package). Repo is local-only (no remote) → workflow is **dormant until pushed to GitHub**; did NOT rename master→main. All steps verified locally (lint/format/test/package all exit 0). Resolved open questions: v0.4.0 (already fixed in P65, only a historical SPEC revision-row remains), src/debug (keep — shipped, wired via popup.js), Phase 77 (developer wants BOTH selector resilience AND full Japanese UI i18n via chrome.i18n).
- **Phase 71** (Docs): SPEC-vs-reality audit (Explore agent). Removed 3 phantom files from SPEC §2.5/2.7 (`toast.js`, `tab-about.js`, `logo.svg` — never existed); rewrote §2.6/2.7 to real ESM architecture (loader.js → dynamic import(main.js) → ESM graph; window.YouSub = shim; web_accessible_resources). Added undocumented real modules + src/debug to the map. New `README.md` (private-repo, BYOK privacy, dev quickstart, AGPL). Decision 13 (phantoms were specced-not-built). LICENSE already done in P67.
- **Phase 72** (Governance): deleted `GEMINI.md` (near-dup of CLAUDE.md); folded its unique `MAX_LINES_PER_BATCH` guard into CLAUDE.md as Rule 12; added Rule 13 (CLAUDE.md = single canonical rules file + maintenance-mode/[Hotfix]). Fixed CLAUDE.md stale Project-Overview boilerplate ("A new software project"→real YouSub desc), removed phantom PROMPT.md from doc tables (CONTEXT.md is real, kept). CLAUDE.md is now the sole AI-rules file.
- **Phase 73** (Hygiene): `git rm --cached` junk (résumé .docx, icons.zip, icon128-original.png, jest_output.txt, tmp/*); deleted dead translator_test.html + resize_icons.js (broken: dead path + jimp v0.x API vs installed 1.6 + only 3/6 sizes). Removed orphaned `jimp` dep → npm audit 38→19 vulns (rest are dev-only, DEFERRED D5). .gitignore += tmp/,*.docx,*.zip,*_output.txt,*-original.png. src/debug KEPT (shipped, wired). DEFERRED D4: résumé still in git history — scrub before any public push. Build/tests unchanged (420/420).
- **Phase 74** (Privacy/store): added in-repo `privacy-policy.md` (mirror of gist `Masaru-urasaM/15f9846…`). Fixed manifest `data_collection_permissions` ["none"]→["websiteContent"] (transcript IS sent to 3rd-party LLM; "none" was false) — ⚠️ verify exact AMO enum at submission. `translate.googleapis.com` host_permission VERIFIED in use (rough-translator.js:66) → kept. Decision 14 (plaintext key storage tradeoff — keep, document). Manifest valid + build VERIFY OK.

## Key Concepts
- **Extraction**: Hybrid pipeline (DOM scraping + Innertube API fallback + XHR fetch).
- **Translation**: Batch-based LLM with Full-transcript Context Summary, JSON structured output.
- **Parsing**: Global Absolute ID matching (`[#ID]`) for precise alignment.
- **Cache**: Signature-based (Video ID) with LRU/TTL management.
- **Merge Detection**: Multi-signal weighted scoring (token anchors, sentence boundaries, length ratio).
- **Logging**: `storage.session` ring buffer (10K entries), ERROR dual-path to `storage.local`.
- **Build**: Zero-build-tool packaging with pre/post validation, metadata injection.
