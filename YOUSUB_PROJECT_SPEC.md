# YouSub — Complete Project Specification

> **Document purpose**: This is the single source of truth for the YouSub project. It is written as an AI-readable prompt/specification so that any AI coding assistant (Gemini, Claude, etc.) can read this document and understand the full scope, architecture, decisions, and constraints of the project. It is also readable by human developers.
>
> **Document version**: 2.9
> **Last updated**: 2026-11-19
> **Status**: **Milestone 8 COMPLETE** — **v0.2.5 LIVE** on [Firefox Add-ons (AMO)](https://addons.mozilla.org/addon/yousub/) (`yousub@xinh.tools`, Desktop + Android); **v0.2.0 live / v0.2.5 Pending review** on [Chrome Web Store](https://chromewebstore.google.com/detail/yousub/jlpgmjpekhnlncfdkmddoienleiljehk) (`jlpgmjpekhnlncfdkmddoienleiljehk`; **743/743 tests**, 48 suites)
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
- **Secondary**: Firefox (Desktop + Firefox for Android >= 128.0 via `gecko_android`), Microsoft Edge, Brave
- **Distribution**: Local Unpacked Extension (development), Chrome Web Store (`jlpgmjpekhnlncfdkmddoienleiljehk`), Firefox Add-ons AMO (`yousub@xinh.tools`)

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
Step 6:  Declarative `world: "MAIN"` extractor reads open panel or queries silent Innertube (`/get_panel` → `/next` → `/get_transcript`), falling back to DOM scraping (auto-closing the panel) or timedtext/Gemini URL fallback
Step 7:  Isolated content script coalesces ASR fragments into semantic cues (`SubtitleCoalescer`) with strictly monotonic non-overlapping intervals
Step 8:  Opens `yousub-stream` port (`playheadMs` + live `SEEK_PRIORITY`) and checks versioned cache (`CACHE_SCHEMA_VERSION = 2`)
Step 9:  `translator.js` partitions into batches and prioritizes `[playheadBatch, lookahead, forward, backfill]` across key/model failover groups
Step 10: Prompting & parsing:
     - **JSON Structured Output**: Each batch encodes `{"lines": [{"n": 0, "t": "..."}]}` with JSON schema/object enforcement (`supportsJsonMode`) + `[HH:MM:SS]` fallback for non-JSON providers.
     - **JSON-Isolated Quality Repair**: `MergeFixer` validates misplaced tokens/untranslated lines without shifting JSON-indexed arrays.
Step 11: Cache clean translated results in `chrome.storage.local` keyed by `(videoId, sourceLang, targetLang)` with `version: CACHE_SCHEMA_VERSION`.
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
|   |   +-- subtitle-parser.js          # Parse timedtext JSON3/XML + SRT/VTT into normalized format
|   |   +-- subtitle-coalescer.js       # Semantic sentence coalescing for fragmented ASR cues (Phase 79b)
|   |   +-- rough-translate-bridge.js   # Content bridge to MAIN-world on-device Translator
|   |   +-- gemini-fallback-scheduler.js # Playback-driven 1-batch lookahead & seek scheduler (Phase 78)
|   |   +-- overlay.js                  # Overlay UI, drag/resize layout, status/SRT toast, stage pill
|   |   +-- sync-engine.js              # Synchronization: timeupdate -> subtitle lookup & dynamic batch merge
|   |   +-- overlay.css                 # Overlay styles
|   |   +-- main-world-extractor.js     # MAIN world extractor (manifest world: "MAIN", silent Innertube first)
|   |   +-- main-world-fetcher.js       # MAIN world XHR fetch helper (manifest world: "MAIN")
|   |   +-- main-world-translator.js    # MAIN world on-device Translator IIFE (manifest world: "MAIN")
|   |   +-- main-world-resume.js        # MAIN world YouTube watchtime guard & startSeconds bridge (manifest world: "MAIN")
|   |   +-- playback-resume.js          # Content auto-resume controller, standalone toast & bookmark/seek bridge
|   +-- background/                     # Background service worker
|   |   +-- service-worker.js           # Entry point — message & streaming port router
|   |   +-- translator.js               # Seek-aware translation orchestrator & completeness sweep
|   |   +-- translator-prompts.js       # Prompt builders, JSON/text parsers, sanitization
|   |   +-- translator-quality.js       # MergeFixer retranslation, LLM verify, debug batch log
|   |   +-- translator-failover.js      # Key grouping, cooldowns, retry loop, Groq waterfall
|   |   +-- video-transcriber.js        # Gemini YouTube URL multimodal transcription/translation (Phase 78)
|   |   +-- providers.js                # Provider registry & API implementations
|   |   +-- api-manager.js              # API key manager + failover logic
|   |   +-- health.js                   # Provider health tracking + circuit breaker + model resolution
|   |   +-- cache.js                    # Translation cache (chrome.storage.local + sl='gen' generated cache)
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
|   |   +-- tab-resume.js               # Playback Resume & Sync tab (auto-resume, sync, sleep guard, rewind, clear history)
|   |                                   # (About tab markup is inline in options.html — no separate module)
|   +-- popup/                          # Extension popup (quick actions)
|   |   +-- popup.html                  # Popup page (simplified + pipeline visualizer)
|   |   +-- popup.css                   # Popup styles (soft dark palette)
|   |   +-- popup.js                    # Popup logic
|   |   +-- pipeline-flow-view.js       # Sparrow-style SVG flow, stepper, batch timeline & horizon renderer
|   |   +-- popup-resume-view.js        # Playback Resume card, quick-jump pills, bookmarks & recent history view
|   +-- shared/                         # Shared between content/background/popup/options
|   |   +-- constants.js                # Shared constants (message types, defaults)
|   |   +-- i18n.js                     # chrome.i18n DOM localization helper
|   |   +-- providers-registry.js       # Provider/model definitions (shared data)
|   |   +-- pipeline-telemetry.js       # Unified cross-context pipeline state store (Phase 80a)
|   |   +-- logger.js                   # Structured JSONL logging
|   |   +-- trusted-types.js            # Trusted Types policy (safe innerHTML sinks)
|   |   +-- utils.js                    # Shared helpers (escapeHtml)
|   |   +-- playback-resume-store.js    # 3-tier LRU + sync-quota playback resume store & conflict resolver
|   |   +-- libs/
|   |       +-- browser-polyfill.js     # Vendored webextension-polyfill (cross-browser)
|   +-- debug/                          # Advanced diagnostics & interactive DAG panel (opened from popup)
|       +-- debug.html                  # Inspector UI
|       +-- debug.css                   # Inspector styles (soft dark palette)
|       +-- debug.js                    # Inspector logic & batch filter
+-- _locales/                           # Extension UI localization catalogs (en, ja)
+-- assets/
|   +-- icons/                          # Extension icons (icon16/19/32/38/48/128/618.png)
|   +-- preview_bg.jpg                  # Options appearance live-preview backdrop
+-- scripts/
|   +-- package.js                      # Zero-build-step Chrome & Firefox ZIP packager + manifest verifier
|   +-- publish.js                      # Automated CWS API v2 (Service Account/OAuth2) & AMO API v5 publisher
|   +-- amo-metadata.json               # AMO listing metadata, AGPL-3.0-only license & reviewer approval notes
|   +-- test-log.js                     # Structured Jest test & log writer (`logs/jest-latest.{log,json}`)
+-- .github/workflows/
|   +-- test.yml                        # CI quality gates (lint, format, test coverage, package)
|   +-- release.yml                     # Automated Store publish & artifact release workflow
+-- tests/                              # Test files (Phase 21+, 48 unit suites / 743 tests)
|   +-- unit/
|   +-- integration/
+-- logs/                               # Debug log output (gitignored)
+-- .env.example                        # Template for Chrome Web Store & Firefox AMO automation credentials
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
  +-- content_scripts (world: "MAIN", run_at: document_start):
  |     +-- src/content/main-world-extractor.js   (silent Innertube transcript + DOM fallback w/ auto-close)
  |     +-- src/content/main-world-fetcher.js     (credentialed XHR fetch bridge)
  |     +-- src/content/main-world-translator.js  (on-device Translator API bridge)
  |     +-- src/content/main-world-resume.js      (watchtime ping guard & startSeconds extractor)
  |
  +-- content_scripts (ISOLATED, run_at: document_idle): [ src/content/loader.js, src/content/overlay.css ]
  |     loader.js  --(dynamic import)-->  src/content/main.js   <- ESM orchestrator
  |       +-- import src/shared/constants.js
  |       +-- import src/shared/trusted-types.js
  |       +-- import src/shared/pipeline-telemetry.js
  |       +-- import src/content/page-detector.js
  |       +-- import src/content/video-binder.js
  |       +-- import src/content/subtitle-extractor.js
  |       +-- import src/content/subtitle-parser.js
  |       +-- import src/content/subtitle-coalescer.js
  |       +-- import src/content/rough-translate-bridge.js
  |       +-- import src/content/overlay.js
  |       +-- import src/content/sync-engine.js
  |       +-- import src/content/gemini-fallback-scheduler.js
  |     (each module also self-registers on the window.YouSub shim)
  |     web_accessible_resources exposes the 19 isolated ESM modules so loader.js can import() them.
  |
  +-- background.service_worker (ES modules, import/export):
  |     src/background/service-worker.js  <- Entry point (message + stream port router)
  |       +-- import src/background/providers.js     (API implementations)
  |       +-- import src/background/video-transcriber.js (Gemini YouTube URL fallback)
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
  |       +-- src/options/options.js           (ARIA tab controller + global settings + i18n)
  |       +-- src/options/tab-translation.js   (API keys, failover, cache management)
  |       |     +-- import src/options/translation-row.js (row UI, quota/health, Ollama)
  |       |     +-- import src/options/options-modal.js   (shared accessible dialog)
  |       +-- src/options/tab-appearance.js    (font, color, position, stage pill toggle, live preview)
  |       +-- src/options/tab-resume.js        (playback resume toggles, rewind/min-duration, clear history)
  |       (About tab markup is inline in options.html — no separate module)
  |
  +-- action.default_popup / diagnostics:
        src/popup/popup.html
          +-- src/popup/popup.css
          +-- src/popup/popup.js               (uses pipeline-flow-view.js, popup-resume-view.js, i18n.js; opens src/debug/debug.html)
        src/debug/debug.html
          +-- src/debug/debug.css / debug.js   (interactive Sparrow DAG + batch filter)
```

---

## 3. Feature Specifications

### 3.1 Subtitle Extraction & No-Transcript Fallbacks
**Summary**: Uses declarative `"world": "MAIN"` helpers in `manifest.json` (`main-world-extractor.js` at `document_start`) to reuse already-open user panels untouched, extract transcripts silently via Innertube (`/youtubei/v1/get_panel` `PAmodern_transcript_view`, `/youtubei/v1/next`, and `/youtubei/v1/get_transcript`) before touching DOM UI, and auto-close the engagement panel (`#visibility-button button`) + `#collapse` in `finally` whenever `"Show transcript"` DOM fallback runs. Supports ViewModel `startMs`/`endMs` and structured `timestamp` objects cleanly, rejects collapsed/minimized stale panels, and cascades to timedtext JSON3/XML (`main-world-fetcher.js` + `SubtitleParser`). When neither transcripts nor caption tracks exist, offers (1) playback-driven 240s windowed Gemini YouTube URL transcription/translation (`video-transcriber.js` + `gemini-fallback-scheduler.js`, 1-batch lookahead & seek-jump abort) for public VODs when a Google Gemini key is active, and (2) direct `.srt`/`.vtt` file import (button + drag-and-drop) inside the status toast (`SubtitleParser.parseSubtitleFile`). Derives conservative `sourceLang` (`deriveSourceLang`) for downstream verification and coalesces raw cues via `SubtitleCoalescer` with monotonic non-overlapping interval normalization (`normalizeCueIntervals`).

### 3.2 Translation Engine & Quality Pipeline
**Summary**: A "Bring Your Own Key" (BYOK) multi-provider engine (`translator.js`, `providers.js`) supporting OpenAI, Gemini, Anthropic, Groq, DeepSeek, xAI, Mistral, OpenRouter, and local Ollama (`optional_host_permissions`). Features context-summary pre-analysis, JSON structured output (normalizing `'auto'` keys, numeric strings, and 1-based `"n"` indices) / `[HH:MM:SS]` fallback parsing, SSE streaming mode, two-tier round-robin key-group + model rotation (`api-manager.js`, `translator-failover.js`), Groq payload-size waterfall splitting, health tracking with exponential circuit breaking (`health.js`), Seek-Aware Batch Priority (`SEEK_PRIORITY`), tab/video/session-isolated dedup (`dedupKey` + `pipelineSessionGen`), and a 150s idle watchdog + 3-round cooldown-aware completeness sweep (`_translateInternal`).

### 3.3 Post-Translation Verification (`MergeFixer` & On-Device `RoughTranslator`)
**Summary**: Detects line merges and cascade shifts via multi-signal weighted offline scoring (token anchors, terminal punctuation alignment, length ratio) plus foreign-script contamination and untranslated-line LLM verification (`translator-quality.js`). In JSON indexed mode (`_isIndexedJson`), skips `buildRealignment()` slot-shifting and fail-open `proportionalSplit()` on non-empty lines while guarding natural short source-matched cues and identical consecutive cues in `detectTailAnomalies`. Back-translation verification runs opportunistically on-device via Chrome's declarative MAIN-world `Translator` global (`main-world-translator.js` ← `rough-translate-bridge.js` ← SW delegate) with **zero third-party network egress** (Privacy P0 / Decisions 15–16, 22).

### 3.4 Dynamic Overlay Controller & Sync Engine
**Summary**: Injected `#yousub-overlay` inside `#movie_player` (and Shorts active reel), styled with glassmorphism, CSS auto-fit width (`width: fit-content`), bottom-anchored custom positioning `(centerXPct, bottomPct, maxWidthPct)` for upward-only vertical growth, live `.ytp-chrome-bottom` bar-clearance dodge across normal/Theater/Fullscreen modes, and a compact auto-hiding `#yousub-stage-pill` (togglable via `yousub_appearance.showStagePill`). `SyncEngine` synchronizes translated + optional dual original text with `timeupdate`, preserving partial batches on incomplete runs and rendering Trusted Types–sanitized status toasts.

### 3.5 Cache, Diagnostics & Localization
**Summary**: Versioned LRU/TTL translation cache (`cache.js`, `CACHE_SCHEMA_VERSION = 2`, 30-day TTL, source-language-agnostic auto-start existence probe, plus `sl='gen'` incremental Gemini cache) stored in `chrome.storage.local`. Unified cross-context `PipelineTelemetry` (`storage.session` + `storage.local` with monotonic stage guards), Sparrow-style SVG DAG visualizer (`pipeline-flow-view.js`), structured JSONL session logging (`logger.js` + `YOUSUB_LOG_BATCH` content-to-SW relay when `storage.session` is unavailable), popup-launched Batch Debugger (`src/debug/`), full EN/JA UI localization (`_locales/`, `i18n.js`), and cross-browser Chrome/Firefox/Edge/Firefox-Android compatibility via `webextension-polyfill`.

### 3.6 Playback Auto-Resume & Firefox Mobile Support
**Summary**: Cross-platform (`www.youtube.com` + `m.youtube.com`, Chrome Desktop, Firefox Desktop, Firefox for Android >= 128.0) audio/long-video auto-resume completely decoupled from subtitle translation (`PlaybackResume` + `PlaybackResumeStore` + declarative MAIN-world `main-world-resume.js`, Decision 23). Combines a 3-tier store (`storage.local` 500 LRU + `storage.sync` compact <= 40 LRU / <= 7500 UTF-8 bytes + first-party YouTube account `startSeconds` & hardened `/api/stats/watchtime` sync) with zero-overwrite protection, sleep-protection (`>=95%` reset guard on videos `>=600s`), 4-timestamp recovery (`lastTimeSec`, `furthestTimeSec`, `lastInteractionTimeSec`, rolling 30m `checkpoints`, manual `bookmarks`), standalone resume toast + popup quick-jump/history UI (`popup-resume-view.js`), and Options Playback settings tab (`tab-resume.js`).

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
| MAIN World | Page's own JS context. Declared via `content_scripts[].world: "MAIN"` in `manifest.json`. |
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
| Content script can't read `ytInitialPlayerResponse` | Isolated world | Declare helper script in `content_scripts` with `"world": "MAIN"` |
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
| 2.7 | 2026-11-18 | Synced to local `v0.2.5` + Phases 78–80 + post-80 stabilization hotfixes: declarative `world: "MAIN"` + silent Innertube transcript, `SubtitleCoalescer` monotonic interval normalization, Seek-Aware priority, Sparrow telemetry, overlay auto-fit/bar-dodge, JSON-mode `MergeFixer` isolation & `CACHE_SCHEMA_VERSION = 2`. |
| 2.8 | 2026-11-18 | Completed Milestone 8 (Phases 81–85, Decision 23): added Firefox for Android (`gecko_android >= 128.0`, `m.youtube.com` SPA & mobile UI compat), 3-tier Playback Resume Store & conflict resolution, MAIN-world watchtime guard & `startSeconds` bridge, independent `PlaybackResume` controller & SW log relay, and Popup/Options Playback Resume UI (`popup-resume-view.js`, `tab-resume.js`). |
| 2.9 | 2026-11-19 | Added Post-85 dark-theme UI polish, Store release automation (`scripts/publish.js`, `scripts/amo-metadata.json`, `.github/workflows/release.yml`, `.env.example`, `tests/unit/publish.test.js`), Privacy Gist sync, **Firefox AMO `v0.2.5` live approval** (`https://addons.mozilla.org/addon/yousub/`), and Chrome Web Store `v0.2.5` resubmission (`Pending review` after `Yellow Argon` `en`+`ja` listing description fix). |
