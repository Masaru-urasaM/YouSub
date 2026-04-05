# Gemini Memory — YouSub Project

## Project Overview
**Status**: In Development (Translation Stabilization Phase)
**Current Milestone**: M5: Distribution
**Main Objective**: Stabilizing the translation engine for structural consistency (Prose-ification fix, cache poisoning fix) and preparing for Chrome Web Store release.

## Implementation Log

### Milestone 1: MVP (2026-04-03)
- **Phase 1-3**: Project initialization, Manifest V3 setup, SPA-aware YouTube navigation.
- **Phase 4-6**: Video element binding, transcript extraction (initial API strategy), and normalization.
- **Phase 7-10**: Lingva translation integration, overlay rendering, and time-sync logic.

### Milestone 2: Features (2026-04-03)
- **Phase 12**: Migration to **Transcript DOM Scraping** to bypass Bot Detection.
- **Phase 13**: Full Settings UI (Tabs: Translation, Appearance, About).
- **Phase 13.5-13.7**: Provider Registry and BYOK Key Management (OpenAI, Gemini, etc.).
- **Phase 13.8-13.9**: Multi-provider translation engine with **Failover** and **Health Monitoring**.
- **Phase 18 Progress**: 100%.
- **Phase 19 Progress**: 100%.
- **Phase 20 Progress**: 100%.
- **Phase 21 Progress**: 100%.
- **Phase 22 Progress**: 100%.
- **Phase 23 Progress**: 100% (ARCHIVED).
- **Phase 23.5 Status**: IN PROGRESS — Cache poisoning fix done (2026-04-06). Remaining: Adaptive Parser, Minimal Chunking Fallback.
- **Last Updated**: 2026-04-06

### Implementation Log

- **[2026-04-03] Phase 1-11**: Core MVP completed with basic translation and overlay.
- **[2026-04-03] Phase 12-16**: Switched to DOM Scraping, added Options Page, LLM provider registry, Health/Circuit Breaker, and Dual Subtitles.
- **[2026-04-04] Phase 17**: Error Handling & Toast Notifications.
- **[2026-04-04] Phase 18**: Edge Cases & Hybrid Extraction. Implemented Shorts detection and automated XHR Fetch fallback to DOM scraping.
- **[2026-04-04] Phase 19**: Translation Caching. Implemented `cache.js` (LRU/TTL) and integrated with Service Worker + Settings UI.
- **[2026-04-04] Phase 20**: Performance Optimization. Implemented Temporal Locality and DOM caching.
- **[2026-04-04] Phase 21**: Test Infrastructure. Established Jest + ES Modules testing with 31 tests and 94% coverage.
- **[2026-04-05] Phase 23.1**: Robust Translator Update. Implemented **Numbered Envelope Strategy** and **Rigorous Logging** to solve the Llama 3.3 batch-merging issue. Reduced batch size to 20 lines.
- **[2026-04-06] Phase 23.5 Bugfix**: Fixed **Cache Poisoning** bug — `translator.js` now returns `{ translated, hadFallback }`; `service-worker.js` only caches successful translations; `main.js` uses `hadFallback` flag instead of `JSON.stringify` comparison.

### Milestone 3: Robustness (2026-04-04)
- **Phase 17 [DONE]**: Error handling & In-player status feedback (Toast system).
- **Phase 18 [DONE]**: Edge cases (Shorts support) & Hybrid Extraction pipeline.
- **Phase 19 [DONE]**: Local Translation Caching (LRU/TTL).
- **Phase 20 [DONE]**: Performance Optimization — DOM, Memory, CPU.

### Milestone 4: Quality (2026-04-04)
- **Phase 21 [DONE]**: Test infrastructure + unit tests (Jest).
- **Phase 22 [DONE]**: Cross-browser compatibility — Firefox + Edge.

### Milestone 5: Distribution (2026-04-04 →)
- **Phase 23 [DONE]**: Visual polish + packaging.
- **Phase 23.5 [IN PROGRESS]**: Translation engine stabilization.

## Key Concepts
- **Extraction**: DOM Scraping via MAIN world injection.
- **Translation**: Batch-based LLM translation. Numbered line tracking (N| Translation) implemented. Cache poisoning fix applied — only successful translations are cached.
- **Diagnostics**: Cross-context debugging (Background to Content Script Console) via `%c[YouSub-Bg]` logs.
- **UI**: Vanilla JS CSS-in-JS for live styling updates on the player.
