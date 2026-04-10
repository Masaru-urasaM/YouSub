# Changelog

All notable changes to the YouSub project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Anti-Deadlock & Stability Overhaul — Phases 47–48 (2026-04-09)

**Added**
- Global Abort Protocol: Integrated `AbortController` in `translator.js` to immediately terminate all pending `fetch` requests when the 55s safety timeout is reached, stopping background zombie tasks.
- Payload Pre-flight Check: Added Byte-size estimation logic to automatically split batches *before* submission if they exceed 95KB, preventing 413 (Payload Too Large) errors on Groq.
- Key Cooldown Mechanism: Implemented a 10s per-key lockout after 429 errors to prevent rapid-fire spamming of rate-limited API keys.
- Sequential Recursive Splitting: Modified recursive splitting to execute sequentially rather than in parallel, eliminating request spikes that caused concurrent 429/413 errors.

**Changed**
- Logger I/O Optimization: Completely disabled storage persistence for logs during active translation. Logs are now strictly console-only to eliminate Service Worker I/O deadlocks.
- Context Capping: Fixed `VIDEO CONTEXT` length at 500 characters within the system prompt to ensure payload stability across all AI models.
- Success Flag Propagation: Standardized the `success` return flag across all translation paths (recursive and failover) to ensure the UI correctly displays Vietnamese results.

**Fixed**
- "Original Text Only" display bug caused by missing success indicators in split batches.
- Persistent 413 errors on Groq even with small line counts by stripping context in deep recursive calls.
- Infinite logging loop/spam after translation failure.


### Pipeline Stability & Performance — Phases 42–46 (2026-04-08)

**Added**
- Request Heartbeat: 60-second timeout for background requests in `main.js` to ensure the loading spinner always hides.
- Robust Routing: Central `try/catch` and `async/await` refactor for `service-worker.js` and `api-manager.js`.
- Adaptive Rate Limit Handling: Exponential backoff (respecting `Retry-After`) for 429 errors.
- Context Summary Safeguard: 10-second timeout for video analysis calls to prevent pipeline hangs.
- Granular Diagnostic Logging: Detailed "check-in" logs in Background Console (Analyzing → Summary Ready → Batching).

**Changed**
- Key Manager Robustness: Replaced nested promises with clean `async/await` to prevent silent crashes in `getValidKeys`.
- I/O Performance: Centralized storage access in `APIManager` (O(1) fetch instead of O(N) per key).
- Circuit Breaker Relaxed: Increased threshold to 10 consecutive failures to reduce premature key lockouts.

**Fixed**
- Infinite "Loading" UI state caused by silent background crashes.
- `Extension context invalidated` hang when extension reloads without page refresh.
- Potential `TypeError` in Key Scoring logic when encountering new API keys.
- Key Hash Mismatches: Shared `sanitizeKey` logic across all background modules.

### Security & Stability — Phases 36–41 (2026-04-08)

**Added**
- Trusted Types compliance for YouTube's CSP restrictions (`src/shared/trusted-types.js`)
- Health Summary Protocol for real-time API status in Popup UI
- Smart extraction pre-check to handle pre-opened transcript panels

**Changed**
- Zero-width character sanitization across all key-handling modules
- API key `.trim()` enforcement at input, storage, and execution layers
- Batch size optimized to 400 lines; context sampling capped at 100 segments
- 1-second throttle between batch requests to prevent rate limiting
- Strict translation verification — returns failure if all batches fail
- Explicit `host_permissions` for all LLM provider domains (Manifest V3)
- `stream: false` added to OpenAI-style payloads for provider compatibility

**Fixed**
- Fatal `wait is not defined` crash in translator pipeline
- "Green Dot / Red Text" UI state desync in Popup
- Popup hanging indefinitely on health check responses
- API registry bug where auto-detection accessed properties on a string

### Subtitle Sync & Pipeline Hardening — Phases 35.1–35.19 (2026-04-06 → 2026-04-08)

**Added**
- Timestamp-based translation tracking (`[HH:MM:SS]`) replacing numeric IDs
- Translation propagation for merged segments (sticky fill)
- Incremental subtitle display — batches render as they arrive
- Cache transparency — UI distinguishes cache hits from live translations
- Detailed API failure notifications with provider/model breakdown
- Strict error enforcement — pipeline halts on config/API errors
- Production logging flag with automatic build-time override (`IS_PRODUCTION`)
- Broadcast cache invalidation across all open YouTube tabs
- Live API health updates with pulse-red animation for failures
- Custom confirmation modal (glassmorphism) replacing native `confirm()`

**Changed**
- ESM migration — 9+ files converted to standard `import/export`
- Manifest simplified to single entry point + `web_accessible_resources`
- Architecture moved from global `window.YouSub` to explicit module imports
- Incremental merge logic replacing all-or-nothing subtitle updates
- Rigid `[#ID]` identifier tagging with alignment recovery on missing IDs
- Global absolute IDs (video-wide `[#501]`) eliminating per-batch numbering resets

## [0.2.1] — 2026-04-06

### Translation Engine Optimization — Phases 32–35 (2026-04-06)

**Added**
- Incremental subtitle display with batch-by-batch streaming
- Gemini safety filter bypass (`BLOCK_NONE` for all harm categories)
- Interactive error toasts with direct "Open Settings" link
- `YOUSUB_OPEN_SETTINGS` message handler for in-page settings access

**Changed**
- `max_tokens` reduced to 20 for API key validation (was 32,768)
- Provider `chat()` accepts optional `maxTokens` parameter
- Translator supports batch-completion callbacks for streaming UI

## [0.2.0] — 2026-04-06

### Popup UI & Cache Management — Phase 31 (2026-04-06)

**Added**
- "Clear Page Cache" button in Popup for current video
- `Cache.removeByVideoId` for per-video cache purge
- Multi-line API health display with online model names

### Subtitle Appearance & Translation Quality — Phases 23–30 (2026-04-05 → 2026-04-06)

**Added**
- Full-transcript context summary (`generateContextSummary`) for translation batches
- Numbered envelope strategy (`N| Original`) for line count preservation
- Smart regex parser for robust extraction from AI responses
- Dynamic control bar offset for subtitle positioning
- Overlay loading spinner during extraction/translation
- Persistent translation toggle in Popup with visual states
- Signature-based cache with video ID verification

**Changed**
- Adaptive batch sizing with context optimization
- Sparse backfill strategy for partial LLM outputs
- `max_tokens` standardized across providers (uncapped for translation, minimal for testing)
- CSS variables for subtitle positioning with smooth transition animations

### Features & Visual Polish — Phases 14–23 (2026-04-03 → 2026-04-04)

**Added**
- Dual subtitle display (original + translated simultaneously)
- Full appearance customization (font size, color, opacity, position)
- Real-time subtitle preview in Settings
- Premium "Slate & Rose" UI with glassmorphism effects
- Automated packaging via `scripts/package.js`
- Cross-browser support (Chrome, Firefox, Edge) with `webextension-polyfill`
- Test suite — 31 unit tests at 94% coverage (Jest + JSDOM)
- Performance optimization — O(1) subtitle lookup, DOM caching, throttled updates
- Translation caching with LRU eviction (100 videos) and 7-day TTL
- Hybrid extraction engine (XHR primary, DOM scraping fallback)
- YouTube Shorts support and live stream detection
- Error handling with toast notifications and API health indicators
- Structured debug logging (JSON Lines) with export functionality

**Changed**
- Overlay upgraded to vertical Flexbox for multi-line support
- Provider health tracking with circuit breaker states and visual badges
- Cleanup logic refined for SPA navigation (zero memory leaks)

### Foundation & Core Infrastructure — Phases 1–13 (2026-04-03)

**Added**
- Manifest V3 Chrome extension foundation
- SPA-aware YouTube page detection and video player binding
- Subtitle track discovery via MAIN world script injection
- Subtitle fetching and parsing (JSON3 + XML formats)
- Translation pipeline with background service worker proxy
- Multi-provider LLM engine (OpenAI, Gemini, Anthropic, Groq, DeepSeek, xAI, Mistral, OpenRouter)
- API key management UI with CRUD, testing, validation, and failover
- Provider & model registry (`src/shared/providers-registry.js`)
- Full Settings page with tabbed navigation (Translation, Appearance, About)
- Popup UI for quick actions and status display
- Centralized JSON logger (`src/shared/logger.js`)
- Design decisions documentation (`YOUSUB_DESIGN_DECISIONS.md`)
