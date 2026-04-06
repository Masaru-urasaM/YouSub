# Gemini Memory — YouSub Project

## Project Overview
**Status**: Stable — v0.2.0 (Cache & Parser Overhaul)
**Current Milestone**: M5: Distribution
**Main Objective**: Finalizing the core engine with robust parsing (Smart Regex) and navigation-aware caching (Signature-based) for flawless user experience.

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
- **Last Updated**: 2026-04-06

### Implementation Log

- **[2026-04-03] Phase 1-16**: Core MVP, Options Page, LLM provider registry, Health/Circuit Breaker.
- **[2026-04-04] Phase 17-22**: Toasts, Hybrid Extraction, Caching, Perf, Test Infrastructure, Cross-browser.
- **[2026-04-06] Phase 23.5-28**: Context-aware summary, Uncensored/Uncapped prompt, Dynamic spacing fix.
- **[2026-04-06] Phase 29**: **Signature-based Cache Architecture**. Implemented Video ID verification and selective auto-start to prevent stale data leakage between videos. Relocated Cache UI.
- **[2026-04-06] Phase 30**: **Smart Regex Parser**. Replaced fragile `split()` with `matchAll()` to solve the "9-line truncation" bug and ensure 100% formatting resilience. Standardized Groq limits to 32768.

### Milestone 5: Distribution (2026-04-04 →)
- **Phase 23 [DONE]**: Visual polish + packaging.
- **Phase 29 [DONE]**: Signature-based Cache Architecture.
- **Phase 30 [DONE]**: Smart Regex Parser & Formatting Resilience.

## Key Concepts
- **Extraction**: Hybrid pipeline (XHR Fetch + DOM Fallback). 
- **Translation**: Batch-based LLM translation with **Full-transcript Context Summary**.
- **Parsing**: **Smart Regex** (`matchAll`) for 100% robust extraction of numbered lines.
- **Cache**: **Signature-based** (Video ID) with LRU/TTL management. Only successful translations are cached.
- **UI**: Vanilla JS CSS-in-JS. Dynamic positioning for YouTube control bar overlap.
