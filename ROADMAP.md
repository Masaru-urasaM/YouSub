# YouSub — Development Roadmap

> **Source**: YOUSUB_PROJECT_SPEC.md Section N (Development Roadmap)
> **Hub**: [YOUSUB_PROJECT_SPEC.md](YOUSUB_PROJECT_SPEC.md)
> **Version**: 2.0
> **Last updated**: 2026-04-03
> **Total phases**: 23 (Phase 0 = done, Phases 1–23 = pending)

---

## INSTRUCTIONS FOR AI ASSISTANT — READ THIS ENTIRE SECTION BEFORE EVERY SESSION

### How to Use This Document

This file is the **single source of truth** for all development work on YouSub. Before doing ANY work, you MUST:

1. Read `GEMINI.md` — contains hard rules for your behavior
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
When you receive this, follow the GEMINI.md workflow: Present → Discuss → Choose → Plan → Code.

---

## BUILD ORDER — QUICK REFERENCE

| Phase | Component | Status | Milestone |
|-------|-----------|--------|-----------|
| 0 | Project scaffold + documentation | DONE (2026-04-03) | Setup |
| 1 | Extension foundation — Manifest V3 + folder structure | DONE (2026-04-03) | M1: MVP |
| 2 | Design decisions — finalize technical approach | DONE (2026-04-03) | M1: MVP |
| 3 | Content script — YouTube page detection + SPA navigation | DONE (2026-04-03) | M1: MVP |
| 4 | Video player detection + binding | DONE (2026-04-03) | M1: MVP |
| 5 | Subtitle track discovery — extract available tracks | DONE (2026-04-03) | M1: MVP |
| 6 | Subtitle fetching + parsing — download and parse timedtext | DONE (2026-04-03) | M1: MVP |
| 7 | Translation API client — setup and configuration | DONE (2026-04-03) | M1: MVP |
| 8 | Overlay UI foundation — inject and style subtitle container | | M1: MVP |
| 9 | Synchronization engine — timestamp-based subtitle display | | M1: MVP |
| 10 | MVP integration — wire all components + end-to-end test | | M1: MVP |
| 11 | Background service worker — message passing architecture | | M2: Features |
| 12 | Popup UI — language selection + basic settings | DONE (2026-04-03) | M2: Features |
| 13 | Settings persistence — chrome.storage integration | | M2: Features |
| 13.5 | Custom LLM Translation Integration — Bring Your Own Key | | M2: Features |
| 14 | Dual subtitle display — original + translated | | M2: Features |
| 15 | UI customization — font, color, position, opacity | | M2: Features |
| 16 | Structured debug logging — JSONL logger module | | M2: Features |
| 17 | Error handling + user feedback — graceful degradation | | M3: Robustness |
| 18 | Edge cases — subtitle varieties + video scenarios | | M3: Robustness |
| 19 | Translation caching — local cache for performance | | M3: Robustness |
| 20 | Performance optimization — DOM, memory, CPU | | M3: Robustness |
| 21 | Test infrastructure + unit tests — Jest setup + core tests | | M4: Quality |
| 22 | Cross-browser compatibility — Firefox + Edge | | M5: Distribution |
| 23 | Visual polish + packaging — icons, animations, store prep | | M5: Distribution |

> **Status format**: `DONE (YYYY-MM-DD)` · `IN PROGRESS` · `BLOCKED (reason)` · empty = not started

---

## ARCHITECTURE REFERENCE

### System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    YouSub Browser Extension                      │
│                                                                  │
│  ┌─────────────────────┐         ┌──────────────────────────┐   │
│  │   Popup (UI)        │         │  Background Worker       │   │
│  │  ┌───────────────┐  │         │  ┌────────────────────┐  │   │
│  │  │ Language Select│  │         │  │ Translation API    │  │   │
│  │  │ Settings Panel │  │  chrome │  │ Client             │  │   │
│  │  │ Toggle On/Off  │  │ .runtime│  │                    │  │   │
│  │  └───────────────┘  │ .message│  │ ┌────────────────┐ │  │   │
│  │         │            │◄───────►│  │ │ Translation    │ │  │   │
│  │         │ chrome     │         │  │ │ Cache          │ │  │   │
│  │         │ .storage   │         │  │ └────────────────┘ │  │   │
│  │         ▼            │         │  └────────────────────┘  │   │
│  └─────────────────────┘         └──────────────────────────┘   │
│                                           ▲                      │
│                                           │ chrome.runtime       │
│                                           │ .sendMessage         │
│                                           ▼                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                Content Script (YouTube page)              │   │
│  │                                                           │   │
│  │  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌───────────┐  │   │
│  │  │  Page     │  │ Subtitle │  │Subtitle│  │  Overlay  │  │   │
│  │  │ Detector  │→ │ Extractor│→ │ Parser │  │ Controller│  │   │
│  │  │(SPA nav)  │  │(tracks)  │  │(JSON3) │  │  (UI)     │  │   │
│  │  └──────────┘  └──────────┘  └────────┘  └───────────┘  │   │
│  │                                    │             ▲        │   │
│  │                                    ▼             │        │   │
│  │                              ┌───────────┐       │        │   │
│  │                              │   Sync     │───────┘        │   │
│  │                              │  Engine    │               │   │
│  │                              │(timeupdate)│               │   │
│  │                              └───────────┘               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          │                                       │
│                          ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              YouTube Video Player DOM                     │   │
│  │  #movie_player > .html5-video-container > video           │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### Data Flow (MVP)

```
Step 1: User navigates to youtube.com/watch?v=VIDEO_ID
Step 2: Content script detects watch page (URL check + yt-navigate-finish event)
Step 3: Content script finds <video> element via DOM query + MutationObserver
Step 4: Content script injects <script> to read ytInitialPlayerResponse from MAIN world
Step 5: ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
         → array of { baseUrl, name, languageCode, kind }
Step 6: Fetch baseUrl + "&fmt=json3" → JSON response with events[].tStartMs, dDurationMs, segs[].utf8
Step 7: Parse into normalized array: [{ startMs, endMs, text }, ...]
Step 8: Send text array to background worker via chrome.runtime.sendMessage
Step 9: Background worker calls translation API → receives translated text array
Step 10: Background worker sends translated array back to content script
Step 11: Content script builds translated subtitle array: [{ startMs, endMs, original, translated }, ...]
Step 12: Sync engine listens to video.ontimeupdate → binary search for current subtitle → update overlay
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

### Folder Structure (Target)

```
YouSub/
├── manifest.json                       # Extension manifest (Manifest V3)
├── src/
│   ├── content/                        # Content scripts (injected into YouTube pages)
│   │   ├── main.js                     # Entry point — orchestrates all content modules
│   │   ├── page-detector.js            # YouTube page detection + SPA navigation
│   │   ├── video-binder.js             # Find and monitor <video> element
│   │   ├── subtitle-extractor.js       # Extract subtitle tracks from page data
│   │   ├── subtitle-parser.js          # Parse timedtext JSON3/XML into normalized format
│   │   ├── overlay.js                  # Overlay UI creation, update, destroy
│   │   ├── sync-engine.js              # Synchronization: timeupdate → subtitle lookup → overlay update
│   │   ├── logger.js                   # Structured JSONL logging
│   │   └── overlay.css                 # Overlay styles
│   ├── background/                     # Background service worker
│   │   ├── service-worker.js           # Entry point — message handler
│   │   ├── translator.js               # Translation API client
│   │   └── cache.js                    # Translation cache (chrome.storage.local)
│   ├── popup/                          # Extension popup UI
│   │   ├── popup.html                  # Popup page
│   │   ├── popup.css                   # Popup styles
│   │   └── popup.js                    # Popup logic
│   └── shared/                         # Shared between content/background/popup
│       ├── constants.js                # Shared constants (message types, defaults)
│       └── messages.js                 # Message type definitions
├── assets/
│   └── icons/                          # Extension icons
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── tests/                              # Test files (Phase 21+)
│   ├── unit/
│   └── integration/
├── logs/                               # Debug log output (gitignored)
├── GEMINI.md                           # AI rules
├── YOUSUB_PROJECT_SPEC.md              # Project specification
├── YOUSUB_DESIGN_DECISIONS.md          # Design decisions record
├── CHANGELOG.md                        # Change history
├── DEFERRED.md                         # Deferred items
├── PROMPT.md                           # Task prompt template
├── ROADMAP.md                          # This file — development roadmap
├── ROADMAP_DONE.md                     # Archived completed phases
└── .gitignore
```

### YouTube DOM Reference

```
YouTube Player DOM structure (as of 2026):

document
  └── ytd-app
       └── #page-manager
            └── ytd-watch-flexy
                 └── #player-container
                      └── #movie_player (.html5-video-player)
                           ├── .html5-video-container
                           │    └── video.html5-main-video    ← THE VIDEO ELEMENT
                           ├── .ytp-chrome-bottom              ← player controls
                           └── .ytp-caption-window-container   ← native captions

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
  "name": { "simpleText": "English" },          // or "runs": [{ "text": "English" }]
  "vssId": ".en",                                // language identifier
  "languageCode": "en",                          // ISO 639-1 language code
  "kind": "asr",                                 // "asr" = auto-generated, absent = manual
  "isTranslatable": true                         // whether translation tracks are available
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
    },
    {
      "tStartMs": 7000,
      "dDurationMs": 3000,
      "segs": [
        { "utf8": "Another line" }
      ]
    }
  ]
}
```

**XML format** (default, no `&fmt` parameter):
```xml
<?xml version="1.0" encoding="utf-8"?>
<transcript>
  <text start="1.234" dur="5.0">Hello world</text>
  <text start="7.0" dur="3.0">Another line</text>
</transcript>
```

**Normalized subtitle entry** (our internal format):
```javascript
{
  startMs: 1234,       // start time in milliseconds
  endMs: 6234,         // startMs + dDurationMs
  text: "Hello world"  // concatenated segs[].utf8
}
```

### YouTube SPA Navigation Events

YouTube is a Single Page Application. It does NOT do full page reloads when navigating between videos. You MUST handle these events:

```javascript
// Fired when a new page navigation completes (video change, channel page, etc.)
document.addEventListener('yt-navigate-finish', (event) => {
  // Check if we're on a watch page
  if (window.location.pathname === '/watch') {
    // Start subtitle extraction for this video
  }
});

// Fired when navigation starts (useful for cleanup)
document.addEventListener('yt-navigate-start', (event) => {
  // Clean up previous video's state (overlay, subtitles, etc.)
});
```

**IMPORTANT**: `yt-navigate-finish` is the PRIMARY event for detecting video changes. Do NOT rely on `window.onload` or `DOMContentLoaded` — they only fire on the initial page load, not on SPA navigation.

### Content Script Module Pattern

All content scripts use this pattern to share state via `window.YouSub`:

```javascript
// Example: src/content/some-module.js
(function () {
  'use strict';

  // Initialize shared namespace
  const YouSub = window.YouSub || (window.YouSub = {});

  // Module code here
  YouSub.SomeModule = {
    init: function () { /* ... */ },
    destroy: function () { /* ... */ }
  };
})();
```

The `main.js` file (loaded LAST in the manifest) orchestrates all modules:

```javascript
(function () {
  'use strict';
  const YS = window.YouSub;

  // Initialize modules in order
  YS.Logger.init();
  YS.PageDetector.init();
  // ... etc.
})();
```

---

## DETAILED PHASE SPECIFICATIONS

---





---


---

---

---

### Phase 7: Translation API Client — Setup and Configuration

**Goal**: Create the `translator.js` module in the background worker that provides a clean interface for translating text using the chosen translation API (from Phase 2, Decision 2).

**Prerequisites**: Phase 6 complete. Phase 2 Decision 2 resolved.

**Files to create/modify**:
| File | Action |
|------|--------|
| `src/background/translator.js` | CREATE — translation API client |
| `src/background/service-worker.js` | MODIFY — import translator, handle messages |
| `src/shared/constants.js` | MODIFY — add message type constants |

**Implementation details** (example for Lingva Translate — adjust based on Decision 2):

`translator.js` must:
1. Expose a `translate(texts, sourceLang, targetLang)` function
   - `texts`: array of strings to translate
   - `sourceLang`: ISO 639-1 code (e.g., "en") or "auto" for auto-detect
   - `targetLang`: ISO 639-1 code (e.g., "ja")
   - Returns: array of translated strings (same length as input)
2. Implement the API call based on chosen service:
   - **Lingva Translate**: `GET https://lingva.ml/api/v1/{source}/{target}/{text}`
   - **Google Cloud v2**: `POST https://translation.googleapis.com/language/translate/v2`
   - **DeepL Free**: `POST https://api-free.deepl.com/v2/translate`
3. For bulk translation, join texts with a delimiter (e.g., `\n`), translate as one request, split result
4. Handle errors: network failure, API rate limit, invalid language, empty input
5. Return error information so the caller can show user feedback

**Bulk translation approach** (for all API options):
```javascript
async function translate(texts, sourceLang, targetLang) {
  // Join all texts with a unique delimiter
  const DELIMITER = '\n###YOUSUB###\n';
  const joined = texts.join(DELIMITER);

  // Single API call for the entire batch
  const translatedJoined = await callTranslationAPI(joined, sourceLang, targetLang);

  // Split back into array
  const translatedTexts = translatedJoined.split(DELIMITER);

  // Verify array lengths match
  if (translatedTexts.length !== texts.length) {
    // Fallback: translate individually
    return await translateIndividually(texts, sourceLang, targetLang);
  }

  return translatedTexts;
}
```

**Message passing setup** in `service-worker.js`:
```javascript
import { Translator } from './translator.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE_REQUEST') {
    Translator.translate(message.texts, message.sourceLang, message.targetLang)
      .then(translated => sendResponse({ success: true, translated }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // IMPORTANT: return true to indicate async sendResponse
  }
});
```

**Constants** in `src/shared/constants.js`:
```javascript
(function () {
  const YouSub = window.YouSub || (window.YouSub = {});
  YouSub.MSG = {
    TRANSLATE_REQUEST: 'YOUSUB_TRANSLATE_REQUEST',
    TRANSLATE_RESPONSE: 'YOUSUB_TRANSLATE_RESPONSE'
  };
  YouSub.DEFAULTS = {
    SOURCE_LANG: 'auto',
    TARGET_LANG: 'ja'
  };
})();
```

**Test protocol**:
1. Reload extension
2. Open the service worker DevTools: `chrome://extensions/` → "Inspect views: service worker"
3. In the service worker console, test the translator directly:
   ```javascript
   import('./translator.js').then(m => m.Translator.translate(['Hello world', 'Goodbye'], 'en', 'ja').then(console.log))
   ```
4. Verify translated strings are returned
5. Test with an empty array → should return empty array
6. Test with a very long text (1000+ chars) → should handle without error
7. Test with invalid language code → should return meaningful error

**Definition of Done**:
- [ ] `translator.js` created as ES module
- [ ] `translate(texts, sourceLang, targetLang)` function works
- [ ] Bulk translation (single API call) works
- [ ] Fallback to individual translation if bulk fails
- [ ] Error handling for network/API failures
- [ ] Message listener in service-worker.js handles translation requests
- [ ] Constants defined in shared/constants.js
- [ ] All test scenarios pass

---

### Phase 8: Overlay UI Foundation — Inject and Style Subtitle Container

**Goal**: Create the `overlay.js` module that injects a styled `<div>` container into the YouTube player for displaying subtitle text. This phase creates the visual container only — text synchronization comes in Phase 9.

**Prerequisites**: Phase 4 complete (VideoBinder provides player element reference).

**Files to create/modify**:
| File | Action |
|------|--------|
| `src/content/overlay.js` | CREATE — overlay UI module |
| `src/content/overlay.css` | MODIFY — write overlay styles |
| `src/content/main.js` | MODIFY — create overlay after video is bound |
| `manifest.json` | MODIFY — add `overlay.js` to content_scripts.js array |

**Implementation details**:

`overlay.js` must:
1. Create a container `<div>` with id `yousub-overlay`
2. Inside it, create a text `<span>` with id `yousub-text`
3. Append the container as a DIRECT CHILD of `#movie_player`
4. Provide methods: `show()`, `hide()`, `setText(text)`, `destroy()`
5. The overlay must:
   - Be positioned at the BOTTOM CENTER of the video player
   - Have a semi-transparent dark background behind the text
   - Use a legible sans-serif font (white text on dark background)
   - Not block YouTube's native controls (position above the control bar)
   - Automatically resize with the player (responsive)
   - Work in both normal and fullscreen mode
   - Be hidden by default until subtitles are ready

**CSS specifications for `overlay.css`**:
```css
#yousub-overlay {
  position: absolute;
  bottom: 60px;            /* Above YouTube's control bar (~48px) + margin */
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;             /* Above video, below controls (YouTube controls are z-index: 60+) */
  pointer-events: none;    /* Don't interfere with click events */
  max-width: 80%;          /* Don't overflow the player */
  text-align: center;
  opacity: 0;              /* Hidden by default */
  transition: opacity 0.15s ease;
}

#yousub-overlay.yousub-visible {
  opacity: 1;
}

#yousub-text {
  display: inline-block;
  padding: 4px 12px;
  background: rgba(0, 0, 0, 0.75);
  border-radius: 4px;
  color: #ffffff;
  font-family: 'YouTube Noto', 'Roboto', 'Arial', sans-serif;
  font-size: 1.4em;        /* Relative to player size */
  line-height: 1.4;
  white-space: pre-wrap;   /* Preserve intentional line breaks */
  word-wrap: break-word;
}
```

**Key considerations**:
- `pointer-events: none` is CRITICAL — without it, the overlay blocks clicks on the video player
- `z-index: 60` places it above the video but check it doesn't cover controls. Adjust based on testing.
- `bottom: 60px` positions above YouTube's control bar. When controls are hidden (mouse idle), subtitles still stay at this position, which is visually correct.
- The overlay div should be INSIDE `#movie_player` so it automatically follows fullscreen transitions.

**Test protocol**:
1. Reload extension → navigate to a YouTube video
2. Open DevTools → Elements tab → find `#movie_player` → verify `#yousub-overlay` is a child
3. In console: `window.YouSub.Overlay.setText('Test subtitle text'); window.YouSub.Overlay.show();`
4. Verify: text appears at bottom center of video with dark background
5. Click on video (play/pause) → verify click goes THROUGH the overlay (pointer-events: none)
6. Move mouse to show controls → verify overlay doesn't cover the control bar
7. Enter fullscreen (F key or button) → verify overlay is still visible and positioned correctly
8. Exit fullscreen → verify overlay returns to normal position
9. In console: `window.YouSub.Overlay.hide()` → verify overlay fades out
10. In console: `window.YouSub.Overlay.destroy()` → verify div is removed from DOM

**Definition of Done**:
- [ ] `overlay.js` created with `show()`, `hide()`, `setText()`, `destroy()` methods
- [ ] `overlay.css` has proper positioning, styling, and responsiveness
- [ ] Overlay is child of `#movie_player`
- [ ] Text visible with semi-transparent background
- [ ] Positioned above control bar
- [ ] Click-through works (pointer-events: none)
- [ ] Fullscreen mode works
- [ ] Show/hide transitions work
- [ ] No visual conflicts with YouTube's native UI
- [ ] All 10 test scenarios pass

---

### Phase 9: Synchronization Engine — Timestamp-Based Subtitle Display

**Goal**: Create the `sync-engine.js` module that listens to the video's `timeupdate` event and updates the overlay with the correct subtitle at the correct time.

**Prerequisites**: Phase 6 (SubtitleParser), Phase 8 (Overlay) complete.

**Files to create/modify**:
| File | Action |
|------|--------|
| `src/content/sync-engine.js` | CREATE — synchronization engine module |
| `src/content/main.js` | MODIFY — initialize SyncEngine with subtitle data |
| `manifest.json` | MODIFY — add `sync-engine.js` to content_scripts.js array |

**Implementation details**:

`sync-engine.js` must:
1. Accept a sorted array of subtitle entries: `[{ startMs, endMs, text }, ...]`
2. Listen to `video.ontimeupdate` (fires ~4 times per second)
3. On each `timeupdate`:
   a. Get `video.currentTime * 1000` (convert seconds to milliseconds)
   b. Binary search through the subtitle array to find the entry where `startMs <= currentTimeMs < endMs`
   c. If found and different from currently displayed subtitle → call `Overlay.setText(entry.text)` + `Overlay.show()`
   d. If no subtitle at current time → call `Overlay.hide()`
4. Track the current subtitle index to avoid unnecessary DOM updates
5. Handle seeking: when user jumps to a different time, the binary search naturally handles this
6. Handle playback rate changes: `timeupdate` continues to fire, no special handling needed
7. Provide methods: `start(subtitles, videoElement)`, `stop()`, `pause()`, `resume()`

**Binary search implementation** (critical for performance):
```javascript
function findSubtitleAt(subtitles, timeMs) {
  let low = 0;
  let high = subtitles.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const entry = subtitles[mid];

    if (timeMs < entry.startMs) {
      high = mid - 1;
    } else if (timeMs >= entry.endMs) {
      low = mid + 1;
    } else {
      // timeMs is within [startMs, endMs)
      return mid;
    }
  }

  return -1; // No subtitle at this time
}
```

**Why binary search**: A 10-minute video typically has 100-200 subtitle entries. Linear search (O(n)) would be fine, but binary search (O(log n)) is better practice and handles long videos (1000+ entries) without any performance concern.

**Test protocol**:
1. Reload extension → navigate to a video with subtitles
2. Wait for subtitle data to load (check console logs from previous phases)
3. For now, test with UNTRANSLATED subtitles (translation integration comes in Phase 10)
4. Manually start the sync engine in console:
   ```javascript
   // Assuming subtitles are stored in YouSub namespace from parsing
   const subs = window.YouSub._lastParsedSubtitles; // or however they're stored
   const video = window.YouSub.VideoBinder.getVideo();
   window.YouSub.SyncEngine.start(subs, video);
   ```
5. Play the video → subtitles should appear in sync with speech
6. Pause the video → subtitle should stay on screen (if within time range)
7. Seek forward/backward → correct subtitle should appear immediately
8. Change playback speed (right-click video → Playback speed) → subtitles should still sync
9. Stop sync: `window.YouSub.SyncEngine.stop()` → overlay should disappear

**Definition of Done**:
- [ ] `sync-engine.js` created with `start()`, `stop()`, `pause()`, `resume()` methods
- [ ] Binary search finds correct subtitle for any given timestamp
- [ ] `timeupdate` listener updates overlay correctly
- [ ] Current subtitle index tracked (no redundant DOM updates)
- [ ] Seeking works correctly
- [ ] Playback speed changes handled
- [ ] Cleanup on stop (event listener removed)
- [ ] All test scenarios pass

---

### Phase 10: MVP Integration — Wire All Components + End-to-End Test

**Goal**: Connect all modules built in Phases 3–9 into a complete working flow. When the user visits a YouTube video with subtitles, the extension automatically extracts subtitles, translates them, and displays them synchronized with the video. This is the MVP milestone.

**Prerequisites**: ALL of Phases 3–9 complete.

**Files to modify**:
| File | Action |
|------|--------|
| `src/content/main.js` | MODIFY — orchestrate the full flow |
| `manifest.json` | VERIFY — all content scripts listed in correct order |

**Implementation details**:

`main.js` must orchestrate this flow:
```
1. PageDetector.init → onVideoPageEnter(videoId)
2.   → VideoBinder.bind → onVideoBound(videoElement)
3.     → SubtitleExtractor.extract → captionTracks[]
4.       → Pick the best track (first available, prefer source language from settings)
5.       → SubtitleParser.fetch(track.baseUrl) → subtitleEntries[]
6.         → Send subtitleEntries[].text to background worker for translation
7.           → chrome.runtime.sendMessage({ type: TRANSLATE_REQUEST, texts, sourceLang, targetLang })
8.             → Background worker translates → sends response back
9.               → Build final subtitle array: [{ startMs, endMs, text: translatedText }]
10.                → SyncEngine.start(translatedSubtitles, videoElement)
11.                  → Overlay shows translated subtitles synced to video!
```

**Error handling at each step**:
- Step 2 fails (no video): log warning, do nothing
- Step 3 fails (no tracks): log "No subtitles available for this video"
- Step 5 fails (fetch error): log error, do nothing
- Step 7-8 fails (translation error): **fallback to showing ORIGINAL subtitles** (untranslated)
- Any step fails: do NOT crash, do NOT break YouTube's native functionality

**Cleanup on page leave**:
```javascript
function onVideoPageLeave() {
  YS.SyncEngine.stop();
  YS.Overlay.destroy();
  YS.VideoBinder.unbind();
}
```

**Content script load order in manifest.json** (EXACT order):
```json
"js": [
  "src/shared/constants.js",
  "src/content/logger.js",
  "src/content/page-detector.js",
  "src/content/video-binder.js",
  "src/content/subtitle-extractor.js",
  "src/content/subtitle-parser.js",
  "src/content/overlay.js",
  "src/content/sync-engine.js",
  "src/content/main.js"
]
```
Note: `logger.js` may not exist yet (Phase 16). If not, omit it from this list. Add it when Phase 16 is complete.

**Full end-to-end test protocol**:
1. Reload extension
2. Navigate to a YouTube video with English subtitles (e.g., a TED talk)
3. Expected behavior:
   - Console: `[YouSub] Video page entered. Video ID: XXX`
   - Console: `[YouSub] Video element bound.`
   - Console: `[YouSub] Found N subtitle tracks`
   - Console: `[YouSub] Fetched and parsed N subtitle entries`
   - Console: `[YouSub] Translating N entries...`
   - Console: `[YouSub] Translation complete.`
   - Console: `[YouSub] Sync engine started.`
   - Video player: translated subtitles appear at bottom, synced with speech
4. Play/pause video → subtitles sync correctly
5. Seek to different time → correct subtitle appears
6. Navigate to different video → old subtitles cleared, new ones loaded
7. Navigate to video WITHOUT subtitles → no crash, console shows info message
8. Navigate to non-video page → clean teardown, no errors

**Definition of Done**:
- [ ] All modules wired together in main.js
- [ ] Full flow works: detect → bind → extract → parse → translate → sync → display
- [ ] Translated subtitles visible and synced on a real YouTube video
- [ ] Video change triggers full re-initialization
- [ ] Page leave triggers full cleanup
- [ ] Translation failure falls back to original subtitles
- [ ] No subtitles available → graceful handling
- [ ] No console errors during normal operation
- [ ] YouTube's native controls and features still work normally

**THIS IS THE MVP MILESTONE. After this phase, the extension is functionally useful.**

---

### Phase 11: Background Service Worker — Message Passing Architecture

**Goal**: Refine the message passing between content script and background service worker. Ensure translation API calls happen ONLY in the background worker (not content script), and the communication is robust.

**Prerequisites**: Phase 10 (MVP) complete and working.

**Files to create/modify**:
| File | Action |
|------|--------|
| `src/background/service-worker.js` | MODIFY — robust message handling |
| `src/shared/messages.js` | CREATE — message type definitions and helpers |
| `src/shared/constants.js` | MODIFY — update with all message types |
| `src/content/main.js` | MODIFY — use message helpers |
| `manifest.json` | MODIFY — add `messages.js` to content_scripts.js array |

**Implementation details**:

The message passing architecture:
```
Content Script                    Background Worker
     │                                  │
     │── TRANSLATE_REQUEST ───────────►│
     │   { texts[], sourceLang,         │── calls Translation API
     │     targetLang, videoId }        │
     │                                  │
     │◄── TRANSLATE_RESPONSE ──────────│
     │   { success, translated[],       │
     │     error? }                     │
     │                                  │
     │── GET_SETTINGS ────────────────►│
     │                                  │── reads chrome.storage
     │◄── SETTINGS_RESPONSE ───────────│
     │   { targetLang, ... }            │
```

`messages.js` provides helper functions:
```javascript
(function () {
  const YouSub = window.YouSub || (window.YouSub = {});

  YouSub.Messages = {
    sendToBackground: function (type, data) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type, ...data }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    },

    requestTranslation: function (texts, sourceLang, targetLang) {
      return this.sendToBackground('YOUSUB_TRANSLATE_REQUEST', {
        texts, sourceLang, targetLang
      });
    }
  };
})();
```

**Key considerations**:
- Background service workers in MV3 can be terminated when idle. Use `chrome.runtime.onMessage` to wake them.
- Always check `chrome.runtime.lastError` after `sendMessage`
- Use `return true` in `onMessage` listener for async responses
- Include timeout handling (if background doesn't respond within 30 seconds, fail gracefully)

**Test protocol**:
1. Reload extension → navigate to a video with subtitles
2. Verify translation still works (full flow from Phase 10)
3. Open background worker DevTools → verify translation API calls happen there (not in content script)
4. Kill the service worker manually (Chrome may do this) → navigate to a new video → should auto-restart
5. Test error case: disconnect internet → translation should fail gracefully with original subtitles shown

**Definition of Done**:
- [ ] All API calls happen in background worker only
- [ ] `messages.js` helper module created
- [ ] Robust error handling for message passing
- [ ] Timeout handling for unresponsive background worker
- [ ] Service worker restart works correctly
- [ ] All existing tests still pass

---

### Phase 12: Popup UI — Language Selection + Basic Settings

**Goal**: Create the popup interface that lets the user select source language, target language, and toggle the extension on/off.

**Prerequisites**: Phase 11 complete.

**Files to modify**:
| File | Action |
|------|--------|
| `src/popup/popup.html` | MODIFY — add language selectors and toggle |
| `src/popup/popup.css` | MODIFY — style the popup |
| `src/popup/popup.js` | MODIFY — add logic for settings |

**Implementation details**:

`popup.html` must include:
1. Extension name/logo at the top
2. On/Off toggle switch
3. Source language dropdown (with "Auto-detect" as first option + common languages)
4. Target language dropdown (common languages, user's preferred language pre-selected)
5. "Save" button (or auto-save on change)
6. Status text showing current state ("Active", "No subtitles", "Error", etc.)

**Language list** (minimum viable — add more later):
```
auto — Auto-detect
en — English
ja — Japanese (日本語)
ko — Korean (한국어)
zh — Chinese (中文)
vi — Vietnamese (Tiếng Việt)
es — Spanish (Español)
fr — French (Français)
de — German (Deutsch)
pt — Portuguese (Português)
ru — Russian (Русский)
ar — Arabic (العربية)
hi — Hindi (हिन्दी)
th — Thai (ไทย)
id — Indonesian (Bahasa Indonesia)
```

**Popup dimensions**: Chrome popups are typically 300-400px wide, 400-500px tall. Keep it compact.

**Test protocol**:
1. Click extension icon → popup opens with language dropdowns
2. Change target language → verify selection is saved (check chrome.storage)
3. Close and reopen popup → verify saved language is still selected
4. Toggle off → verify extension disables (console log, no more subtitle processing)
5. Toggle on → verify extension re-enables

**Definition of Done**:
- [ ] Popup has language selectors and toggle
- [ ] Clean, readable UI
- [ ] Settings saved to chrome.storage
- [ ] Settings persist across popup close/open
- [ ] Toggle on/off works
- [ ] All test scenarios pass

---

### Phase 13: Settings Persistence — chrome.storage Integration

**Goal**: Implement a centralized settings system using `chrome.storage.sync` that persists user preferences and notifies content scripts when settings change.

**Prerequisites**: Phase 12 complete.

**Files to create/modify**:
| File | Action |
|------|--------|
| `src/shared/constants.js` | MODIFY — add default settings |
| `src/background/service-worker.js` | MODIFY — handle settings change events |
| `src/content/main.js` | MODIFY — load settings on init, react to changes |
| `src/popup/popup.js` | MODIFY — save/load from chrome.storage.sync |

**Implementation details**:

**Default settings** (in constants.js):
```javascript
YouSub.DEFAULT_SETTINGS = {
  enabled: true,
  sourceLang: 'auto',
  targetLang: 'ja',
  fontSize: 'medium',      // small, medium, large, xlarge
  fontColor: '#ffffff',
  bgOpacity: 0.75,
  subtitlePosition: 'bottom', // bottom, top
  showDualSubtitles: false
};
```

**Settings flow**:
1. On first install: write `DEFAULT_SETTINGS` to `chrome.storage.sync`
2. Popup reads from `chrome.storage.sync` to populate UI
3. On settings change: write to `chrome.storage.sync`
4. Use `chrome.storage.onChanged` listener to notify content scripts
5. Content script reacts to changes (e.g., re-translate if target language changed)

**Critical: `chrome.storage.sync` vs `chrome.storage.local`**:
- `sync`: settings (small data, syncs across devices) — use for user preferences
- `local`: cache (large data, device-specific) — use for translation cache (Phase 19)

**Test protocol**:
1. Install fresh (or clear storage) → verify default settings applied
2. Change target language in popup → content script gets notified and re-translates
3. Toggle off in popup → content script stops showing subtitles
4. Close browser, reopen → verify settings persisted
5. Check `chrome.storage.sync` via DevTools: `chrome.storage.sync.get(null, console.log)`

**Definition of Done**:
- [ ] Default settings defined and applied on first install
- [ ] Popup reads/writes chrome.storage.sync
- [ ] Content script loads settings on init
- [ ] chrome.storage.onChanged notifies content script of changes
- [ ] Target language change triggers re-translation
- [ ] Toggle on/off works end-to-end
- [ ] Settings survive browser restart

---

### Phase 13.5: Custom LLM Translation Integration — Bring Your Own Key

**Goal**: Implement an architecture that allows users to provide their own LLM API keys (e.g., OpenAI, Gemini, Claude, generic endpoints). This will replace or supplement the basic translation API from Phase 7.

**Prerequisites**: Phase 13 (so settings UI exists to input API keys).

**Implementation steps**:
1. Update `YOUSUB_DESIGN_DECISIONS.md` to design LLM prompting strategies.
2. Build new translation backend adapter for LLM endpoints.
3. Update popup settings to include API key input and model selection.
4. Securely store API keys using `chrome.storage.local`.

---

### Phase 14: Dual Subtitle Display — Original + Translated

**Goal**: Add the option to display both original and translated subtitles simultaneously, with the original text shown smaller/lighter above the translated text.

**Prerequisites**: Phase 13 complete (settings system working).

**Files to modify**:
| File | Action |
|------|--------|
| `src/content/overlay.js` | MODIFY — add dual text display |
| `src/content/overlay.css` | MODIFY — add dual subtitle styles |
| `src/content/sync-engine.js` | MODIFY — pass both original and translated text |
| `src/content/main.js` | MODIFY — build subtitle entries with both texts |

**Implementation details**:

Updated overlay HTML structure:
```html
<div id="yousub-overlay">
  <div id="yousub-original" class="yousub-line yousub-original-line">Original text here</div>
  <div id="yousub-translated" class="yousub-line yousub-translated-line">Translated text here</div>
</div>
```

Updated subtitle entry format:
```javascript
{
  startMs: 1234,
  endMs: 6234,
  original: "Hello world",       // original text
  translated: "こんにちは世界"    // translated text
}
```

Display modes (controlled by settings):
- `translated-only`: show only `#yousub-translated` (default)
- `original-only`: show only `#yousub-original`
- `dual`: show both `#yousub-original` and `#yousub-translated`

**CSS for dual mode**:
```css
.yousub-original-line {
  font-size: 0.85em;
  color: rgba(255, 255, 255, 0.7);   /* Lighter, less prominent */
  margin-bottom: 2px;
}

.yousub-translated-line {
  font-size: 1.4em;
  color: #ffffff;                     /* Full white, prominent */
}
```

**Test protocol**:
1. Enable dual subtitles in settings
2. Navigate to a video → both original and translated text visible
3. Original text matches the video's speech
4. Translated text is the translation
5. Switch to "translated only" → only translated text visible
6. Switch to "original only" → only original text visible
7. Verify positioning doesn't overflow the player

**Definition of Done**:
- [ ] Overlay supports three display modes
- [ ] Dual mode shows original (smaller) above translated (larger)
- [ ] Display mode controlled by settings
- [ ] Sync engine passes both original and translated text
- [ ] No visual overflow or layout issues
- [ ] All display modes work in fullscreen

---

### Phase 15: UI Customization — Font, Color, Position, Opacity

**Goal**: Allow users to customize the subtitle overlay appearance: font size, text color, background opacity, and subtitle position (top/bottom).

**Prerequisites**: Phase 14 complete.

**Files to modify**:
| File | Action |
|------|--------|
| `src/popup/popup.html` | MODIFY — add customization controls |
| `src/popup/popup.css` | MODIFY — style customization controls |
| `src/popup/popup.js` | MODIFY — save customization settings |
| `src/content/overlay.js` | MODIFY — apply dynamic styles |
| `src/content/overlay.css` | MODIFY — add style variables or classes |

**Implementation details**:

Customization options:

| Setting | Type | Values | Default |
|---------|------|--------|---------|
| Font size | Dropdown | small (1.0em), medium (1.4em), large (1.8em), xlarge (2.2em) | medium |
| Font color | Color input | Any hex color | #ffffff |
| Background opacity | Range slider | 0.0 to 1.0 (step 0.05) | 0.75 |
| Position | Radio buttons | bottom, top | bottom |

**Apply styles dynamically** using CSS custom properties:
```javascript
// overlay.js
applySettings: function (settings) {
  const overlay = document.getElementById('yousub-overlay');
  overlay.style.setProperty('--yousub-font-size', fontSizeMap[settings.fontSize]);
  overlay.style.setProperty('--yousub-font-color', settings.fontColor);
  overlay.style.setProperty('--yousub-bg-opacity', settings.bgOpacity);

  // Position
  if (settings.subtitlePosition === 'top') {
    overlay.style.bottom = 'auto';
    overlay.style.top = '20px';
  } else {
    overlay.style.top = 'auto';
    overlay.style.bottom = '60px';
  }
}
```

**Test protocol**:
1. Open popup → customization controls visible
2. Change font size → subtitle text size changes in real-time on the video
3. Change color → text color changes
4. Slide background opacity → background transparency changes
5. Switch to top position → subtitles move to top of video
6. All changes persist after closing popup
7. All changes work in fullscreen mode

**Definition of Done**:
- [ ] All 4 customization options available in popup
- [ ] Changes applied in real-time to the overlay
- [ ] Settings persist via chrome.storage
- [ ] Fullscreen mode works with all customizations
- [ ] Popup UI is clean and intuitive

---

### Phase 16: Structured Debug Logging — JSONL Logger Module

**Goal**: Create the `logger.js` module that implements structured JSONL logging per GEMINI.md Rule 9. All modules should use this logger instead of `console.log`.

**Prerequisites**: Phase 10 (MVP) complete. Can be done in parallel with Phases 11-15.

**Files to create/modify**:
| File | Action |
|------|--------|
| `src/content/logger.js` | CREATE — structured JSONL logger |
| `src/content/main.js` | MODIFY — replace console.log with Logger calls |
| `src/content/page-detector.js` | MODIFY — use Logger |
| `src/content/video-binder.js` | MODIFY — use Logger |
| `src/content/subtitle-extractor.js` | MODIFY — use Logger |
| `src/content/subtitle-parser.js` | MODIFY — use Logger |
| `src/content/overlay.js` | MODIFY — use Logger |
| `src/content/sync-engine.js` | MODIFY — use Logger |
| `manifest.json` | MODIFY — add `logger.js` as first content script |

**Implementation details**:

JSONL log format (per GEMINI.md):
```json
{"ts":"2026-04-03T12:00:00.000Z","level":"INFO","tag":"PageDetector","msg":"Video page entered. Video ID: dQw4w9WgXcQ"}
```

Logger module:
```javascript
YouSub.Logger = {
  _entries: [],
  _maxEntries: 1000,  // Ring buffer size

  _log: function (level, tag, msg, data) {
    const entry = {
      ts: new Date().toISOString(),
      level: level,
      tag: tag,
      msg: msg
    };
    if (data) entry.data = data;

    this._entries.push(entry);
    if (this._entries.length > this._maxEntries) {
      this._entries.shift(); // Ring buffer: remove oldest
    }

    // Also log to console for development
    const prefix = '[YouSub][' + tag + ']';
    if (level === 'ERROR') console.error(prefix, msg, data || '');
    else if (level === 'WARN') console.warn(prefix, msg, data || '');
    else console.log(prefix, msg, data || '');
  },

  debug: function (tag, msg, data) { this._log('DEBUG', tag, msg, data); },
  info:  function (tag, msg, data) { this._log('INFO', tag, msg, data); },
  warn:  function (tag, msg, data) { this._log('WARN', tag, msg, data); },
  error: function (tag, msg, data) { this._log('ERROR', tag, msg, data); },

  // Export logs as JSONL string (for debugging/download)
  export: function () {
    return this._entries.map(e => JSON.stringify(e)).join('\n');
  },

  // Get last N entries
  tail: function (n) {
    return this._entries.slice(-n);
  }
};
```

**Tag naming convention**:
| Module | Tag |
|--------|-----|
| main.js | `Main` |
| page-detector.js | `PageDetector` |
| video-binder.js | `VideoBinder` |
| subtitle-extractor.js | `SubtitleExtractor` |
| subtitle-parser.js | `SubtitleParser` |
| overlay.js | `Overlay` |
| sync-engine.js | `SyncEngine` |
| translator.js | `Translator` |
| cache.js | `Cache` |

**Test protocol**:
1. Reload extension → navigate to a video
2. Console shows structured log messages with `[YouSub][Tag]` prefix
3. In console: `JSON.stringify(window.YouSub.Logger.tail(5), null, 2)` → shows last 5 log entries in JSONL-compatible format
4. In console: `window.YouSub.Logger.export()` → shows full log as JSONL string
5. Generate >1000 log entries → verify ring buffer keeps only latest 1000

**Definition of Done**:
- [ ] `logger.js` created with debug/info/warn/error methods
- [ ] JSONL format with ts, level, tag, msg fields
- [ ] Ring buffer (configurable max entries)
- [ ] All existing modules migrated from console.log to Logger
- [ ] Export function works
- [ ] Logs readable by AI in future sessions

---

### Phase 17: Error Handling + User Feedback — Graceful Degradation

**Goal**: Implement comprehensive error handling throughout the extension and provide non-intrusive user feedback (toast notifications) for important events.

**Prerequisites**: Phase 13 (settings), Phase 16 (logger) complete.

**Files to create/modify**:
| File | Action |
|------|--------|
| `src/content/toast.js` | CREATE — toast notification UI component |
| `src/content/overlay.css` | MODIFY — add toast styles |
| `src/content/main.js` | MODIFY — add error handling at each flow step |
| `manifest.json` | MODIFY — add `toast.js` to content_scripts |

**Implementation details**:

**Toast notification**: A small, auto-dismissing message that appears briefly at the top of the video player.
```html
<div id="yousub-toast" class="yousub-toast">
  <span class="yousub-toast-text">Subtitles loaded: 142 entries</span>
</div>
```

**Events that show toasts**:
| Event | Message | Duration |
|-------|---------|----------|
| Subtitles loaded | "YouSub: Subtitles loaded (142 entries)" | 3s |
| Translation complete | "YouSub: Translation complete" | 2s |
| No subtitles available | "YouSub: No subtitles available for this video" | 4s |
| Translation failed | "YouSub: Translation failed — showing original subtitles" | 5s |
| Extension disabled | "YouSub: Disabled" | 2s |

**Error handling strategy** at each step:
```
Step fails → Log error → Show toast → Fallback (if possible) → Do NOT crash
```

| Error | Fallback |
|-------|----------|
| Video element not found | Retry 3 times with 2s delay, then give up |
| No subtitle tracks | Show toast, do nothing |
| Subtitle fetch failed | Retry once, then show toast |
| Translation API failed | Show original (untranslated) subtitles |
| Overlay injection failed | Log error, do nothing (extension is non-essential) |
| Background worker unresponsive | Retry once, then show error toast |

**Test protocol**:
1. Test on video WITHOUT subtitles → toast shows "No subtitles available"
2. Disconnect internet, then navigate to video → translation fails → toast shows "Translation failed" → original subtitles displayed
3. Test on video WITH subtitles → toast shows "Subtitles loaded" briefly
4. Verify no uncaught exceptions in console during any scenario
5. Verify YouTube's native functionality is never broken by errors

**Definition of Done**:
- [ ] Toast notification component created
- [ ] All error scenarios handled with try/catch
- [ ] User sees meaningful feedback for important events
- [ ] Translation failure gracefully falls back to original subtitles
- [ ] No uncaught exceptions in any tested scenario
- [ ] YouTube never broken by extension errors

---

### Phase 18: Edge Cases — Subtitle Varieties + Video Scenarios

**Goal**: Handle all subtitle types and video scenarios that YouTube presents. Ensure the extension doesn't crash or behave unexpectedly on any YouTube page.

**Prerequisites**: Phase 17 complete.

**Files to modify**:
| File | Action |
|------|--------|
| `src/content/subtitle-extractor.js` | MODIFY — handle all track types |
| `src/content/subtitle-parser.js` | MODIFY — handle format variations |
| `src/content/main.js` | MODIFY — add track selection logic |
| `src/content/page-detector.js` | MODIFY — handle edge case URLs |

**Edge cases to handle**:

**Subtitle varieties**:
1. **Auto-generated** (`kind: "asr"`) — usually available, lower quality text
2. **Manual/community** (no `kind` field) — higher quality, less common
3. **Multiple languages** — let user pick, or auto-select based on settings
4. **Translation tracks** — YouTube offers auto-translated tracks via `translationLanguages` parameter
5. **No subtitles at all** — handled in Phase 17

**Track selection logic**:
```
1. Filter tracks to find one matching user's source language setting
2. If source is "auto": prefer manual track, then auto-generated
3. If multiple tracks for same language: prefer manual over auto-generated
4. If no track matches: use the first available track
5. If no tracks at all: show "No subtitles available"
```

**Video scenarios**:
1. **Normal videos** — standard flow
2. **Live streams** — may not have traditional subtitles (check and skip)
3. **Premieres** — behave like live streams until they end
4. **Playlist autoplay** — handled by yt-navigate-finish + video ID change detection
5. **Embedded videos** — content script doesn't run on embedded (different URL)
6. **Shorts** — URL is `/shorts/VIDEO_ID`, different player DOM
7. **Mini-player** — when user navigates away from watch page but video continues
8. **Age-restricted videos** — may require login, different data structure
9. **Private/unavailable** — no player response at all

**Test protocol** (test each scenario manually):
1. Normal video with manual subtitles → works
2. Video with only auto-generated subtitles → works
3. Video with multiple language subtitles → correct language selected
4. Live stream → no crash, no subtitles shown
5. Playlist: video auto-advances → subtitles refresh for new video
6. YouTube Shorts page → no crash (extension may not support Shorts, just don't crash)
7. Navigate away from watch page → clean teardown

**Definition of Done**:
- [ ] Auto-generated and manual subtitles both handled
- [ ] Multiple language track selection works
- [ ] Live streams handled gracefully (no crash)
- [ ] Playlist navigation works
- [ ] Shorts page doesn't crash the extension
- [ ] All test scenarios pass without errors

---

### Phase 19: Translation Caching — Local Cache for Performance

**Goal**: Cache translated subtitles locally so that revisiting a video (or rewinding) doesn't re-call the translation API. Significantly reduces API usage and improves load time.

**Prerequisites**: Phase 13 (settings/storage) complete.

**Files to create/modify**:
| File | Action |
|------|--------|
| `src/background/cache.js` | CREATE — translation cache module |
| `src/background/service-worker.js` | MODIFY — check cache before calling API |

**Implementation details**:

**Cache key format**: `yousub_cache_{videoId}_{sourceLang}_{targetLang}`

**Cache entry**:
```javascript
{
  videoId: "dQw4w9WgXcQ",
  sourceLang: "en",
  targetLang: "ja",
  translated: ["translated text 1", "translated text 2", ...],
  cachedAt: 1712102400000,  // timestamp
  version: 1                // cache format version (for future migrations)
}
```

**Cache strategy**:
- Storage: `chrome.storage.local` (5MB default, can request `unlimitedStorage` permission)
- TTL: 7 days (configurable). Translations don't change, but subtitle data might be updated.
- Max entries: 100 videos. When exceeded, evict oldest entries (LRU).
- Cache lookup: Before calling translation API, check if cache entry exists for this videoId + languages.

**Cache flow in service-worker.js**:
```
1. Receive TRANSLATE_REQUEST with { texts, sourceLang, targetLang, videoId }
2. Check cache: Cache.get(videoId, sourceLang, targetLang)
3. If cache HIT and texts.length matches → return cached translated texts
4. If cache MISS or length mismatch → call Translation API → cache result → return
```

**Test protocol**:
1. Navigate to a video → first time: API call made (check network or console)
2. Navigate away, then back to same video → second time: NO API call (cache hit)
3. Console log should show "Cache hit for video XXX"
4. Change target language → API call made (different cache key)
5. Wait 7+ days (or modify cachedAt manually) → cache expired, API call made
6. Check storage size: `chrome.storage.local.getBytesInUse(null, console.log)`

**Definition of Done**:
- [ ] `cache.js` module created as ES module
- [ ] Cache stores translations keyed by videoId + languages
- [ ] Cache hit skips API call
- [ ] Cache miss triggers API call + stores result
- [ ] TTL expiration works
- [ ] LRU eviction when max entries exceeded
- [ ] Cache size stays reasonable (<5MB for 100 videos)

---

### Phase 20: Performance Optimization — DOM, Memory, CPU

**Goal**: Profile and optimize the extension to ensure minimal impact on YouTube's performance. Target: <1% CPU overhead, <10MB memory overhead, <16ms per DOM update.

**Prerequisites**: Phase 19 complete. All features implemented.

**Files to modify**:
| File | Action |
|------|--------|
| `src/content/sync-engine.js` | MODIFY — optimize timeupdate handler |
| `src/content/overlay.js` | MODIFY — minimize DOM writes |
| `src/content/main.js` | MODIFY — optimize initialization |

**Optimization targets**:

1. **timeupdate handler**: Called ~4 times/second. Must be <1ms per invocation.
   - Binary search: O(log n) — already optimal
   - DOM write: only when subtitle changes (already implemented)
   - Add: skip if video is paused (no need to re-check)

2. **DOM writes**: Minimize reflows and repaints
   - Use `textContent` instead of `innerHTML` (no HTML parsing, XSS-safe)
   - Batch updates using `requestAnimationFrame` if multiple changes needed
   - Avoid reading layout properties (offsetWidth, etc.) in the update path

3. **Memory**:
   - Subtitle array: ~100-500 entries, ~50KB — negligible
   - Translation cache: bounded by Phase 19's LRU eviction
   - Logger ring buffer: bounded by max entries
   - Event listeners: properly removed on cleanup

4. **Initialization**:
   - Subtitle fetch + translation: happens once per video load
   - Parsing: single pass, O(n) — optimal

**Profiling steps** (developer performs these):
1. Open DevTools → Performance tab → record 30 seconds of video playback
2. Check: YouSub-related scripting time should be <5% of total
3. Open DevTools → Memory tab → take heap snapshot
4. Check: YouSub objects should be <10MB total
5. Play video for 10 minutes → take another snapshot → verify no growing allocations (no leaks)

**Test protocol**:
1. Play a video for 5 minutes → no visible stuttering or lag
2. CPU usage (Task Manager) stays low
3. DevTools Performance recording shows clean trace
4. Navigate between 10 different videos rapidly → no memory accumulation
5. Extension works smoothly on a 2-hour long video (many subtitle entries)

**Definition of Done**:
- [ ] timeupdate handler optimized (<1ms)
- [ ] DOM writes minimized (textContent, only on change)
- [ ] No memory leaks (verified with heap snapshots)
- [ ] Event listeners properly cleaned up on teardown
- [ ] Smooth performance on long videos
- [ ] No visible impact on YouTube playback

---

### Phase 21: Test Infrastructure + Unit Tests — Jest Setup + Core Tests

**Goal**: Set up Jest testing framework and write unit tests for all pure logic modules (parser, binary search, cache logic). This phase establishes the test infrastructure that enables CI-quality verification.

**Prerequisites**: Phase 20 complete. All core logic stabilized.

**Files to create/modify**:
| File | Action |
|------|--------|
| `package.json` | CREATE — npm project with Jest dependency |
| `jest.config.js` | CREATE — Jest configuration |
| `tests/unit/subtitle-parser.test.js` | CREATE — parser unit tests |
| `tests/unit/sync-engine.test.js` | CREATE — binary search unit tests |
| `tests/unit/cache.test.js` | CREATE — cache logic unit tests |
| `tests/helpers/` | CREATE — test utilities, mock data |

**Implementation details**:

**Setting up Jest**:
```bash
npm init -y
npm install --save-dev jest
```

**jest.config.js**:
```javascript
module.exports = {
  testEnvironment: 'jsdom',    // Browser-like environment
  testMatch: ['**/tests/**/*.test.js'],
  verbose: true
};
```

**Note on testing browser extension code**: The content scripts use IIFE + `window.YouSub` pattern, which is tricky to test directly. Options:
1. Extract pure logic functions into separate testable files that don't depend on `window.YouSub`
2. Create test wrappers that set up the `window.YouSub` namespace before importing
3. Use Jest's `jsdom` environment which provides a `window` object

**Recommended approach**: Keep the IIFE pattern for the extension, but export the core logic functions for testing:
```javascript
// In subtitle-parser.js, at the end of the IIFE:
if (typeof module !== 'undefined' && module.exports) {
  module.exports = YouSub.SubtitleParser;
}
```
This conditional export works for testing with Node.js/Jest without affecting the browser extension.

**Test cases for subtitle-parser**:
1. Parse valid JSON3 with multiple events → correct normalized output
2. Parse events with multiple segs → text concatenated correctly
3. Parse events without segs (metadata) → skipped
4. Parse events with newlines → handled correctly
5. Parse empty events array → empty result
6. Parse XML format → correct normalized output
7. Verify startMs/endMs calculation: endMs = startMs + dDurationMs
8. Verify output is sorted by startMs

**Test cases for sync-engine (binary search)**:
1. Find subtitle at exact start time → correct index
2. Find subtitle at middle of duration → correct index
3. Time before first subtitle → returns -1
4. Time after last subtitle → returns -1
5. Time between two subtitles (gap) → returns -1
6. Empty subtitles array → returns -1
7. Single subtitle entry → found when in range

**Test cases for cache**:
1. Set and get → returns cached data
2. Get non-existent key → returns null
3. TTL expiration → returns null after TTL
4. LRU eviction → oldest entry removed when max exceeded

**Test protocol**:
```bash
npm test
```
All tests should pass with green output. Output should be machine-readable (Jest default output is fine).

**Definition of Done**:
- [ ] `package.json` created with Jest dependency
- [ ] `jest.config.js` configured
- [ ] Parser tests: 8+ test cases, all passing
- [ ] Binary search tests: 7+ test cases, all passing
- [ ] Cache tests: 4+ test cases, all passing
- [ ] `npm test` runs and all tests pass
- [ ] Test output is clear and machine-readable

---

### Phase 22: Cross-Browser Compatibility — Firefox + Edge

**Goal**: Make the extension work on Firefox and Microsoft Edge with minimal code changes. Edge uses Chromium so it should work with no changes. Firefox requires some manifest differences.

**Prerequisites**: Phase 21 complete. All tests passing.

**Files to create/modify**:
| File | Action |
|------|--------|
| `manifest.firefox.json` | CREATE — Firefox-specific manifest |
| `scripts/build-firefox.js` | CREATE — build script to generate Firefox version |
| `src/shared/browser-api.js` | CREATE — browser API abstraction (optional) |

**Implementation details**:

**Firefox differences**:
1. Firefox uses `manifest.json` v2 OR v3 (Firefox supports MV3 since Firefox 109)
2. Firefox uses `browser.*` namespace instead of `chrome.*` (but `chrome.*` is polyfilled)
3. Background scripts: Firefox MV3 uses `"background": { "scripts": ["..."] }` instead of `"service_worker"`
4. Some API behavior differences (e.g., `sendMessage` returns a Promise in Firefox natively)

**Minimal approach**: Create a `manifest.firefox.json` that handles Firefox's MV3 quirks, keep all source code the same. Firefox's `chrome.*` polyfill handles the namespace difference.

**Edge**: Uses Chromium engine. The Chrome version should work as-is. Test and confirm.

**Brave**: Uses Chromium engine. Should work as-is. Test and confirm.

**Test protocol**:
1. **Firefox**: Install Firefox → `about:debugging` → Load Temporary Add-on → select manifest.json
2. Navigate to YouTube video → verify subtitles work
3. **Edge**: Open `edge://extensions/` → Developer mode → Load unpacked
4. Navigate to YouTube video → verify subtitles work
5. **Brave**: Same as Chrome process
6. Verify: all features work identically across browsers

**Definition of Done**:
- [ ] Firefox manifest created
- [ ] Extension loads and works in Firefox
- [ ] Extension loads and works in Edge
- [ ] Extension loads and works in Brave
- [ ] All core features function identically
- [ ] No browser-specific hacks in main source code

---

### Phase 23: Visual Polish + Packaging — Icons, Animations, Store Prep

**Goal**: Final visual polish (icons, animations, loading states) and prepare the extension for Chrome Web Store submission.

**Prerequisites**: Phase 22 complete.

**Files to create/modify**:
| File | Action |
|------|--------|
| `assets/icons/icon16.png` | REPLACE — final designed icon |
| `assets/icons/icon48.png` | REPLACE — final designed icon |
| `assets/icons/icon128.png` | REPLACE — final designed icon |
| `src/content/overlay.css` | MODIFY — add animations |
| `assets/store/` | CREATE — Chrome Web Store assets |

**Implementation details**:

**Icon design**: The icon should be recognizable at 16x16. Suggested: a speech bubble with "字" (kanji character for "character/letter") or a subtitle icon (two horizontal lines at bottom of a rectangle).

**CSS animations for overlay**:
```css
/* Fade in/out transition (already from Phase 8) */
#yousub-overlay {
  transition: opacity 0.15s ease;
}

/* Optional: subtle slide-up when new subtitle appears */
@keyframes yousub-slide-up {
  from { transform: translateX(-50%) translateY(4px); opacity: 0; }
  to   { transform: translateX(-50%) translateY(0); opacity: 1; }
}
```

**Loading state**: While subtitles are being fetched/translated, show a small loading indicator in the overlay:
```html
<div id="yousub-loading" class="yousub-loading">
  <span class="yousub-spinner"></span> Loading subtitles...
</div>
```

**Chrome Web Store preparation**:
1. Store listing description (max 132 chars for short, 16K for long)
2. Screenshots (1280x800 or 640x400)
3. Promotional images (optional: 440x280 small, 920x680 large)
4. Privacy policy (required if using external APIs)
5. Category: Accessibility or Productivity

**Test protocol**:
1. Install extension fresh → icon looks good at all sizes
2. Navigate to video → loading indicator appears briefly, then subtitles
3. Subtitles have smooth fade transitions
4. Popup UI looks polished and professional
5. Extension info page shows correct icon and description
6. Package extension: Chrome → `chrome://extensions/` → "Pack extension"
7. Verify `.crx` file is generated

**Definition of Done**:
- [ ] Professional icons at 16x16, 48x48, 128x128
- [ ] Smooth CSS animations for subtitle transitions
- [ ] Loading state while fetching/translating
- [ ] Popup UI visually polished
- [ ] Chrome Web Store assets prepared (description, screenshots)
- [ ] Extension packaged as `.crx` successfully
- [ ] README.md written with installation instructions

---

## APPENDIX

### A. Translation API Reference (Quick Reference)

#### Lingva Translate (Free, recommended for development)
```
GET https://lingva.ml/api/v1/{source}/{target}/{text}

Example:
GET https://lingva.ml/api/v1/en/ja/Hello%20world

Response:
{ "translation": "こんにちは世界" }
```

#### Google Cloud Translation v2 (Paid, recommended for production)
```
POST https://translation.googleapis.com/language/translate/v2
Headers: Content-Type: application/json
Body: {
  "q": ["Hello world", "Goodbye"],
  "source": "en",
  "target": "ja",
  "key": "YOUR_API_KEY"
}

Response:
{
  "data": {
    "translations": [
      { "translatedText": "こんにちは世界" },
      { "translatedText": "さようなら" }
    ]
  }
}
```

#### DeepL API Free
```
POST https://api-free.deepl.com/v2/translate
Headers: Authorization: DeepL-Auth-Key YOUR_KEY
Body: {
  "text": ["Hello world", "Goodbye"],
  "source_lang": "EN",
  "target_lang": "JA"
}

Response:
{
  "translations": [
    { "text": "こんにちは世界" },
    { "text": "さようなら" }
  ]
}
```

### B. Manifest V3 Key Concepts

| Concept | Description |
|---------|-------------|
| Service Worker | Replaces background pages. Runs in a separate context, no DOM access. Can be terminated when idle. |
| Content Scripts | Injected into web pages. Access the page's DOM but run in an "isolated world" (separate JS context). |
| Isolated World | Content scripts can read/modify the DOM but cannot access the page's JS variables (e.g., `ytInitialPlayerResponse`). |
| MAIN World | The page's own JS context. Accessible via `<script>` injection or `chrome.scripting.executeScript({ world: 'MAIN' })`. |
| Message Passing | `chrome.runtime.sendMessage` / `chrome.runtime.onMessage` for content ↔ background communication. |
| chrome.storage | `sync` for small settings (syncs across devices), `local` for larger data (device-specific). |

### C. Useful Chrome DevTools Commands

```javascript
// Check if YouSub namespace exists
window.YouSub

// Get current video element
document.querySelector('video.html5-main-video')

// Get current video time
document.querySelector('video').currentTime

// Check subtitle overlay
document.getElementById('yousub-overlay')

// View YouSub logs (after Phase 16)
window.YouSub.Logger.tail(20)

// Export full logs
window.YouSub.Logger.export()

// Check extension storage
chrome.storage.sync.get(null, console.log)
chrome.storage.local.get(null, console.log)

// Manually trigger page detection
window.YouSub.PageDetector.checkPage && window.YouSub.PageDetector.checkPage()
```

### D. Common Pitfalls and How to Avoid Them

| Pitfall | Why It Happens | How to Avoid |
|---------|---------------|--------------|
| Content script can't read `ytInitialPlayerResponse` | Content scripts run in ISOLATED world | Inject `<script>` into MAIN world, use postMessage to relay data back |
| Extension breaks on YouTube navigation | YouTube is a SPA, `DOMContentLoaded` only fires once | Use `yt-navigate-finish` event for navigation detection |
| Overlay blocks video clicks | Missing `pointer-events: none` on overlay div | Always set `pointer-events: none` on the overlay container |
| Service worker stops responding | MV3 service workers are terminated when idle | Always handle `chrome.runtime.lastError`, add retry logic |
| Subtitles out of sync after seeking | Using linear scan instead of binary search | Use binary search, recalculate on every timeupdate |
| Translation API CORS errors | Content scripts can't call cross-origin APIs on some pages | Make ALL API calls from the background service worker |
| `chrome.runtime.sendMessage` fails | No listener on the other end, or async response not handled | Return `true` in onMessage for async, check `lastError` |
| Extension doesn't load | Manifest syntax error or missing files | Validate JSON, ensure all file paths exist |
| Console flooded with logs | Too much logging in timeupdate handler | Only log on state changes, not on every tick |

### E. File Dependency Graph

```
manifest.json
  ├── content_scripts (loaded in order, all share window.YouSub namespace):
  │     src/shared/constants.js    ← Loaded first: defines YouSub namespace, constants
  │     src/content/logger.js      ← Logging (used by all other modules)
  │     src/content/page-detector.js
  │     src/content/video-binder.js
  │     src/content/subtitle-extractor.js
  │     src/content/subtitle-parser.js
  │     src/content/overlay.js
  │     src/content/toast.js
  │     src/content/sync-engine.js
  │     src/content/main.js        ← Loaded last: orchestrates everything
  │
  ├── background.service_worker (ES modules, import/export):
  │     src/background/service-worker.js  ← Entry point
  │       ├── import src/background/translator.js
  │       └── import src/background/cache.js
  │
  └── action.default_popup:
        src/popup/popup.html
          ├── src/popup/popup.css
          └── src/popup/popup.js
```

---

> **Status format**: `DONE (YYYY-MM-DD)` · `IN PROGRESS` · `BLOCKED (reason)` · empty = not started
>
> **Milestone key**: M1 = MVP, M2 = Features, M3 = Robustness, M4 = Quality, M5 = Distribution
