# Changelog

All notable changes to the YouSub project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-04-04

### Phase 23.5 — Translation Consistency Fixes (2026-04-05 → 2026-04-06)

**Added**
- **Numbered Envelope Strategy**: Requests are now sent as `N| Original` pairs to force LLMs to preserve line count.
- **Cross-Context Logging**: Background logs now appear in the YouTube console via `%c[YouSub-Bg]` for real-time debugging.
- **Adaptive Cleaning**: Improved `cleanResponse` logic to strip conversational filler and markdown blocks.
- **Translator metadata**: `translate()` now returns `{ translated, hadFallback }` for downstream cache/UI decisions.

**Changed**
- Reduced `MAX_LINES_PER_BATCH` from 40 to 20 to improve Model focus and prevent line merging.
- Enhanced Subtitle Overlay visibility (solid white text + stronger shadow).

**Fixed during implementation**
- Fixed `ReferenceError: clearCacheBtn is not defined` in `options.js`.
- Fixed `SyncEngine.start` parameter swap bug.
- **Fixed Cache Poisoning bug**: `service-worker.js` was caching fallback (original English) text as if it were a successful translation. Subsequent runs hit the poisoned cache and displayed English instead of the target language. Fix: `translator.js` returns `hadFallback` flag; `service-worker.js` only caches when `!hadFallback`; `main.js` uses the flag instead of weak `JSON.stringify` comparison.

**Remaining work**
- Adaptive Parser (Handle hallucinated numbers or omitted pipes).
- Minimal Chunking Fallback (If 20 fails, try 5 or 1).

### Phase 23 — Visual Polish & Packaging

**Added**
- **Premium UI/UX**: Implemented a modern "Slate & Rose" aesthetic across the entire extension.
- **Glassmorphism**: Added `backdrop-filter` blur and semi-transparent backgrounds to the subtitle overlay for superior readability.
- **Micro-animations**: Hardware-accelerated transitions, fade-ins, and "breathing" health indicators.
- **AI-Generated Assets**: Created high-resolution master icons and a Chrome Web Store promo banner.
- **Automated Packaging**: Added `scripts/package.js` using `adm-zip` to generate production-ready bundles (`.zip`).
- **Standardized Versioning**: Synced `manifest.json` and `package.json` to v0.1.0.

**Changed**
- Refined typography using 'Inter' and 'Outfit' fonts for a high-end feel.
- Optimized CSS variables and transition timings for snappy performance.

- **Phase 22 Progress**: 100% (Completed Cross-Browser Compatibility).
- **Phase 23 Progress**: 100% (Completed Visual Polish & Packaging).
- **Current Milestone**: Milestone 5: COMPLETE.
- **Last Updated**: 2026-04-04

### Phase 22 — Cross-Browser Compatibility (2026-04-04)

**Added**
- Support for **Firefox** and **Edge** using a unified `browser` namespace.
- Integrated `webextension-polyfill` into the project as a no-build dependency.
- Hybrid `manifest.json` supporting both `service_worker` (Chrome/Edge) and `scripts` (Firefox).
- Firefox-specific settings (Gecko ID) and strict versioning.

**Changed**
- Migrated 10+ Javascript files (Background, Content, UI) from `chrome.*` to `browser.*`.
- Converted callback-based API calls to Promise-based ones for better readability and cross-browser reliability.
- Updated Jest mocks to support the unified `browser` API and satisfy extension environment checks.

**Tests**: 31 tests passing (100% pass rate).

### Phase 21 — Test Infrastructure & Unit Tests (2026-04-04)

**Added**
- Full testing suite using **Jest** and **JSDOM**.
- Comprehensive unit tests (31 tests) for core modules: `Cache`, `SyncEngine`, `SubtitleParser`, `ProvidersRegistry`, `APIManager`, and `HealthManager`.
- Automated code coverage reporting (94% coverage achieved for logic modules).
- Mocking infrastructure for Chrome Extension APIs (`chrome.storage`, `chrome.runtime`).
- NPM project integration with specialized ESM test runner configuration.

**Changed**
- Configured project as `type: module` to support native ES module testing.
- Refined `SyncEngine` and `SubtitleParser` for improved testability in simulated DOM environments.

**Tests**: 31 tests passing (100% pass rate).

### Phase 20 — Performance Optimization (2026-04-04)

**Added**
- Temporal Locality optimization in `SyncEngine`: prioritized $O(1)$ lookup for current/next subtitles before $O(\log n)$ search.
- DOM reference caching in `Overlay`: reduced expensive DOM lookups during playback.
- Style update throttling: skipped redundant CSS updates if values haven't changed.

**Changed**
- Refined cleanup logic in `VideoBinder` and `PageDetector` to virtually eliminate memory leaks during SPA navigation.
- Improved `SyncEngine.stop()` to be more thorough in resetting state.

**Tests**: 23 tests passing (Performance verified via logic profiling and leak checks).

### Phase 19 — Translation Caching (2026-04-04)

**Added**
- `src/background/cache.js`: Full caching engine with LRU (Least Recently Used) eviction and TTL support.
- "Clear Translation Cache" button in Settings Page (About tab) for manual maintenance.
- LRU strategy: Limit of 100 videos to optimize `chrome.storage.local` usage.
- TTL strategy: 7-day expiration for cached translations.

**Changed**
- Updated `service-worker.js` to use a Cache-Aside pattern (Check cache -> Hit/Miss logic).
- Updated `content/main.js` to pass `videoId` as a key for caching.

**Tests**: 21 tests passing (Caching logic, LRU eviction, and TTL verified).

### Phase 18 — Edge Cases & Hybrid Extraction (2026-04-04)

**Added**
- YouTube Shorts support: URL detection (`/shorts/`) and videoId extraction.
- Hybrid Extraction Engine: Automatic failover between XHR Fetch (Primary) and DOM Scraping (Fallback).
- Live Stream Detection: Proactive feedback for unsupported content types.
- Multi-track Metadata Discovery: Extracts all available languages via `ytInitialPlayerResponse`.

**Changed**
- Refactored `main.js` pipeline into a smarter, asynchronous sequence.
- Optimized `MainWorldExtractor` to report full metadata including track list and isLive status.
- Improved cleanup logic in `PageDetector` and `VideoBinder` for seamless single-page-app transitions.

**Fixed during implementation**
- Fixed extension hanging on videos without a visible "Show transcript" button (e.g., Shorts).
- Fixed syntax errors and naming inconsistencies in the injection pipeline.

**Tests**: 19 tests passing (Hybrid logic verified on Watch and Shorts).

### Phase 17 — Error Handling & User Feedback (2026-04-03)

**Added**
- Status "Toast" notification system on the video player.
- API Health Indicator in the Popup UI.
- Graceful degradation: auto-fallback to original subtitles with user notification on translation failure.
- Actionable error messages for extraction failures.

### Phase 16 — Structured Debug Logging & Export (2026-04-03)

**Added**
- Full log export functionality in the Options page.
- Ability to download `.jsonl` debug logs for troubleshooting.

### Phase 15 — UI Customization (2026-04-03)

**Added**
- Appearance settings tab with full customization controls (Font Size, Color, Opacity, Position).
- Real-time Subtitle Preview with a high-contrast cinematic background.

**Changed**
- Updated `overlay.js` to support real-time style updates via `chrome.storage.onChanged`.
- Integrated dynamic CSS generation for the subtitle overlay based on user preferences.

### Phase 14 — Dual Subtitle Display (2026-04-03)

**Added**
- Dual subtitle mode: displays both original and translated text simultaneously.
- Toggle switch in the Popup for immediate dual-mode switching.

**Changed**
- Updated Overlay system with a vertical Flexbox layout for multi-line support.
- Enhanced Sync Engine to manage dual-mode state and real-time UI updates.

### Phase 13.9 — Provider Health & Intelligence (2026-04-03)

**Added**
- `src/background/health.js`: New module for tracking API success rates, response times, and managing circuit breaker states.
- Visual health badges in the Options UI (Green/Yellow/Red/Broken).

**Changed**
- `src/background/api-manager.js`: Integrated performance-based sorting for backup keys and automated circuit-breaker filtering.
- `src/background/translator.js`: Integrated real-time performance measuring and health reporting.
- Options UI: Enhanced API key rows with live performance metrics.

### Phase 13.8 — Multi-Provider Translation Engine (2026-04-03)

**Added**
- `src/background/api-manager.js`: Logic for loading and selecting configured API keys with failover support.
- Implemented `chat()` method in `Providers` for generic LLM interactions.

**Changed**
- `src/background/translator.js`: Complete rewrite to support LLM batching, system prompts for subtitle accuracy, and multi-key failover.
- Upgraded `Providers` to handle complex chat parameters and response parsing for OpenAI, Gemini, and Anthropic.

**Fixed during implementation**
- Resolved `429 Too Many Requests` by migrating away from public Lingva instances.
- Improved translation stability by enforcing line-count preservation in LLM responses.

### Phase 13.7 — API Key Testing & Validation (2026-04-03)

**Added**
- `src/background/providers.js`: Specialized module implementing API request logic capable of interfacing with OpenAI-style models, Google Gemini APIs, and Anthropic.
- Added `YOUSUB_TEST_API_KEY` listener to `service-worker.js` acting as a CORS-safe proxy.

**Changed**
- `tab-translation.js`: Upgraded Test Button to bridge communication to the generic `providers.js` and securely process timeouts (`AbortController`), missing configurations, and server validations natively.

**Tests**: 0 -> 0 (Backend ping implementation tests were verified dynamically against Groq API Key mock via UI).

### Phase 13.6 — API Key Management UI (2026-04-03)

**Added**
- `src/options/tab-translation.js`: Extracted translation tab logic into a dedicated ES Module to handle complex API Key CRUD state.
- `src/options/options.html`: Added `<template id="api-key-row-template">` for dynamically building scalable key fields (Primary + up to 3 Backups).

**Changed**
- `src/options/options.js`: Refactored to delegate translation UI logic to `tab-translation.js`.
- `src/popup/popup.js`: Inserted Gate Logic to block the extraction/translation pipeline if the user attempts to run it without configuring at least one API key.

**Fixed during implementation**
- Avoided monolithic UI state code within `options.js` by isolating feature domains (Decision 7 compliance).

**Tests**: 0 → 0 (UI implementation tested manually).

### Phase 13.5 — Provider & Model Registry (2026-04-03)

**Added**
- `src/shared/providers-registry.js`: Pure ES Module defining 8 LLM providers (Google Gemini, OpenAI, Anthropic, DeepSeek, Groq, xAI, Mistral, OpenRouter) with endpoints, API styles, model lists, key pattern detection, and a 16-language list.
- Helper functions: `getProvider()`, `getModelsForProvider()`, `detectProviderFromKey()`.

**Changed**
- `src/shared/constants.js`: Added `TEST_API_KEY`, `TEST_RESULT`, `API_KEYS_UPDATED` message types.
- `src/options/options.html`: Switched from classic `<script>` tags to `<script type="module">` (Decision 7 — ES Modules Everywhere).
- `src/options/options.js`: Refactored from IIFE to ES Module. Now imports `Logger` and `YOUSUB_PROVIDERS` directly.

**Design Decision**
- Recorded Decision 7: All shared modules use ES Module `import/export`. Content scripts stay IIFE and use message passing for shared data.

**Tests**: 0 → 0 (Pure data module, verified via structure review).

### Phase 13 — Settings Page Architecture (2026-04-03)

**Added**
- `src/options/options.html`, `options.css`, `options.js`: Full-page settings UI with a tab-based navigation system separating Translation, Appearance, and About settings.
- Dark theme styling inspired by desktop applications designed specifically for extension constraints.
- Tab-controller logic written in Vanilla JS enabling smooth, no-reload switching between configurations.
- `manifest.json`: Added `options_page` capability pointing to the new settings hub.

**Changed**
- `src/popup/popup.html` & `popup.css`: Radically simplified the popup UI to only present quick actions (Run translations) and a prominent status indicator.
- `src/popup/popup.js`: Removed language selection logic (now deferred to the new Options page settings logic). Mapped the new "Open Settings" button via `chrome.runtime.openOptionsPage()`.

**Tests**: 0 -> 0 (Changes are purely structural UI and DOM state).

### Phase 8.1 — Debug Logging & Pipeline Diagnostics (2026-04-03)

**Added**
- `src/shared/logger.js`: A specialized centralized JSON Logger (Rule 9) that writes JSON Lines to the DevTools console and buffers logs into `chrome.storage.local`.
- Introduced `Promise.all` in Lingva chunking to dispatch requests in parallel to prevent silent hangs.

**Changed**
- Migrated all `console.log` and `console.error` in the background worker and translator to use the new `Logger` utility to trap HTTP 429 errors from Lingva API natively.
- Increased `MAX_CHUNK_CHARS` from 400 to 1000 to drastically reduce redundant requests.

**Fixed during implementation**
- Identified that Lingva API causes a cascading fallback loop when multiple chunks are sent rapidly or API rate limits trigger. Added HTTP Status debugging to capture the exact failure condition (CORS or HTTP 429).
- Resolved an issue where background process timeout caused translations to silently abort and display original texts.

**Tests**: 0 -> 0 (Focus on console logging infrastructure).

### Phase 8 — Overlay UI Foundation & Sync Tuning (2026-04-03)

**Added**
- `src/popup/popup.html`, `popup.css`, `popup.js` — User interface to trigger extraction manually and set target language.
- `assets/icons/` — Generated and placed extension icons (16, 48, 128px) for Chrome Toolbar.
- `YOUSUB_START_EXTRACTION` message handler in `main.js` to prevent automatic extraction without user consent.

### Phase 12 & DOM Scraping Migration (2026-04-03)

**Added**
- `src/popup/popup.html`, `popup.css`, `popup.js` — User interface to trigger extraction manually and set target language.
- `assets/icons/` — Generated and placed extension icons (16, 48, 128px) for Chrome Toolbar.
- `YOUSUB_START_EXTRACTION` message handler in `main.js` to prevent automatic extraction without user consent.

**Changed**
- `src/content/main-world-extractor.js` — Rewritten to scrape Subtitles directly from YouTube Transcript Panel UI. Replaces API fetch strategy to evade 403 Forbidden / POT Token Bot Detection. It dynamically searches for `transcript-segment-view-model`.
- `main.js` — Modified control flow to stop auto-extraction. Wait for Chrome extension click.
- `src/background/service-worker.js` — Fixed `import() is disallowed on ServiceWorker` bug via static ES import compliance for `translator.js`.

**Tests**: 38 entries successfully extracted from DOM rendering, routed through Lingva API with Vietnamese target.

### Phase 7 — Translation API Client (2026-04-03)

**Added**
- `src/background/translator.js` — ES module implementing Lingva Translate API client. Supports bulk-chunked translation (1500 char chunks), per-chunk fallback to individual translation, AbortSignal timeout (15s), and graceful degradation (returns original text on failure).
- `requestTranslation()` helper in `src/content/main.js` — sends subtitle texts to background worker via `YOUSUB_TRANSLATE_REQUEST`, merges translated strings back into subtitle entries.

**Changed**
- `src/background/service-worker.js` — imported `translator.js`, added `YOUSUB_TRANSLATE_REQUEST` message handler that calls `translate()` and returns `{ success, translated[] }`.
- `src/shared/constants.js` — added `YS.MSG` with `TRANSLATE_REQUEST` / `TRANSLATE_RESPONSE` message type strings for content script reference.
- `src/content/main.js` — wired full pipeline: parse → translate → store in `YS._lastSubtitles`. Added `onLeave` callback to clean up state. Replaced arrow functions with `function` keyword for ES5 compatibility.

**Design**
- Lingva API (Decision 2): `GET https://lingva.ml/api/v1/{src}/{tgt}/{encodedText}`
- Chunking strategy: texts joined with `\n###YOUSUB###\n` delimiter per chunk ≤ 1500 chars → split result back; mismatch = individual fallback
- Translation never crashes the pipeline: all errors fall back to original text

**Tests**: Manual verification — reload extension, open video with subtitles, confirm console shows `Translation pipeline complete!` and `window.YouSub._lastSubtitles[0].text` is translated.

### Phase 6 — Subtitle Fetching + Parsing (2026-04-03)

**Added**
- `src/content/subtitle-parser.js` — fetches and parses YouTube subtitle timedtext into normalized `{startMs, endMs, text}` format. Handles JSON3 and XML formats.
- Vietnamese-first selection logic in `main.js` to prioritize native/auto-generated Vietnamese tracks.

**Changed**
- `src/background/service-worker.js` — added a fetch proxy to bypass content script CSP/CORS restrictions (Fix for 0-byte responses).
- `src/content/subtitle-parser.js` — refactored to use background fetch proxy.
- `src/shared/constants.js` — added shared language constants (`DEFAULT_TARGET_LANG: 'vi'`).
- `manifest.json` — added `subtitle-parser.js` to loading context.

**Fixed during implementation**
- **0-Byte Response / ERR_NAME_NOT_RESOLVED**: Moved fetching logic to the background script to ensure reliable data retrieval regardless of page-level security policies.

| 0-23 | CORE INFRASTRUCTURE, ROBUSTNESS, QUALITY & DISTRIBUTION | ARCHIVED | M1-M5 |

### Phase 5 — Subtitle Track Discovery (2026-04-03)

**Added**
- `src/content/subtitle-extractor.js` — MAIN world script injection to read YouTube data

**Changed**
- `src/content/main.js` — triggers `SubtitleExtractor` on video bound
- `manifest.json` — added `subtitle-extractor.js` to content script load order

### Phase 4 — Video Player Detection + Binding (2026-04-03)

**Added**
- `src/content/video-binder.js` — MutationObserver-based video element finder

**Changed**
- `src/content/main.js` — calls `VideoBinder.bind()` on enter, `unbind()` on leave
- `manifest.json` — added `video-binder.js` to content script load order

### Phase 3 — YouTube Page Detection + SPA Navigation (2026-04-03)

**Added**
- `src/content/page-detector.js` — SPA-aware YouTube watch page detector
- `window.YouSub.PageDetector` module with `init()`, `destroy()`, `getCurrentVideoId()`

**Changed**
- `src/content/main.js` — wired up PageDetector with enter/leave callbacks
- `manifest.json` — added `page-detector.js` to content script load order

### Phase 2 — Design Decisions (2026-04-03)

**Added**
- `YOUSUB_DESIGN_DECISIONS.md` file documenting architecture decisions.
- Added Phase 13.5 to the Roadmap for Custom LLM Translation Integration.

### Phase 1 — Extension Foundation (2026-04-03)

**Added**
- `manifest.json` for Manifest V3 support
- Core directory structure (`src/`, `assets/`, `tests/`, `logs/`)
- Placeholder scripts (`main.js`, `service-worker.js`, `constants.js`, `popup.js`)
- Placeholder UI (`popup.html`, `popup.css`, `overlay.css`)
- Placeholder icons
- `.gitignore` file
