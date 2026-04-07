# Changelog

All notable changes to the YouSub project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Phase 35.10 — Dual Subtitles & Cache Transparency (2026-04-07)

**Added**
- **Cache Transparency**: The extension now explicitly notifies the user when subtitles are loaded from the local cache instead of via a live API call ("Loaded from cache" vs "Translation complete!").
- **Cache Hit Indicator**: Added a `fromCache` flag to background translation responses to inform the content script of the data source.
- **Dual Mode Real-time Toggle**: Content script now listens for `YOUSUB_TOGGLE_DUAL_MODE` and updates the display immediately without requiring a page refresh or re-translation.

**Changed**
- Updated `service-worker.js` to pass source metadata back to the requester.
- Refactored `main.js` to handle real-time configuration changes for dual-mode display.

**Fixed during implementation**
- Resolved the "Ghost Translation" confusion where translations would appear even with all API keys disabled (due to silent cache hits).

### Phase 35.9 — Pipeline Initialization & Message Sync (2026-04-07)

**Added**
- **Cache-Busting Loader**: Implemented a timestamp query parameter for the main content script import to bypass browser module caching.
- **Message Type Synchronization**: Unified translation trigger messages between Popup (`TOGGLE`) and Content Script (`START/TOGGLE`).

**Changed**
- Refactored `main.js` storage access to use traditional callback patterns for better reliability in unstable background environments.
- Enhanced diagnostic logging throughout the initialization sequence.

**Fixed during implementation**
- Fixed a critical "unresponsive button" bug caused by a mismatch in message type identifiers between the popup UI and the content script.

### Phase 35.8 — Strict Error Enforcement (2026-04-07)

**Added**
- Strict error propagation: `translator.js` now returns `success: false` if no API keys are active.
- Pipeline hard-stop: `main.js` now terminates the translation process immediately on configuration/API errors to prevent "silent success" with original text.
- High-visibility Error UI: Updated `Overlay` to show persistent red error messages with deep-links to Settings.
- Popup "All API Keys Disabled" status: New red indicator in the popup health dashboard.

**Changed**
- Refactored `requestTranslation` (main.js) to properly return structured failure objects.
- Updated `service-worker.js` to avoid caching partial or failed translation attempts.

### Phase 35.7 — Cache & Pipeline Reliability (2026-04-07)

**Added**
- **Real-time Popup UI Sync**: Popup button text now updates instantly when the target language is changed in the Settings tab.
- **Broadcast Invalidation**: Added a broadcast mechanism from background to content scripts to notify all open YouTube tabs when the translation cache is cleared.
- **Hard State Reset**: Content scripts now perform a complete cleanup of local subtitle state when starting a new translation or receiving a cache clear notification, preventing "stale" subtitles from appearing.

**Changed**
- **Incremental Merge Logic**: Replaced all-or-nothing subtitle updates with `SyncEngine.updatePartial`, allowing batch-by-batch merging of translated strings into the master subtitle list.
- **Explicit Target Language Control**: Refactored the core translation pipeline (`main.js`) to pass the target language explicitly from message trigger to final API call.

**Fixed during implementation**
- Resolved the "Stale Japanese" issue where subtitles were stuck in the content script memory even after clearing cache.
- Fixed a bug where partial translation batches would overwrite the entire master subtitle list.

### Phase 35.6 — Live API Health & Status Sync (2026-04-07)

**Added**
- **Live UI Updates**: Implemented a storage listener in the Options page to reflect API key status changes in real-time.
- **Visual Pulse Alerts**: Added a `pulse-red` animation to the "Failed" status text for immediate user awareness.
- **Non-Destructive Sync**: Status updates are targeted to specific DOM elements, ensuring that user focus and unsaved input in API key fields are preserved.

**Changed**
- **Broader Error Detection**: Updated `translator.js` to automatically mark keys as "failed" in the UI for a wider range of critical errors, including rate limits, quota exhaustion, and missing models.

**Fixed during implementation**
- Resolved the "Stale Settings" issue where the API settings page wouldn't reflect failures that occurred while the page was already open.

### Phase 35.5 — Detailed API Failure Notifications (2026-04-07)

**Added**
- **Detailed Failure Tracking**: Background engine now tracks exactly which provider and model caused an API error during translation.
- **Failover Diagnostics**: If all translation attempts fail, the UI now displays a list of the specific provider/model pairs that failed (e.g., `Failed: [Groq/llama3, OpenAI/gpt4]`).
- **Error Categories**: Added `failureReason` flag (`NO_API_KEYS`, `ALL_PROVIDERS_FAILED`) for more precise UI messaging.

**Changed**
- **Actionable Error UI**: Replaced silent console warnings with high-visibility red status notifications on the video overlay.
- **Interactive Settings Link**: Added a direct "Open Settings" link within the error message for immediate troubleshooting.

**Fixed during implementation**
- Resolved the "Silent Fallback" issue where the system would quietly revert to English subtitles when API keys were invalid, leaving the user confused.

### Phase 35.4 — Smart Packaging & Production Logging (2026-04-07)

**Added**
- `IS_PRODUCTION` flag in `src/shared/constants.js`.
- Intelligent build-time override in `scripts/package.js` that automatically sets `IS_PRODUCTION: true` inside the ZIP while keeping the source code as `false`.

**Changed**
- Updated `src/shared/logger.js` to silence non-ERROR logs when `IS_PRODUCTION` is true.

**Tests**
- Verified ZIP content: `src/shared/constants.js` correctly shows `IS_PRODUCTION: true`.
- Verified local source: `src/shared/constants.js` remains `IS_PRODUCTION: false`.

### Phase 35.3 — ESM Refactor & Architecture Modernization (2026-04-07)

**Added**
- **Dynamic Module Loader**: Created `src/content/loader.js` to enable ES Module support in Manifest V3 content scripts.
- **ESM Migration**: Converted 9+ files (`main.js`, `overlay.js`, `sync-engine.js`, etc.) to standard `import/export` syntax.
- **Unified Manifest**: Simplified `manifest.json` by migrating from a static list of scripts to a single entry point + `web_accessible_resources`.

**Changed**
- **Architecture**: Transitioned from global `window.YouSub` name-spacing to explicit module dependency management.
- **Background SW**: Standardized all internal logic to use standard ESM imports.

**Fixed during implementation**
- Resolved: `SyntaxError: Cannot use import statement outside a module`.
- Fixed race conditions and load-order issues inherent in legacy static script injection.

### Phase 35.2 — Global Absolute IDs & AI Transparency (2026-04-06)

**Added**
- **Global Absolute ID Tracking**: Subtitles are now tagged with their unique, video-wide sentence number (e.g., [#501], [#502]) instead of restarting from 1 for every batch. This eliminates AI "relative numbering" hallucinations.
- **AI Raw Response Streaming**: Background logs now push the raw AI text content to the YouTube console (`[YouSub-Bg] RAW RESPONSE`).
- **Interactive Logger Utils**: Added `tail()` and `export()` methods to the `Logger` for manual console troubleshooting.

**Changed**
- **Universal Logger Attachment**: `logger.js` now detects its environment (SW or Content) and attaches itself to the global scope for console accessibility.
- Updated `manifest.json` to include `logger.js` in all YouTube content scripts.

**Fixed during implementation**
- Solved the "Alignment Shift" bug by using absolute pointer IDs that AI models are less likely to re-sequence.

### Phase 35.1 — Rigid Identifier Tagging ([#ID]) (2026-04-06)

**Changed**
- **Identifier Format Migration**: Transitioned from sequential `1|` numbering to rigid `[#1]` tags in translation batches.
- **Prompt Hardening**: Instructed LLMs to treat `[#ID]` as a fixed database key that must never be re-sequenced or modified, even if lines are merged.
- **Alignment Recovery**: Updated the regex parser to map translations explicitly by their `[#ID]`. If an ID is missing, the system now preserves the original text for that specific index, preventing "cascading shifts" for the rest of the batch.

**Tests**: Manual verification of regex logic and prompt structure; confirmed alignment remains intact even with simulated line merges.

### Phase 31.1 — Premium Confirmation Modal (2026-04-06)

**Added**
- Custom **Glassmorphism Confirmation Modal** in both Options page and Popup UI to replace native `confirm()` and unprotected actions.
- `showConfirmModal()` utility for reusable confirmation logic across all UI surfaces.
- CSS animations (fade-in, slide-up) and backdrop blur optimized for both full-page and compact popup views.

**Changed**
- Updated "Clear Translation Cache" (Options) and "Clear Page Cache" (Popup) buttons to require explicit "Yes/No" confirmation.
- Updated "Delete All API Keys" and "Remove Backup Key" buttons in Options to use the new modal system.

**Tests**: Manual UI verification via browser subagent confirmed DOM presence and styling for both surfaces.

## [0.2.1] — 2026-04-06

### Phase 35 — Incremental Subtitle Display (2026-04-06)

**Added**
- Support for "Streaming" translations: Subtitles now update on the video as soon as the first batch (200 lines) is ready.
- `YOUSUB_TRANSLATE_PARTIAL` message type for background-to-content communication.
- `YS.SyncEngine.updateSubtitles` for live data patching without video interruption.

**Changed**
- Updated `translator.js` to support batch-completion callbacks.
- Refactored `main.js` pipeline to initialize with original text immediately, providing zero-latency startup.
- Improved `service-worker.js` to push partial translation blocks to active tabs.

**Tests**: 0 -> 0 (Manual verification of incremental UI updates).

### Phase 34 — Gemini Safety Filter Bypass (2026-04-06)

**Changed**
- Disabled Gemini safety filters by adding `safetySettings` with `BLOCK_NONE` for all categories (Harassment, Hate Speech, Sexually Explicit, Dangerous Content).
- Improved error reporting for Gemini: "Empty response" errors now include the model's `finishReason` (e.g., `SAFETY`, `RECITATION`) for easier debugging.

**Fixed during implementation**
- Resolved "Empty response text from provider" errors on Gemini when translating content with profanity or sensitive terms.

**Tests**: 0 -> 0 (Manual verification of Gemini output with unfiltered content).

### Phase 33 — Interactive Error Notifications (2026-04-06)

**Added**
- Interactive Error Toast: When all translation attempts fail, a red notification appears with a "Mở Cài đặt" link.
- `YOUSUB_OPEN_SETTINGS` message handler to trigger `browser.runtime.openOptionsPage()`.
- Pointer-event support for status messages on the video overlay.

**Changed**
- Updated `YS.Overlay.showStatus` to support HTML content and dynamic action listeners (e.g., `data-action="open-settings"`).
- Refined translation failure logic in `main.js` to provide better user guidance.

**Tests**: 0 -> 0 (Manual verification of status interaction).

### Phase 32 — API Key Test TPM Limit Fix (2026-04-06)

**Changed**
- Reduced `max_tokens` for API Key testing from 32,768 to **20**.
- Refactored `Providers.chat` and provider-specific calls (`callOpenAIStyle`, `callGemini`, `callAnthropic`) to accept an optional `maxTokens` parameter.

**Fixed during implementation**
- Resolved HTTP 413 "Request too large" errors on Groq (and other providers) during API key validation caused by high default token reservations exceeding TPM limits.

**Tests**: 0 -> 0 (Manual verification on Groq `llama-3.3-70b-versatile`).

## [0.2.0] — 2026-04-06

### Phase 31 — Popup UI Polish & Local Cache Purge (2026-04-06)

**Added**
- "Clear Page Cache" button in Popup for current video.
- `Cache.removeByVideoId` method to purge all translation variants for a specific video.
- Support for multi-line API health display showing online models.

**Changed**
- Removed "Status" text from Popup; status is now indicated solely by "Translate" button color.
- Redesigned API Health indicator for better readability with model names.

**Fixed during implementation**
- Corrected logic to hide/show buttons based on video detection in Popup.

**Tests**: 0 -> 0 (Manual verification performed).

### Phase 30 — Smart Regex Parsing & Formatting Resilience (2026-04-06)

**Added**
- Smart Regex Parser using `matchAll` to robustly extract numbered lines (1| Text) regardless of AI formatting noise.
- Universal format recovery for long transcripts (lines 10+).

**Fixed during implementation**
- Resolved "9-line truncation" bug where multi-digit line numbers were failing.
- Satisfied Groq API limits by capping `max_tokens`.

### Phase 29 — Signature-based Cache Architecture (2026-04-06)

**Added**
- Video ID Signature verification before auto-starting translations.
- Aggressive cleanup on SPA navigation to prevent data leakage.

**Changed**
- Selective auto-start: only triggers if a valid cache entry exists for the specific video.

### Phase 28 — Smart Translation Toggle & Loading Indicators (2026-04-06)

**Added**
- **Overlay Loading Spinner**: Integrated a hardware-accelerated circular spinner into the subtitle overlay. It automatically appears during extraction and translation phases, providing immediate visual feedback.
- **Dynamic Popup Toggle**: Refactor the "Get Subtitles" button into a persistent toggle labeled `Translate to [LANGUAGE_NAME]`.
- **Visual Toggle States**: Implemented distinct CSS states for the popup button: Active (Bright Crimson) and Inactive (Slate Grey), with hover transition effects.
- **Auto-Pipeline Start**: Navigation to new YouTube videos now respects the global `yousub_translation_enabled` state, automatically triggering the translation pipeline if it was previously active.

**Fixed during implementation**
- **Persistent Spinner Bug**: Updated `main.js` to ensure `setLoading(false)` is called correctly after async translation batches finish or return early.
- **Token Limit Truncation**: Re-established `max_tokens: 8192` for Gemini and OpenAI providers to prevent default API truncation during large subtitle batch translations.

**Changed**
- Migrated `popup.js` to an ES Module to leverage shared language registries and improve maintainability.
- Updated `overlay.css` with a blurring effect for subtitles while a loading state is active.

### Phase 27.2 — Reliability & Caching Fixes (2026-04-06)

**Fixed during implementation**
- **LLM Context Timeout Fix**: Increased global connection timeout in `providers.js` from `5s` to `60s` to allow large batch generation to complete without triggering `AbortError`.
- **400 Bad Request Fix**: Removed forced `max_tokens: 65000` from OpenAI and Gemini provider fetch payloads to avoid triggering strict HTTP 400 Bad Request limitations from API gateways; maintained Anthropic at `8192` as required.
- **Cache Poisoning Fix**: Fixed `translator.js` to properly assign `hadFallback = true` when returning a partial text result (e.g. when LLM outputs 9/69 sentences). This prevents the Service Worker from permanently caching incomplete response blocks.

### Phase 27.1 — Universal Token Limit Enforcer (2026-04-06)

**Changed**
- **Restored & Standardized Model Token Limit**: Re-introduced `max_tokens` / `maxOutputTokens` parameters into payload configurations across all providers (OpenAI, Gemini, Anthropic), explicitly setting them to `65000`. This establishes a stable, cross-compatible uncapped behavior while satisfying strict validation requirements from API gateways.
- **API Call Timeout Adjustments**: Increased the default connection timeout fallback from `2000ms` (2s) to `5000ms` (5s) for provider requests.

### Phase 27 — Advanced Model Management & API Key Controls (2026-04-06)

**Added**
- **Universal Model Deletion**: The _Delete_ `(✕)` button conceptually expanded from just custom models to *all* models. Removing a core/built-in model automatically registers it in the `yousub_hidden_models` LocalStorage blacklist, keeping the dropdown fully curated for the user.
- **Key Disablement**: Implemented an overarching _Toggle Disable_ feature per-key. `APIManager` now transparently screens out rows flagged as disabled (`opacity: 0.5`) across all primary and backup tiers via a robust UI-state bridge, freeing the user from permanently deleting valuable keys to prevent usage.
- **Intra-Key Model Rotation**: Elevated the translation resilience engine: If `yousub_model_rotation` is active, `APIManager` now dynamically injects "Clone Keys" directly into the translation queue. When `gpt-4o-mini` API endpoint throws an error (e.g. 404), the rotation protocol immediately executes `gpt-4o` falling back onto the *same API Key token's internal list of active models* before attempting to bridge over to secondary fallback properties.

### Phase 26 — Custom Model UI Management (2026-04-06)

**Added**
- **Custom Model Combobox**: Migrated the `Model` dropdown in Translation Settings to a native `<input list>` combobox, allowing users to select default models or manually type unsupported/new LLM model identifiers.
- **Dynamic Auto-Save**: Manual model inputs that are successfully tested via the API test button are automatically persisted to LocalStorage (`yousub_custom_models`).
- **Custom Model Cleanup**: Injected a contextual _Delete (X)_ button next to the combobox that only appears when a saved custom model is selected, allowing users to prune deprecated models.

### Phase 25.2 — Strict Index Parsing & Sparse Mapping (2026-04-06)

**Changed**
- **Strict Numbering Layout**: Upgraded LLM translation parsing to map lines explicitly by their pre-pended index (e.g. `2| Text`).
- **Sparse Backfill Strategy**: If an LLM skips translating a line (e.g. translates line 1 and 3, but skips 2), the translation engine now backfills the missing slot using the explicit original text, instead of rejecting the entire translation batch.
- **Failback Thresholds**: Decreased batch failure strictness: accepts partial outputs if at least 50% of the lines are parsed correctly (or 100% on the final fallback Key), filling the remainder rather than causing total wipeouts.

### Phase 25.1 — Unlimited Model Token Handling (2026-04-06)

**Changed**
- **Uncapped Generation Parameter**: Explicitly removed the `max_tokens` / `maxOutputTokens` restraints from API fetch payloads sent to OpenAI and Gemini providers, freeing the models to resolve arbitrarily large context blocks natively without arbitrary truncation. Anthropic fallback was bumped to 65000 tokens.

### Phase 24 — Subtitle Appearance Refinement (2026-04-06)

**Added**
- **Dynamic Control Bar Offset**: Implemented a CSS-driven logic to push the subtitle overlay up by ~52px when the YouTube control bar is visible (detected via `:not(.ytp-autohide)` on the player).
- **CSS Variables for Positioning**: Migrated `bottom` positioning to CSS variables (`--yousub-pos-bottom`) to allow seamless interaction between user settings and dynamic offsets.

**Changed**
- **Refined Default Appearance**:
    - `fontSize`: 1.85em -> **1.5em** (Improved balance and readability).
    - `bgOpacity`: 0.65 -> **0.25** (More subtle glassmorphism effect).
    - `posBottom`: 80px -> **20px** (Positioned closer to the bottom, leveraging the new dynamic offset).
    - `maxWidth`: 85% -> **80%** (Better fit within the video frame).
- **Transition Synchronization**: Added `bottom` to the CSS transition list for smooth "push-up" animations when hovering over the video player.

**Fixed during implementation**
- **Settings Consistency**: Synchronized default values across `overlay.css`, `overlay.js`, and `tab-appearance.js`.

### Phase 23.6 — Context-Aware & Uncensored Optimization (2026-04-06)

**Added**
- **Full-Transcript Context**: Implemented `generateContextSummary` which analyzes the *entire* video transcript to generate a 2-3 sentence summary for every translation batch.
- **Uncapped Output**: Set `max_tokens` to **65000** and removed default API token limits (1k -> 4k+) in `providers.js` to ensure zero cut-off responses.
- **Unfiltered Translation Prompt**: Added strict non-censorship rules to `systemPrompt` mandating 100% faithfulness, including profanity and slang (e.g. "Mother fucker" -> "Đụ mẹ mày").
- **Adaptive Regex Parser**: Switched from rigid `split('\n')` to a Regex-based parser `split(/\r?\n|(?=\d+[|])/)` capable of recovering lines even if the LLM omits newlines.

**Changed**
- **Increased Batch Size**: Optimized `MAX_LINES_PER_BATCH` to **200** for better context awareness and coherence.
- **System Prompt Hardening**: Strengthened language enforcement for 100% Vietnamese output.

**Fixed during implementation**
- **Parser Robustness**: Resolved "Line count mismatch" fallbacks caused by Llama 3 merging lines in larger batches.
- **Output Cut-off**: Fixed intermittent translation failures where responses were truncated mid-sentence due to low `max_tokens`.

### Phase 23.5 — Translation Consistency Fixes (2026-04-05 → 2026-04-06)


**Added**
- **Numbered Envelope Strategy**: Requests are now sent as `N| Original` pairs to force LLMs to preserve line count.
- **Cross-Context Logging**: Background logs now appear in the YouTube console via `%c[YouSub-Bg]` for real-time debugging.
- **Adaptive Cleaning**: Improved `cleanResponse` logic to strip conversational filler and markdown blocks.
- **Translator metadata**: `translate()` now returns `{ translated, hadFallback }` for downstream cache/UI decisions.

**Changed**
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
