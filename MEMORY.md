# Gemini Memory — YouSub Project

## Project Overview
**Status**: Healthy — v0.4.8 (Anti-Deadlock & Stability Overhaul)
**Current Milestone**: M5: Distribution
**Main Objective**: Finalizing the core engine with robust anti-deadlock mechanisms and perfect Failover/Splitting logic.

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
- **Phase 18-22 Progress**: 100% (Shorts, Cache, Perf, Tests, Cross-browser).
- **Phase 23-28 Progress**: 100% (Polish, Packaging, Context-aware Summary, Uncensored prompt).
- **Phase 29-30 Progress**: 100% (Signature-based Cache, Smart Regex Parser).
- **Phase 35.1-35.10 Progress**: 100% (Absolute ID Tracking, ESM Refactor, Cache Transparency).
- **Phases 47-48 Progress**: 100% (**Anti-Deadlock Overhaul**. Integrated AbortController, fixed Logger I/O deadlock, and sequentialized 413 failsafe logic).
- **Last Updated**: 2026-04-09

### Implementation Log

- **[2026-04-03] Phase 1-16**: Core MVP, Options Page, LLM provider registry, Health/Circuit Breaker.
- **[2026-04-04] Phase 17-22**: Toasts, Hybrid Extraction, Caching, Perf, Test Infrastructure, Cross-browser.
- **[2026-04-06] Phase 23.5-28**: Context-aware summary, Uncensored/Uncapped prompt, Dynamic spacing fix.
- **[2026-04-06] Phase 31**: **Popup UI Polish**. Removed redundant status text and added per-video cache purging.
- **[2026-04-06] Phase 31.1**: **Premium Confirmation Modal**.
- **[2026-04-06] Phase 32**: **API Key Test TPM Fix**.
- **[2026-04-06] Phase 35**: **Incremental Subtitle Display**.
- **[2026-04-07] Phase 35.1-35.3**: **Absolute ID Tracking & ESM Refactor**.
- **[2026-04-07] Phase 35.9-35.10**: **Stabilization & Transparency**.
- **[2026-04-08] Phase 35.19**: **Stability & Dashboard UI**. Resolved "Checking APIs..." hang.
- **[2026-04-09] Phases 47-48**: **Anti-Deadlock & Stability Overhaul**. Implemented `AbortController` for fetch cancellation, disabled storage I/O during translation (Logger deadlock fix), and sequentialized 413 recursive splitting. Fixed missing `success` flags.

### Milestone 5: Distribution (2026-04-04 →)
- **Phase 23 [DONE]**: Visual polish + packaging.
- **Phase 29 [DONE]**: Signature-based Cache Architecture.
- **Phase 30 [DONE]**: Smart Regex Parser & Formatting Resilience.
- **Phase 35.10 [DONE]**: Dual Toggle & Cache Transparency.

## Key Concepts
- **Extraction**: Hybrid pipeline (XHR Fetch + DOM Fallback). 
- **Translation**: Batch-based LLM translation with **Full-transcript Context Summary**.
- **Parsing**: **Global Absolute ID** matching (`[#ID]`) for 100% precise alignment.
- **Cache**: **Signature-based** (Video ID) with LRU/TTL management.
- **UI**: Vanilla JS CSS-in-JS. Dynamic positioning for YouTube control bar overlap.
