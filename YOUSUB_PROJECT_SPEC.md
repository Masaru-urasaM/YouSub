# YouSub — Complete Project Specification

> **Document purpose**: This is the single source of truth for the YouSub project. It is written as an AI-readable prompt/specification so that any AI coding assistant (Gemini, Claude, etc.) can read this document and understand the full scope, architecture, decisions, and constraints of the project. It is also readable by human developers.
>
> **Document version**: 1.3
> **Last updated**: 2026-04-04
> **Status**: **STABLE** — Final v0.1.0 (Production-Ready)
>
> **Structure**: This file is a navigation hub. Detailed specifications live in `specs/` subdirectory. Each section below either contains the full specification (for compact, cross-cutting content) or provides a summary with a link to the detail file.

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

## 2. Architecture Overview

### 2.1 System Design
```text
┌───────────────────────────────────────────────┐
│           YouSub Browser Extension            │
├──────────────────────┬────────────────────────┤
│   Content Script     │   Background Worker    │
│  (DOM & UI Overlay)  │ (API & Network calls)  │
├──────────────────────┴────────────────────────┤
│          YouTube Video Player DOM             │
└───────────────────────────────────────────────┘
```

### 2.2 Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Languages | HTML, CSS, Vanilla JS | Keeping it lightweight without heavy JS frameworks |
| Extension API | Manifest V3 | Standard WebExtension APIs |
| State Management | `chrome.storage` API | For user settings (language choice, UI pref) |
| Translation | External API | [OPEN QUESTION] Google Translate, DeepL, or bypass |

---

## 3. Feature Specifications

### 3.1 Subtitle Extraction
**Summary**: Uses a MAIN world injection strategy to trigger and scrape the YouTube Transcript Panel DOM. This bypasses Bot Detection (POT Tokens) and CORS issues that plague direct JSON/XML fetch attempts.

### 3.2 Translation Engine
**Summary**: A "Bring Your Own Key" (BYOK) multi-provider engine supporting OpenAI, Gemini, Anthropic, etc. Features Batch Translation (preserving line counts), failover intelligence, and a circuit-breaker health management system.

### 3.3 Dynamic Overlay Controller
**Summary**: An high-performance injected `<div>` overlapping the YouTube video frame. Features **Glassmorphism** for premium aesthetics and hardware-accelerated **Fade/Slide transitions**. Listens to the HTML5 `<video>` tag's `timeupdate` event to render translated text precisely on cue with $O(1)$ lookup performance.

### 3.4 Cross-Browser Engine
**Summary**: Unified codebase supporting **Chrome, Firefox, and Edge**. Uses `webextension-polyfill` to provide a standardized `browser.*` namespace and handles hybrid background scripts (Service Worker vs. Event Script) seamlessly.

---

## N. Development Roadmap

→ See [ROADMAP.md](ROADMAP.md) for the full phase tracking table.

---

## Document Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-04-03 | Initial template |
| 1.1 | 2026-04-03 | Added core goals, features, and context based on user specification |
| 1.2 | 2026-04-04 | Updated with Cross-Browser support and Health Monitoring |
| 1.3 | 2026-04-04 | Final v0.1.0 - Premium UI, Automated Packaging, Documentation COMPLETE |