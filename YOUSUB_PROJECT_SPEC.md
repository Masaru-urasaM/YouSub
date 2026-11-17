# YouSub — Complete Project Specification

> **Document purpose**: This is the single source of truth for the YouSub project. It is written as an AI-readable prompt/specification so that any AI coding assistant (Gemini, Claude, etc.) can read this document and understand the full scope, architecture, decisions, and constraints of the project. It is also readable by human developers.
>
> **Document version**: 2.5
> **Last updated**: 2026-11-17
> **Status**: **STABLE** — shipped **v0.2.2** (Chrome Web Store); local **v0.2.4** built and awaiting store upload
>
> **Structure**: This file is the navigation hub and architecture reference. For active/pending development phases, see [ROADMAP.md](ROADMAP.md). For completed phases, see [ROADMAP_DONE.md](ROADMAP_DONE.md).

---

## 1. Project Overview

### 1.1 What is YouSub?
YouSub is a browser extension that intercepts native YouTube transcripts/subtitles, processes and translates them into a desired language, and displays them via a beautifully synced custom overlay on the video player in real-time.

### 1.2 Core Principles
1. **Non-Intrusive & Premium UI**: The subtitle overlay must be elegantly designed and seamlessly overlap YouTube's player without disrupting native controls.
2. **Performance-First**: The translation and syncing must be highly optimized. (e.g., bulk translating the transcript file to minimize API pinging and stop latency issues).
3. **Cross-Browser Foundation**: Built fundamentally on Manifest V3. The code should avoid Chrome-only legacy quirks where standard WebExtensions APIs suffice, allowing for an easy Firefox port.

### 1.3 Target Platform
- **Primary**: Google Chrome (Manifest V3)
- **Secondary**: Firefox, Microsoft Edge, Brave
- **Distribution**: Local Unpacked Extension (development), Chrome Web Store (production)

### 1.4 Target Users
- **Primary**: The solo developer maintaining it.
- **Secondary**: Any user who requires high-quality, readable, customized translated subtitles on YouTube.

---

## 2. Architecture

### 2.1 System Diagram

```
+------------------------------------------------------------------+
|                    YouSub Browser Extension                       |
|                                                                   |
|  +---------------------+         +--------------------------+    |
|  |   Popup (Quick UI)  |         |  Background Worker       |    |
|  |  +--------------+   |         |  +--------------------+  |    |
|  |  | Start Button |   |         |  | Multi-Provider     |  |    |
|  |  | Status Badge |   |  chrome |  | Translation Engine |  |    |
|  |  | Open Settings|   | .runtime|  |                    |  |    |
|  |  +--------------+   | .message|  | +----------------+ |  |    |
|  |         |            |<------->|  | | Provider       | |  |    |
|  |         | chrome     |         |  | | Health Manager | |  |    |
|  |         | .storage   |         |  | +----------------+ |  |    |
|  |         v            |         |  +--------------------+  |    |
|  +---------------------+         |          |                |    |
|                                   |          v                |    |
|  +---------------------+         |  +--------------------+  |    |
|  | Options Page        |         |  | Translation Cache  |  |    |
|  | (Full Settings UI)  |         |  | (chrome.storage)   |  |    |
|  |  +---------------+  |         |  +--------------------+  |    |
|  |  | Tab: Translate |  |         +--------------------------+    |
|  |  |  - API Keys   |  |                    ^                     |
|  |  |  - Provider   |  |                    | chrome.runtime      |
|  |  |  - Language   |  |                    | .sendMessage        |
|  |  +---------------+  |                    v                     |
|  |  | Tab: Appear.  |  |  +------------------------------------------+
|  |  |  - Font/Color |  |  |          Content Script (YouTube page)    |
|  |  |  - Position   |  |  |                                          |
|  |  +---------------+  |  |  +--------+ +--------+ +------+ +-----+ |
|  |  | Tab: About    |  |  |  | Page   | |Subtitle| |Sub.  | |Over | |
|  |  |  - Version    |  |  |  |Detector|>|Extract.|>|Parser| |lay  | |
|  |  |  - Links      |  |  |  |(SPA)   | |(tracks)| |(JSON)| |Ctrl | |
|  |  +---------------+  |  |  +--------+ +--------+ +------+ +-----+ |
|  +---------------------+  |                              |     ^     |
|                            |                              v     |     |
|                            |                         +---------+|     |
|                            |                         |  Sync    |     |
|                            |                         | Engine   |     |
|                            |                         |(timeupd.)|     |
|                            |                         +----------+     |
|                            +------------------------------------------+
|                                         |                              |
|                                         v                              |
|  +------------------------------------------+                         |
|  |         YouTube Video Player DOM          |                         |
|  |  #movie_player > .html5-video-container   |                         |
|  +------------------------------------------+                         |
+------------------------------------------------------------------+
```

### 2.2 Data Flow (Full Pipeline)

```
Step 1:  User installs extension, opens Options Page
Step 2:  User configures API key (Provider + Model + Key) in Translation tab
Step 3:  User navigates to youtube.com/watch?v=VIDEO_ID
Step 4:  Content script detects watch page (URL check + yt-navigate-finish)
Step 5:  Content script finds <video> element via DOM query + MutationObserver
Step 6:  Content script injects <script> to read ytInitialPlayerResponse from MAIN world
Step 7:  ytInitialPlayerResponse.captions → array of { baseUrl, languageCode, kind }
Step 8:  Fetch baseUrl + "&fmt=json3" → JSON response with events
Step 9:  Parse into normalized array: [{ startMs, endMs, text }, ...]
Step 10: Multi-provider failover: if Primary fails, try Backup 1 -> Backup 2...
Step 11: LLM Prompt Injection:
     - **Global Absolute IDs**: Each line is tagged with its video-wide index `[#ID]` (e.g., Batch 2 starts at `[#501]`).
     - **Smart Regex Parser**: Uses `matchAll` to extract lines by ID, preventing alignment shifts even if AI merges output.
Step 12: Cache result in `chrome.storage.local` keyed by `videoId`.
```

### 2.3 API Key Data Flow

```
Options Page (UI)                chrome.storage.local              Background Worker
+------------------+            +-------------------+            +------------------+
| Provider: [Groq] |  save =>   | yousub_api_keys:  |  load =>   | APIManager       |
| Model: [llama-3] |            |  [{provider,model |            |  .translate()    |
| Key: [gsk_xxx]   |            |    ,key,status}]  |            |  .testKey()      |
| [Test] [Show]    |            +-------------------+            |  .getHealth()    |
+------------------+                                             +------------------+
```

### 2.4 Technology Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Manifest version | V3 | Current standard, required for Chrome Web Store |
| Language | Vanilla JS (ES2020+) | Lightweight, no build step needed |
| Framework | None | Project scope doesn't justify framework overhead |
| State management | `chrome.storage.local` + `storage.session` | Local for keys/settings/cache; session memory buffer for logs |
| Build system | None (packaging script only) | Plain ESM files loaded natively; `scripts/package.js` builds store ZIPs |
| Module pattern | ESM (`loader.js` dynamic `import()`) + `window.YouSub` shim | Native ES modules in content script; shim kept for compatibility |
| Background worker modules | ES modules (`"type": "module"`) | Supported natively in MV3 service workers |
| Translation engine | Multi-provider LLM (user's own API key) | Professional quality, user controls cost and provider |
| API key storage | `chrome.storage.local` (no encryption) | Chrome extension storage is sandboxed per-extension |
| Settings UI | Chrome Options Page (`options_page`) | Full-page UI with tabs, not constrained by popup size |

### 2.5 Folder Structure

```
YouSub/
+-- manifest.json                       # Extension manifest (Manifest V3)
+-- src/
|   +-- content/                        # Content scripts (injected into YouTube pages)
|   |   +-- loader.js                   # Manifest content-script entry — dynamic-imports main.js as ESM
|   |   +-- main.js                     # Orchestrates all content modules (ESM, imported by loader.js)
|   |   +-- page-detector.js            # YouTube page detection + SPA navigation
|   |   +-- video-binder.js             # Find and monitor <video> element
|   |   +-- subtitle-extractor.js       # Extract subtitle tracks + conservative sourceLang
|   |   +-- subtitle-parser.js          # Parse timedtext JSON3/XML into normalized format
|   |   +-- rough-translate-bridge.js   # Content bridge to MAIN-world on-device Translator
|   |   +-- overlay.js                  # Overlay UI, drag/resize layout, status messages
|   |   +-- sync-engine.js              # Synchronization: timeupdate -> subtitle lookup
|   |   +-- overlay.css                 # Overlay styles
|   |   +-- main-world-extractor.js     # MAIN world script (web accessible)
|   |   +-- main-world-fetcher.js       # MAIN world fetch helper (web accessible)
|   |   +-- main-world-translator.js    # MAIN world on-device Translator IIFE (web accessible)
|   +-- background/                     # Background service worker
|   |   +-- service-worker.js           # Entry point — message & streaming port router
|   |   +-- translator.js               # Translation orchestrator & completeness sweep
|   |   +-- translator-prompts.js       # Prompt builders, JSON/text parsers, sanitization
|   |   +-- translator-quality.js       # MergeFixer retranslation, LLM verify, debug batch log
|   |   +-- translator-failover.js      # Key grouping, cooldowns, retry loop, Groq waterfall
|   |   +-- providers.js                # Provider registry & API implementations
|   |   +-- api-manager.js              # API key manager + failover logic
|   |   +-- health.js                   # Provider health tracking + circuit breaker
|   |   +-- cache.js                    # Translation cache (chrome.storage.local)
|   |   +-- merge-fixer.js              # Detect & repair merged/misaligned translated lines
|   |   +-- rough-translator.js         # Inert worker seam (Privacy P0: zero network fallback)
|   +-- options/                        # Options page (full settings UI)
|   |   +-- options.html                # Options page shell
|   |   +-- options.css                 # Options page styles (dark theme)
|   |   +-- options.js                  # Options page logic + ARIA tab controller
|   |   +-- options-modal.js            # Shared accessible confirmation dialog
|   |   +-- tab-translation.js          # Translation tab state, failover toggles, cache clear
|   |   +-- translation-row.js          # API key row rendering, quota/health badges, Ollama
|   |   +-- tab-appearance.js           # Appearance tab (font, color, position, live preview)
|   |                                   # (About tab markup is inline in options.html — no separate module)
|   +-- popup/                          # Extension popup (quick actions)
|   |   +-- popup.html                  # Popup page (simplified)
|   |   +-- popup.css                   # Popup styles
|   |   +-- popup.js                    # Popup logic
|   +-- shared/                         # Shared between content/background/popup/options
|   |   +-- constants.js                # Shared constants (message types, defaults)
|   |   +-- i18n.js                     # chrome.i18n DOM localization helper
|   |   +-- providers-registry.js       # Provider/model definitions (shared data)
|   |   +-- logger.js                   # Structured JSONL logging
|   |   +-- trusted-types.js            # Trusted Types policy (safe innerHTML sinks)
|   |   +-- utils.js                    # Shared helpers (escapeHtml)
|   |   +-- libs/
|   |       +-- browser-polyfill.js     # Vendored webextension-polyfill (cross-browser)
|   +-- debug/                          # Advanced diagnostics panel (opened from the popup)
|       +-- debug.html                  # Log viewer UI
|       +-- debug.css                   # Log viewer styles
|       +-- debug.js                    # Log viewer logic
+-- _locales/                           # Extension UI localization catalogs (en, ja)
+-- assets/
|   +-- icons/                          # Extension icons (icon16/19/32/38/48/128/618.png)
|   +-- preview_bg.jpg                  # Options appearance live-preview backdrop
+-- tests/                              # Test files (Phase 21+)
|   +-- unit/
|   +-- integration/
+-- logs/                               # Debug log output (gitignored)
+-- CLAUDE.md                           # AI rules
+-- YOUSUB_PROJECT_SPEC.md              # Project specification (this file)
+-- YOUSUB_DESIGN_DECISIONS.md          # Design decisions record
+-- CHANGELOG.md                        # Change history
+-- DEFERRED.md                         # Deferred items
+-- ROADMAP.md                          # Development roadmap (active/pending phases)
+-- ROADMAP_DONE.md                     # Archived completed phases
+-- .gitignore
```

### 2.6 Content Script Module Pattern

Content scripts are **ES modules** (`import`/`export`), not IIFEs. The manifest
injects a single entry, `src/content/loader.js`, which dynamic-imports
`src/content/main.js`; `main.js` then statically imports the other modules. Each
module exports a named object and also registers itself on a `window.YouSub`
**compatibility shim** for legacy cross-module access:

```javascript
// src/content/<module>.js
import { devLog } from '../shared/constants.js';

export const SomeModule = {
  init() {
    /* ... */
  },
  destroy() {
    /* ... */
  },
};

// Compatibility shim for legacy global access
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.SomeModule = SomeModule;
}
```

`window.YouSub` is a **secondary** convenience layer; the primary wiring is the
ESM import graph rooted at `loader.js -> main.js`.

### 2.7 File Dependency Graph

```
manifest.json
  +-- content_scripts: [ src/content/loader.js ]   <- the ONLY injected content script
  |     loader.js  --(dynamic import)-->  src/content/main.js   <- ESM orchestrator
  |       +-- import src/shared/constants.js
  |       +-- import src/shared/trusted-types.js
  |       +-- import src/content/page-detector.js
  |       +-- import src/content/video-binder.js
  |       +-- import src/content/subtitle-extractor.js
  |       +-- import src/content/subtitle-parser.js
  |       +-- import src/content/rough-translate-bridge.js
  |       +-- import src/content/overlay.js
  |       +-- import src/content/sync-engine.js
  |     (each module also self-registers on the window.YouSub shim)
  |     web_accessible_resources exposes the modules above + main-world-*.js so
  |     loader.js can import() them and the page-context scripts can be injected.
  |
  +-- background.service_worker (ES modules, import/export):
  |     src/background/service-worker.js  <- Entry point (message + stream port router)
  |       +-- import src/background/providers.js     (API implementations)
  |       +-- import src/background/translator.js    (orchestrator & completeness sweep)
  |       |     +-- import src/background/translator-prompts.js   (prompts, parsers, sanitize)
  |       |     +-- import src/background/translator-quality.js   (MergeFixer verify, retranslate)
  |       |     +-- import src/background/translator-failover.js  (key rotation, cooldowns, Groq)
  |       |     +-- import src/background/merge-fixer.js / rough-translator.js
  |       +-- import src/background/api-manager.js   (key management + failover)
  |       +-- import src/background/health.js        (circuit breaker)
  |       +-- import src/background/cache.js         (translation cache)
  |
  +-- options_page:
  |     src/options/options.html
  |       +-- src/options/options.css
  |       +-- src/options/options.js           (ARIA tab controller + global settings)
  |       +-- src/options/tab-translation.js   (API keys, failover, cache management)
  |       |     +-- import src/options/translation-row.js (row UI, quota/health, Ollama)
  |       |     +-- import src/options/options-modal.js   (shared accessible dialog)
  |       +-- src/options/tab-appearance.js    (font, color, position, live preview)
  |       (About tab markup is inline in options.html — no separate module)
  |
  +-- action.default_popup:
        src/popup/popup.html
          +-- src/popup/popup.css
          +-- src/popup/popup.js   (also opens src/debug/debug.html)
```

---

## 3. Feature Specifications

### 3.1 Subtitle Extraction
**Summary**: Uses a MAIN-world injection strategy (`main-world-extractor.js`) to open and scrape YouTube's Transcript Panel DOM (EN + JA locale-resilient selectors), bypassing POT-token bot checks and CORS issues. Falls back to metadata caption track discovery, YouTube Innertube API (`POST /youtubei/v1/player` for Shorts), and XHR/background timedtext JSON3/XML parsing (`main-world-fetcher.js` + `SubtitleParser`). Derives conservative `sourceLang` (`deriveSourceLang`) for downstream verification.

### 3.2 Translation Engine & Quality Pipeline
**Summary**: A "Bring Your Own Key" (BYOK) multi-provider engine (`translator.js`, `providers.js`) supporting OpenAI, Gemini, Anthropic, Groq, DeepSeek, xAI, Mistral, OpenRouter, and local Ollama (`optional_host_permissions`). Features context-summary pre-analysis, JSON structured output / `[HH:MM:SS]` fallback parsing, SSE streaming mode, two-tier round-robin key-group + model rotation (`api-manager.js`, `translator-failover.js`), Groq payload-size waterfall splitting, health tracking with exponential circuit breaking (`health.js`), and a 150s idle watchdog + 3-round cooldown-aware completeness sweep (`_translateInternal`).

### 3.3 Post-Translation Verification (`MergeFixer` & On-Device `RoughTranslator`)
**Summary**: Detects line merges and cascade shifts via multi-signal weighted offline scoring (token anchors, terminal punctuation alignment, length ratio) plus foreign-script contamination and untranslated-line LLM verification (`translator-quality.js`). Back-translation verification runs opportunistically on-device via Chrome's MAIN-world `Translator` global (`main-world-translator.js` ← `rough-translate-bridge.js` ← SW delegate) with **zero third-party network egress** (Privacy P0 / Decisions 15–16).

### 3.4 Dynamic Overlay Controller & Sync Engine
**Summary**: Injected `#yousub-overlay` inside `#movie_player` (and Shorts active reel), styled with glassmorphism and dual CSS positioning modes (default centered bottom vs. custom draggable/resizable percentage coordinates saved per regular/Shorts layout). `SyncEngine` synchronizes translated + optional dual original text with `timeupdate`, preserving partial batches on incomplete runs and rendering Trusted Types–sanitized status toasts.

### 3.5 Cache, Diagnostics & Localization
**Summary**: LRU/TTL translation cache (`cache.js`, 30-day TTL, source-language-agnostic auto-start existence probe) stored in `chrome.storage.local`. Structured JSONL session logging (`logger.js` in `storage.session` + `ERROR` dual-write to `storage.local`), a popup-launched Batch Debugger (`src/debug/`), full EN/JA UI localization (`_locales/`, `i18n.js`), and cross-browser Chrome/Firefox/Edge compatibility via `webextension-polyfill`.

---

## 4. YouTube Platform Reference

### 4.1 YouTube DOM Structure

```
YouTube Player DOM structure (as of 2026):

document
  +-- ytd-app
       +-- #page-manager
            +-- ytd-watch-flexy
                 +-- #player-container
                      +-- #movie_player (.html5-video-player)
                           +-- .html5-video-container
                           |    +-- video.html5-main-video    <- THE VIDEO ELEMENT
                           +-- .ytp-chrome-bottom              <- player controls
                           +-- .ytp-caption-window-container   <- native captions

Key selectors:
  Video element:     document.querySelector('video.html5-main-video')
  Player container:  document.querySelector('#movie_player')
  Fullscreen check:  document.fullscreenElement !== null
```

### 4.2 YouTube Subtitle Data Formats

**Caption track entry** (from `ytInitialPlayerResponse`):
```javascript
// Location: ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[i]
{
  "baseUrl": "https://www.youtube.com/api/timedtext?v=VIDEO_ID&lang=en&...",
  "name": { "simpleText": "English" },
  "vssId": ".en",
  "languageCode": "en",
  "kind": "asr",              // "asr" = auto-generated, absent = manual
  "isTranslatable": true
}
```

**JSON3 format** (fetch `baseUrl + "&fmt=json3"`):
```json
{
  "wireMagic": "pb3",
  "events": [
    {
      "tStartMs": 1234,
      "dDurationMs": 5000,
      "segs": [
        { "utf8": "Hello " },
        { "utf8": "world", "tOffsetMs": 500 }
      ]
    }
  ]
}
```

**Normalized subtitle entry** (internal format):
```javascript
{
  startMs: 1234,       // start time in milliseconds
  endMs: 6234,         // startMs + dDurationMs
  text: "Hello world"  // concatenated segs[].utf8
}
```

### 4.3 YouTube SPA Navigation Events

```javascript
// Fired when a new page navigation completes
document.addEventListener('yt-navigate-finish', (event) => {
  if (window.location.pathname === '/watch') {
    // Start subtitle extraction for this video
  }
});

// Fired when navigation starts (useful for cleanup)
document.addEventListener('yt-navigate-start', (event) => {
  // Clean up previous video's state
});
```

**IMPORTANT**: `yt-navigate-finish` is the PRIMARY event for detecting video changes. Do NOT rely on `window.onload` or `DOMContentLoaded`.

---

## N. Development Roadmap

-> See [ROADMAP.md](ROADMAP.md) for active/pending phases.
-> See [ROADMAP_DONE.md](ROADMAP_DONE.md) for archived completed phases.

---

## Appendix A: Translation API Reference

### OpenAI-Compatible (OpenAI, Groq, DeepSeek, xAI, Mistral, OpenRouter)
```
POST {endpoint}/chat/completions
Headers: Authorization: Bearer {API_KEY}, Content-Type: application/json
Body: {
  "model": "{model_id}",
  "messages": [
    {"role": "system", "content": "You are a subtitle translator..."},
    {"role": "user", "content": "line1\nline2\nline3"}
  ],
  "max_tokens": 65000,
  "temperature": 0.3
}
Response: { "choices": [{ "message": { "content": "translated1\ntranslated2\ntranslated3" } }] }
```

### Google Gemini REST
```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}
Headers: Content-Type: application/json
Body: {
  "contents": [{ "parts": [{ "text": "Translate these subtitles..." }] }]
}
Response: { "candidates": [{ "content": { "parts": [{ "text": "translated text" }] } }] }
```

### Anthropic Messages API
```
POST https://api.anthropic.com/v1/messages
Headers: x-api-key: {API_KEY}, anthropic-version: 2023-06-01, Content-Type: application/json
Body: {
  "model": "{model_id}",
  "max_tokens": 65000,
  "messages": [{ "role": "user", "content": "Translate these subtitles..." }]
}
Response: { "content": [{ "text": "translated text" }] }
```

## Appendix B: Provider Quick Reference

| Provider | Free Tier | Speed | Quality | Best For |
|----------|-----------|-------|---------|----------|
| Groq | Yes (rate limited) | Very fast | Good | Development, fast translations |
| Google | $300 credit | Fast | Excellent | Production, multilingual |
| OpenAI | Pay-as-you-go | Fast | Excellent | General purpose |
| Anthropic | Pay-as-you-go | Medium | Excellent | Complex/nuanced text |
| DeepSeek | Very cheap | Fast | Good | Budget production |
| xAI | Pay-as-you-go | Fast | Good | Alternative to OpenAI |
| Mistral | Free tier | Fast | Good | European languages |
| OpenRouter | Varies | Varies | Varies | Access to many models |

## Appendix C: Manifest V3 Key Concepts

| Concept | Description |
|---------|-------------|
| Service Worker | Replaces background pages. No DOM access. Can be terminated when idle. |
| Content Scripts | Injected into web pages. Access DOM but run in isolated world. |
| Isolated World | Content scripts cannot access page's JS variables. |
| MAIN World | Page's own JS context. Accessible via `<script>` injection. |
| Message Passing | `chrome.runtime.sendMessage` for content <-> background communication. |
| `chrome.storage` | `local` for keys, settings, and translation cache; `session` for runtime logs. |
| Options Page | Full-page settings UI opened via right-click -> "Options" on extension icon. |

## Appendix D: Chrome DevTools Commands

```javascript
// Check YouSub namespace
window.YouSub

// Get current video element
document.querySelector('video.html5-main-video')

// Check subtitle overlay
document.getElementById('yousub-overlay')

// View YouSub logs
window.YouSub.Logger.tail(20)

// Export full logs
window.YouSub.Logger.export()

// Check extension storage
chrome.storage.sync.get(null, console.log)
chrome.storage.local.get(null, console.log)

// Check API key configuration
chrome.storage.local.get('yousub_api_keys', console.log)

// Check provider health (from background console)
// Navigate to: chrome://extensions -> YouSub -> "Inspect views: service worker"
self.YouSub_Health && self.YouSub_Health.getStats()
```

## Appendix E: Common Pitfalls

| Pitfall | Why It Happens | How to Avoid |
|---------|---------------|--------------|
| Content script can't read `ytInitialPlayerResponse` | Isolated world | Inject `<script>` into MAIN world |
| Extension breaks on YouTube navigation | SPA, `DOMContentLoaded` fires once | Use `yt-navigate-finish` event |
| Overlay blocks video clicks | Missing `pointer-events: none` | Always set on overlay container |
| Service worker stops responding | MV3 workers terminated when idle | Handle `chrome.runtime.lastError`, retry |
| Translation API CORS errors | Content scripts can't call cross-origin | ALL API calls from background worker |
| API key exposed in network tab | Keys sent in plain HTTP | Always use HTTPS endpoints (all providers do) |
| Circuit breaker never resets | No half-open state | Implement proper CLOSED -> OPEN -> HALF-OPEN cycle |
| Options page blank on first open | No API keys in storage yet | Show empty Primary row with clear instructions |

---

## Document Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-04-03 | Initial template |
| 1.1 | 2026-04-03 | Added core goals, features, and context based on user specification |
| 1.2 | 2026-04-04 | Updated with Cross-Browser support and Health Monitoring |
| 1.3 | 2026-04-04 | Final v0.1.0 - Premium UI, Automated Packaging, Documentation COMPLETE |
| 2.2 | 2026-04-25 | Version bump to v0.2.0 for Chrome Web Store update |
| 2.0 | 2026-04-06 | Major restructure: absorbed architecture reference and appendices from ROADMAP.md. Added detailed system diagram, data flow, folder structure, YouTube platform reference, file dependency graph, and all appendices. Updated to v0.2.0 status. |
| 2.1 | 2026-04-07 | Updated to v0.4.0. Implemented Global Absolute ID Tracking to eliminate alignment shifting. Added AI Raw Response streaming and interactive Logger utils (`tail`, `export`). |
