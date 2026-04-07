# Gemini Memory — YouSub Project

## Project Overview
**Status**: Stable — v0.4.0 (Absolute ID Tracking)
**Current Milestone**: M5: Distribution
**Main Objective**: Finalizing the core engine with absolute subtitle alignment and rich debugging transparency.

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
- **Phase 35.1-35.2 Progress**: 100% (Absolute ID Tracking, Raw Log Streaming).
- **Last Updated**: 2026-04-07

### Implementation Log

- **[2026-04-03] Phase 1-16**: Core MVP, Options Page, LLM provider registry, Health/Circuit Breaker.
- **[2026-04-04] Phase 17-22**: Toasts, Hybrid Extraction, Caching, Perf, Test Infrastructure, Cross-browser.
- **[2026-04-06] Phase 23.5-28**: Context-aware summary, Uncensored/Uncapped prompt, Dynamic spacing fix.
- **[2026-04-06] Phase 31**: **Popup UI Polish**. Removed redundant status text and added per-video cache purging.
- **[2026-04-06] Phase 31.1**: **Premium Confirmation Modal**. Replaced native `confirm()` in Options and unprotected actions in Popup with a custom Glassmorphism modal.
- **[2026-04-06] Phase 32**: **API Key Test TPM Fix**. Reduced `max_tokens` for test requests to 20 to bypass Groq throughput limitations.
- **[2026-04-06] Phase 33**: **Interactive Error Notifications**. Upgraded toast system to support HTML and settings shortcuts on translation failure.
- **[2026-04-06] Phase 34**: **Gemini Safety Filter Bypass**. Disabled Google's default safety filters to allow "Unfiltered" translation and improved error reporting for `finishReason`.
- **[2026-04-06] Phase 35**: **Incremental Subtitle Display**. Implemented "Streaming-like" UX where subtitles update as each batch completes, reducing perceived latency for long videos.
- **[2026-04-07] Phase 35.1-35.2**: **Absolute ID Tracking & Debugging**. Replaced relative numbering with global absolute IDs (`[#501]`) to eliminate AI alignment halluncinations. Added Raw Response streaming to the YouTube console.

### Milestone 5: Distribution (2026-04-04 →)
- **Phase 23 [DONE]**: Visual polish + packaging.
- **Phase 29 [DONE]**: Signature-based Cache Architecture.
- **Phase 30 [DONE]**: Smart Regex Parser & Formatting Resilience.

## Key Concepts
- **Extraction**: Hybrid pipeline (XHR Fetch + DOM Fallback). 
- **Translation**: Batch-based LLM translation with **Full-transcript Context Summary**.
- **Parsing**: **Global Absolute ID** matching (`[#ID]`) for 100% precise alignment.
- **Cache**: **Signature-based** (Video ID) with LRU/TTL management.
- **UI**: Vanilla JS CSS-in-JS. Dynamic positioning for YouTube control bar overlap.
