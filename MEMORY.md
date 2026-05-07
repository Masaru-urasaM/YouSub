# AI Memory — YouSub Project

## Project Overview
**Status**: All phases complete — v0.2.0
**Current Milestone**: M6: Expansion (all milestones M1-M6 done)
**Last Updated**: 2026-05-07

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

## Key Concepts
- **Extraction**: Hybrid pipeline (DOM scraping + Innertube API fallback + XHR fetch).
- **Translation**: Batch-based LLM with Full-transcript Context Summary, JSON structured output.
- **Parsing**: Global Absolute ID matching (`[#ID]`) for precise alignment.
- **Cache**: Signature-based (Video ID) with LRU/TTL management.
- **Merge Detection**: Multi-signal weighted scoring (token anchors, sentence boundaries, length ratio).
- **Logging**: `storage.session` ring buffer (10K entries), ERROR dual-path to `storage.local`.
- **Build**: Zero-build-tool packaging with pre/post validation, metadata injection.
