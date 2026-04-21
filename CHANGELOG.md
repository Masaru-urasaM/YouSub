# Changelog

All notable changes to the YouSub project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Feature: Popup Language Selector — Phase 56 (2026-04-21)

**Added**
- Language selector dropdown in Popup UI — allows users to change target translation language (15 languages) directly without opening Settings.
- Dropdown populated dynamically from `YOUSUB_PROVIDERS.languages` (excluding `auto`).
- Bidirectional sync with Options page via `storage.onChanged` listener.
- Dark glassmorphism styling with custom SVG dropdown arrow, matching existing Popup theme.

**Changed**
- `updateLanguageUI()` now syncs both the Translate button text and the dropdown selection.

### Code Quality Polish — Phase 55 (2026-04-21)

**Added**
- `src/shared/utils.js` — centralized `sanitizeKey()` function, eliminating 3 duplicate copies across `api-manager.js`, `providers.js`, `health.js`.
- Periodic cleanup for `keyCooldowns` Map in translator (every 60s) to prevent unbounded growth.
- Segment validation before translation — filters out entries missing `text` or `startMs`.

**Changed**
- Overlay `showStatus()` now whitelists CSS class type parameter (`info`, `success`, `warning`, `error`), preventing injection of arbitrary class names.
- `manifest.json` updated with `src/shared/utils.js` in `web_accessible_resources`.

### Request Dedup & Port/Stream Cleanup — Phase 54.2 (2026-04-21)

**Added**
- Request deduplication in translator: concurrent `translate()` calls for the same tab+language return the existing in-flight Promise instead of spawning duplicate API requests.
- Active port tracking in service worker via `activePorts` Map with connection timestamps and tab IDs for debugging.
- `failures` array now populated with provider name, model, HTTP status, and retry-after duration for diagnostic display.

**Fixed**
- `SyncEngine.updatePartial()` now validates `startIndex` type and bounds before merging, and stops at array boundary to prevent out-of-bounds writes.

### Retry Logic & Timeout Hardening — Phase 54.1 (2026-04-21)

**Added**
- Automatic retry with exponential backoff (1s, 3s) for transient API failures (timeouts, 5xx errors). 4xx errors (429, 413) continue to use existing cooldown/split mechanisms without retry.
- Secondary 20s safety timeout on XHR fetcher as fallback if `xhr.timeout` (15s) doesn't fire. Aborts XHR and sends error response.

**Changed**
- `RETRY_ATTEMPTS` restored from 0 to 2 (was disabled in Phase 47 anti-deadlock work).
- `JSON.parse()` calls in subtitle parser now produce specific error messages distinguishing parse failures from fetch failures.

### Null Safety & Callback Guards — Phase 53.2 (2026-04-21)

**Fixed**
- Null dereference crash in `main-world-extractor.js` transcript parser when `host` element disappears between DOM check and assignment (race condition on YouTube SPA navigation).
- Double callback invocation in `video-binder.js` prevented with `callbackFired` flag — guards against simultaneous initial-check and MutationObserver both finding the video element.

### Event Listener & Observer Cleanup — Phase 53.1 (2026-04-21)

**Fixed**
- Memory leak: `chrome.storage.onChanged` listeners now stored and removed in `overlay.js` `destroy()`, preventing accumulation across overlay recreations.
- Duplicate `chrome.runtime.onMessage` listener registration in `main.js` guarded with flag.
- `subtitle-extractor.js` now uses one-shot pattern — message listener removed immediately after callback fires.
- `video-binder.js` MutationObserver callback wrapped in try/catch with automatic cleanup on exception.

### Cache Atomicity & DOM Freshness — Phase 52.2 (2026-04-21)

**Changed**
- `Cache.set()` now writes data and metadata in a single atomic `storage.local.set()` call, preventing race conditions between concurrent translation requests.
- `_evictIfNeeded()` operates on the same metadata snapshot used by `Cache.set()` instead of re-reading from storage.

**Fixed**
- Stale overlay attachment after SPA navigation: `Overlay.show()` now verifies `playerElement` is still connected to DOM and is the active player (Shorts reel check) before rendering. Destroys and recreates overlay if stale.

### Service Worker Lifecycle & Message Safety — Phase 52.1 (2026-04-21)

**Added**
- Keepalive heartbeat (PING/PONG every 25s) for streaming port connections to prevent MV3 Service Worker termination during long translations.
- Per-port AbortController in service worker that cancels in-flight API requests when the content script disconnects.
- External abort signal parameter in `translate()` for port-level cancellation cascade.
- Timeout guard (10s) for cache-check `sendMessage` to prevent silent stalls on extension reload.

**Fixed**
- `chatStream()` now properly wires external abort signals, matching the existing pattern in `chat()`. Previously, abort signals from the translator's global timeout were silently ignored during streaming translations.
- All `port.postMessage()` calls in service worker are now wrapped in try/catch to prevent unhandled exceptions after port disconnect.

### Shorts Stability & Video Binding — Phase 50.7 (2026-04-10)

**Added**
- Active Reel Targeting: Enhanced `video-binder.js` to prioritize `ytd-reel-video-renderer[is-active] video` for precise synchronization on YouTube Shorts.
- Visibility Enforcement: Added an `isVisible` check to ensure the extension only binds to the video element currently in the viewport, ignoring hidden/cached reels.

**Changed**
- Synchronization Safety: Hardened `sync-engine.js` to skip processing when a video becomes invisible (e.g., during swiping), preventing "stuck" or "ghost" subtitles.

**Fixed**
- Global Syntax Error: Resolved a fatal `Missing catch or finally` error in `main-world-extractor.js` that blocked initialization on some layouts.
- Stale Timestamp Tracking: Fixed issue where switching Shorts would leave the previous video's subtitles frozen on screen.

### Security Hardening (Trusted Types) & Crash Recovery — Phase 50.6 (2026-04-10)

**Added**
- Global Exception Boundaries: Wrapped `MainWorldExtractor` and `MainWorldFetcher` in high-level `try-catch` blocks to prevent unhandled errors from crashing the main world context.
- Trusted Types Policy Injection: Created `yousub-extractor-policy` and `yousub-fetcher-policy` to ensure DOM manipulation (HTML/Scripts) complies with YouTube's strict security policies.

**Changed**
- Sanitized DOM Updates: Replaced direct `innerHTML` assignments with a `setSafeHTML` helper function across all main-world scripts.
- Multi-Language Support: Added Vietnamese localization support (`"mô tả"`) to the Shorts description menu crawler.

**Fixed**
- Security policy violations (TrustedHTML) that were preventing script injection on modern YouTube layouts.
- Crash-on-error behavior where a single failure in the extraction pipeline would break the entire extension lifecycle until page reload.

### Local LLM Support (Ollama) — Phase 50.3 (2026-04-10)

**Added**
- Ollama Integration: Support for locally hosted Ollama instances via the OpenAI-compatible v1 chat completions API.
- Dynamic Permission Management: Implemented `optional_host_permissions` for `http://localhost/*` and `http://127.0.0.1/*`, allowing users to grant access only when needed.
- Local Model Synchronization: Added a "Refresh Models" feature that dynamically fetches available Ollama models (Llama, Mistral, etc.) via a background proxy to bypass CORS.
- Connection UI: Added a "Connect Ollama" button in the Translation settings for a seamless one-click setup.

**Changed**
- API Header Logic: Updated `providers.js` to omit the `Authorization` header when no API key is provided, ensuring compatibility with local endpoints.

**Fixed**
- Restricted CORS access issues when calling localhost from extension settings pages.

### Streaming Translation (SSE) & Real-time Delivery — Phase 50.2 (2026-04-10)

**Added**
- Port-based Messaging Architecture: Switched to `chrome.runtime.connect` for translation requests to enable long-lived connections and incremental chunk delivery.
- LLM Streaming Support: Implemented `chatStream` in `providers.js` with specialized SSE parsers for OpenAI (delta), Anthropic (content_block_delta), and Gemini (stream JSON).
- Streaming Mode Toggle: Added a new setting in the Options UI to allow users to choose between standard batch delivery and real-time word-by-word streaming.

**Changed**
- Background Translator Orchestration: Updated `translator.js` to accept callbacks for stream chunks, forwarding raw AI output to the frontend as it arrives.
- Content Script Responsiveness: Modified `main.js` to apply partial translation updates to the `SyncEngine` immediately upon chunk reception, significantly reducing perceived latency.

**Fixed**
- UI lag during long-form video translation by eliminating the need to wait for full batch completion (50+ lines) before rendering initial results.
- Message bus bottlenecks by utilizing dedicated Port communication for heavy data streams.

### YouTube Shorts Support & Security Hardening — Phase 50.1 (2026-04-10)

**Added**
- Specialized YouTube Shorts Support: Implementation of "Active Reel" detection and extraction logic. Targeted `ytd-reel-video-renderer[is-active]` to find the correct player on Shorts pages.
- Shorts-specific UI Adaptation: Added `.yousub-shorts` CSS class and logic in `overlay.js` to automatically adjust width and bottom-offset specifically for the vertical Shorts player.

**Changed**
- TrustedHTML Security Enforcement: Switched from inline `innerHTML` assignments to mandatory `TrustedTypes.toSafeHTML()` usage across `overlay.js` and `main.js` to comply with YouTube's strict security policy.
- MainWorldExtractor Robustness: Updated video ID extraction to handle path-based identifiers (`/shorts/VIDEO_ID`) when the `v` URL parameter is absent.
- Module Import Resilience: Converted `Overlay` and `Main` to use explicit ESM imports for `TrustedTypes`, eliminating race conditions and ensuring policy initialization.

**Fixed**
- "TrustedHTML assignment" crash that blocked the overlay from appearing on modern YouTube layouts.
- Subtitle extraction failure on Shorts caused by incorrect selector targeting and missing video ID handling.
- Overlay overlap with Shorts action buttons and metadata by increasing default bottom offset for vertical views.

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
