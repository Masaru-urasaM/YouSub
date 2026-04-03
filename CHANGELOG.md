# Changelog

All notable changes to the YouSub project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
