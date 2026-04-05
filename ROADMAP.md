# YouSub — Development Roadmap

> **Source**: YOUSUB_PROJECT_SPEC.md Section N (Development Roadmap)
> **Hub**: [YOUSUB_PROJECT_SPEC.md](YOUSUB_PROJECT_SPEC.md)
> **Version**: 3.2
> **Last updated**: 2026-04-06
> **Total phases**: 30 (Phases 0–23 = archived, Phase 23.5+ = active/pending)

---

## INSTRUCTIONS FOR AI ASSISTANT — READ THIS ENTIRE SECTION BEFORE EVERY SESSION

### How to Use This Document

This file is the **single source of truth** for all development work on YouSub. Before doing ANY work, you MUST:

1. Read `CLAUDE.md` — contains hard rules for your behavior
2. Read this file (`ROADMAP.md`) — contains what to do next
3. Read `ROADMAP_DONE.md` — contains what has already been completed
4. Read `YOUSUB_DESIGN_DECISIONS.md` — contains past decisions (do NOT re-propose rejected approaches)

### Phase Execution Protocol — STRICTLY ENFORCED

```
ONE PROMPT = ONE PHASE. NO EXCEPTIONS.
```

**Rules**:
1. **Never execute more than one phase in a single prompt.** If you finish Phase N, STOP. Do NOT start Phase N+1.
2. **After finishing a phase**: run tests, verify everything works, report results, then propose the next phase.
3. **If a phase has problems**: stay on that phase. Fix the problems before proposing the next phase.
4. **If a phase is too large**: split it into sub-phases (e.g., Phase 5a, Phase 5b). Each sub-phase = one prompt.
5. **Always wait for developer confirmation** before starting the next phase.

### After Each Phase — Mandatory Checklist

After completing any phase, you MUST do ALL of the following:

- [ ] Run all tests and verify they pass
- [ ] Update `ROADMAP.md` — change the phase status to `DONE (YYYY-MM-DD)`
- [ ] Update `CHANGELOG.md` — add entry under `## [Unreleased]`
- [ ] Update `YOUSUB_DESIGN_DECISIONS.md` — if any decisions were made
- [ ] Check if the completed phase should be archived to `ROADMAP_DONE.md`
- [ ] Report to developer: what was done, test results, any issues found
- [ ] Propose the next phase and wait for confirmation

### Prompt Pattern for Developer

To start a phase, the developer will say something like:
```
Execute Phase N: [Phase Title]
```
When you receive this, follow the CLAUDE.md workflow: Present -> Discuss -> Choose -> Plan -> Code.

---

## BUILD ORDER — QUICK REFERENCE

| 0-23 | CORE INFRASTRUCTURE, ROBUSTNESS, QUALITY & DISTRIBUTION | ARCHIVED | M1-M5 |
| 23.5 | Translation Engine Stabilization (Structural Consistency) | **CURRENT FOCUS** | M5 |

> **Status format**: `DONE (YYYY-MM-DD)` · `IN PROGRESS` · `BLOCKED (reason)` · empty = not started

---

## ARCHITECTURE REFERENCE

### System Diagram

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

### Data Flow (Full Pipeline)

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
Step 10: Send text array to background worker via chrome.runtime.sendMessage
Step 11: Background worker loads API config from chrome.storage
Step 12: Background worker calls Primary provider API with translation prompt
Step 13: If Primary fails → try Backup 1 → Backup 2 → Backup 3 (failover chain)
Step 14: Provider health updated (success/failure tracking)
Step 15: Translated array sent back to content script
Step 16: Content script builds: [{ startMs, endMs, original, translated }, ...]
Step 17: Sync engine: video.ontimeupdate → binary search → update overlay
```

### API Key Data Flow

```
Options Page (UI)                chrome.storage.local              Background Worker
+------------------+            +-------------------+            +------------------+
| Provider: [Groq] |  save =>   | yousub_api_keys:  |  load =>   | APIManager       |
| Model: [llama-3] |            |  [{provider,model |            |  .translate()    |
| Key: [gsk_xxx]   |            |    ,key,status}]  |            |  .testKey()      |
| [Test] [Show]    |            +-------------------+            |  .getHealth()    |
+------------------+                                             +------------------+
```

### Technology Decisions (Pre-Made — Do NOT Change)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Manifest version | V3 | Current standard, required for Chrome Web Store |
| Language | Vanilla JS (ES2020+) | Lightweight, no build step needed |
| Framework | None | Project scope doesn't justify framework overhead |
| State management | chrome.storage API | Native extension API, syncs across devices |
| Build system | None | Plain files loaded by manifest.json, no bundler |
| Module pattern | IIFE + shared namespace `window.YouSub` | Works in content script isolated world without build tools |
| Background worker modules | ES modules (`"type": "module"`) | Supported natively in MV3 service workers |
| Translation engine | Multi-provider LLM (user's own API key) | Professional quality, user controls cost and provider |
| API key storage | `chrome.storage.local` (no encryption) | Chrome extension storage is sandboxed per-extension |
| Settings UI | Chrome Options Page (`options_page`) | Full-page UI with tabs, not constrained by popup size |

### Folder Structure (Target)

```
YouSub/
+-- manifest.json                       # Extension manifest (Manifest V3)
+-- src/
|   +-- content/                        # Content scripts (injected into YouTube pages)
|   |   +-- main.js                     # Entry point — orchestrates all content modules
|   |   +-- page-detector.js            # YouTube page detection + SPA navigation
|   |   +-- video-binder.js             # Find and monitor <video> element
|   |   +-- subtitle-extractor.js       # Extract subtitle tracks from page data
|   |   +-- subtitle-parser.js          # Parse timedtext JSON3/XML into normalized format
|   |   +-- overlay.js                  # Overlay UI creation, update, destroy
|   |   +-- sync-engine.js              # Synchronization: timeupdate -> subtitle lookup
|   |   +-- toast.js                    # Toast notification component
|   |   +-- overlay.css                 # Overlay styles
|   |   +-- main-world-extractor.js     # MAIN world script (web accessible)
|   |   +-- main-world-fetcher.js       # MAIN world fetch helper (web accessible)
|   +-- background/                     # Background service worker
|   |   +-- service-worker.js           # Entry point — message handler
|   |   +-- translator.js              # Multi-provider translation engine
|   |   +-- providers.js               # Provider registry & API implementations
|   |   +-- api-manager.js             # API key manager + failover logic
|   |   +-- health.js                  # Provider health tracking + circuit breaker
|   |   +-- cache.js                    # Translation cache (chrome.storage.local)
|   +-- options/                        # Options page (full settings UI)
|   |   +-- options.html                # Options page shell
|   |   +-- options.css                 # Options page styles (dark theme)
|   |   +-- options.js                  # Options page logic + tab controller
|   |   +-- tab-translation.js          # Translation tab (API keys, language)
|   |   +-- tab-appearance.js           # Appearance tab (font, color, position)
|   |   +-- tab-about.js               # About tab (version, links)
|   +-- popup/                          # Extension popup (quick actions)
|   |   +-- popup.html                  # Popup page (simplified)
|   |   +-- popup.css                 # Popup styles
|   |   +-- popup.js                    # Popup logic
|   +-- shared/                         # Shared between content/background/popup/options
|       +-- constants.js                # Shared constants (message types, defaults)
|       +-- providers-registry.js       # Provider/model definitions (shared data)
|       +-- logger.js                   # Structured JSONL logging
+-- assets/
|   +-- icons/                          # Extension icons
|   |   +-- icon16.png
|   |   +-- icon48.png
|   |   +-- icon128.png
|   +-- options/                        # Options page assets
|       +-- logo.svg                    # YouSub logo for settings page
+-- tests/                              # Test files (Phase 21+)
|   +-- unit/
|   +-- integration/
+-- logs/                               # Debug log output (gitignored)
+-- CLAUDE.md                           # AI rules
+-- YOUSUB_PROJECT_SPEC.md              # Project specification
+-- YOUSUB_DESIGN_DECISIONS.md          # Design decisions record
+-- CHANGELOG.md                        # Change history
+-- DEFERRED.md                         # Deferred items
+-- ROADMAP.md                          # This file — development roadmap
+-- ROADMAP_DONE.md                     # Archived completed phases
+-- .gitignore
```

### YouTube DOM Reference

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

### YouTube Subtitle Data Formats

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

### YouTube SPA Navigation Events

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

### Content Script Module Pattern

All content scripts use this pattern to share state via `window.YouSub`:

```javascript
(function () {
  'use strict';
  const YouSub = window.YouSub || (window.YouSub = {});

  YouSub.SomeModule = {
    init: function () { /* ... */ },
    destroy: function () { /* ... */ }
  };
})();
```

---

## DETAILED PHASE SPECIFICATIONS

---

### Phase 23.5: Translation Engine Stabilization (Structural Consistency)

**Goal**: Resolve the "Prose-ification" issue where LLMs merge subtitle lines into paragraphs, and prevent cache poisoning from failed translations.

**Status**: IN PROGRESS

**Deliverables**:
- [x] Rigorous Debug Logging (Background -> Content Console)
- [x] Numbered Envelope Strategy (N\| Translation)
- [x] Batch Size Reduction (40 -> 20 lines)
- [x] Cache Poisoning Fix — `hadFallback` metadata flow (2026-04-06)
- [ ] Adaptive Parser (Handle hallucinated numbers or omitted pipes)
- [ ] Minimal Chunking Fallback (If 20 fails, try 5 or 1)

**Definition of Done**:
- [ ] 100% success rate on 100+ line subtitle files with Groq/Llama models.
- [ ] Zero "Line Count Mismatch" fallbacks on standard YouTube videos.

---

## APPENDIX

### A. Translation API Reference (Quick Reference)

#### OpenAI-Compatible (OpenAI, Groq, DeepSeek, xAI, Mistral, OpenRouter)
```
POST {endpoint}/chat/completions
Headers: Authorization: Bearer {API_KEY}, Content-Type: application/json
Body: {
  "model": "{model_id}",
  "messages": [
    {"role": "system", "content": "You are a subtitle translator..."},
    {"role": "user", "content": "line1\nline2\nline3"}
  ],
  "max_tokens": 2000,
  "temperature": 0.3
}
Response: { "choices": [{ "message": { "content": "translated1\ntranslated2\ntranslated3" } }] }
```

#### Google Gemini REST
```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}
Headers: Content-Type: application/json
Body: {
  "contents": [{ "parts": [{ "text": "Translate these subtitles..." }] }]
}
Response: { "candidates": [{ "content": { "parts": [{ "text": "translated text" }] } }] }
```

#### Anthropic Messages API
```
POST https://api.anthropic.com/v1/messages
Headers: x-api-key: {API_KEY}, anthropic-version: 2023-06-01, Content-Type: application/json
Body: {
  "model": "{model_id}",
  "max_tokens": 2000,
  "messages": [{ "role": "user", "content": "Translate these subtitles..." }]
}
Response: { "content": [{ "text": "translated text" }] }
```

### B. Provider Quick Reference

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

### C. Manifest V3 Key Concepts

| Concept | Description |
|---------|-------------|
| Service Worker | Replaces background pages. No DOM access. Can be terminated when idle. |
| Content Scripts | Injected into web pages. Access DOM but run in isolated world. |
| Isolated World | Content scripts cannot access page's JS variables. |
| MAIN World | Page's own JS context. Accessible via `<script>` injection. |
| Message Passing | `chrome.runtime.sendMessage` for content <-> background communication. |
| chrome.storage | `sync` for settings (syncs across devices), `local` for larger data. |
| Options Page | Full-page settings UI opened via right-click -> "Options" on extension icon. |

### D. Useful Chrome DevTools Commands

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

### E. File Dependency Graph

```
manifest.json
  +-- content_scripts (loaded in order, all share window.YouSub namespace):
  |     src/shared/constants.js          <- Loaded first: defines namespace, constants
  |     src/shared/providers-registry.js <- Provider/model definitions (shared data)
  |     src/content/page-detector.js
  |     src/content/video-binder.js
  |     src/content/subtitle-extractor.js
  |     src/content/subtitle-parser.js
  |     src/content/overlay.js
  |     src/content/toast.js
  |     src/content/sync-engine.js
  |     src/content/main.js              <- Loaded last: orchestrates everything
  |
  +-- background.service_worker (ES modules, import/export):
  |     src/background/service-worker.js  <- Entry point
  |       +-- import src/background/providers.js    (API implementations)
  |       +-- import src/background/translator.js   (translation engine)
  |       +-- import src/background/api-manager.js  (key management + failover)
  |       +-- import src/background/health.js       (circuit breaker)
  |       +-- import src/background/cache.js        (translation cache)
  |
  +-- options_page:
  |     src/options/options.html
  |       +-- src/options/options.css
  |       +-- src/options/options.js           (tab controller)
  |       +-- src/options/tab-translation.js   (API keys, language)
  |       +-- src/options/tab-appearance.js    (font, color, position)
  |       +-- src/options/tab-about.js         (version, links)
  |
  +-- action.default_popup:
        src/popup/popup.html
          +-- src/popup/popup.css
          +-- src/popup/popup.js
```

### F. Common Pitfalls and How to Avoid Them

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

> **Status format**: `DONE (YYYY-MM-DD)` · `IN PROGRESS` · `BLOCKED (reason)` · empty = not started
>
> **Milestone key**: M1 = MVP, M2 = Features, M3 = Robustness, M4 = Quality, M5 = Distribution
