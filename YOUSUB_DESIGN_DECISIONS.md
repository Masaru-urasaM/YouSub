# YouSub — Design Decisions

Record of significant technical decisions — architecture, library choices, algorithm selections, data model designs.

---

### Decision 1 — Subtitle Interception Strategy
**Date**: 2026-04-03
**Status**: RESOLVED

**Problem**: How does the content script get the subtitle data from YouTube?

**Options considered**:
1. **Option A (Inject `<script>` into MAIN world)** — Pros: Simple, works for SPA navigation. Cons: Relies on internal YouTube variable `ytInitialPlayerResponse`.
2. **Option B (Use `chrome.scripting.executeScript`)** — Pros: Official MV3 API. Cons: Requires `scripting` permission, needs message passing.
3. **Option C (Parse HTML `<script>` tags)** — Pros: No MAIN world access needed. Cons: Fragile regex, fails on SPA navigation.

**Resolution**: Chose **Option A**. It's reliable for SPA navigation, easy to implement, and standard for YouTube extensions. Will use postMessage to pass data out.

---

### Decision 2 — Translation API
**Date**: 2026-04-03
**Status**: RESOLVED

**Problem**: Which translation API to use, how to handle future expansions like LLM integration?

**Options considered**:
1. **Option A (Lingva Proxy)** — Pros: Free, no API key required, good for dev. Cons: Unofficial.
2. **Option B (Google Cloud/DeepL)** — Pros: Official, reliable. Cons: Requires API keys and limits.

**Resolution**: Chose **Option A (Lingva API)** for the initial MVP to facilitate rapid development.  
*Future adjustment*: We will implement a custom API Key interface later so the system can use external LLM Providers (giving the best context and quality). A new phase (Phase 13.5) has been added to the Roadmap to handle adding LLM translation backends where the user inputs their own API key.

---

### Decision 3 — Translation Strategy (Bulk vs Real-time)
**Date**: 2026-04-03
**Status**: RESOLVED

**Problem**: Translate the ENTIRE transcript upfront, or translate chunks as they are needed?

**Options considered**:
1. **Option A (Bulk upfront)** — Pros: Fast after initial load, no mid-video network latency, simple to implement. Cons: Translates unnecessary parts if user leaves video early.
2. **Option B (Chunk demand)** — Pros: Saves quota. Cons: Complex buffering, network delay while watching.

**Resolution**: Chose **Option A (Bulk upfront)**. Subtitle files are extremely lightweight (few KBs), reducing network calls is beneficial and guarantees smooth playback without buffering stutters.

---

### Decision 4 — Overlay Injection Target
**Date**: 2026-04-03
**Status**: RESOLVED

**Problem**: Where to inject the subtitle overlay `<div>` on the page?

**Options considered**:
1. **Option A (`#movie_player`)** — Pros: Automatic inheritance of YouTube's full-screen state and bounding box. Cons: YouTube modifying its children is a risk.
2. **Option B (`#player-container`)** — Pros: More stable. Cons: May break full-screen UI overlap.

**Resolution**: Chose **Option A (`#movie_player`)**. The immediate compatibility with full-screen mode makes this the most robust choice.
---

### Decision 5 — Background Fetch Proxy
**Date**: 2026-04-03
**Status**: RESOLVED

**Problem**: Content scripts in Manifest V3 often face restrictive CSP (Content Security Policy) and CORS issues when fetching YouTube's internal APIs (like timedtext), resulting in 0-byte responses or network errors (ERR_NAME_NOT_RESOLVED).

**Options considered**:
1. **Option A (Direct fetch in Content Script)** — Pros: Simpler code. Cons: Unreliable, easily blocked by page-level security policies.
2. **Option B (Proxy fetch via Background Script)** — Pros: Most robust. Background scripts (Service Workers) have elevated privileges and aren't subject to the same page-level CSP. Cons: Requires message passing overhead.

**Resolution**: Chose **Option B (Proxy fetch via Background Script)**. This resolved the 0-byte response issue and provides a unified, reliable way to fetch external resources across the extension.

---

### Decision 6 — Manifest V3 Centralized Logging
**Date**: 2026-04-03
**Status**: RESOLVED

**Problem**: Rule 9 requires structured JSON Lines (`.jsonl`) debug logging with a ring-buffer rotation of log files. However, Manifest V3 extensions execute in an isolated environment without native File System access (`fs`), making continuous hard-disk writes impossible without intrusive native messaging hosts or user intervention (File System Access API).

**Options considered**:
1. **Option A (IndexedDB / File API)** — Pros: Persistent storage for large log datasets. Cons: Highly complex asynchronous flow, hard to export for the developer quickly.
2. **Option B (Console JSON dumping & `chrome.storage.local`)** — Pros: Directly fulfills Rule 9 by outputting strict JSON strings to the Chrome DevTools console while keeping a lightweight in-memory/storage buffer accessible from the popup. Cons: Exceeds 5MB quota if not bound.

**Resolution**: Chose **Option B**. Created `src/shared/logger.js`. It limits logs to 1000 bounds inside `chrome.storage.local` to remain under quota limits. This is the optimal architecture for diagnosing API/Network issues like the Lingva HTTP 429 throttling bug.

---

### Decision 7 — Shared Module Strategy (ES Modules Everywhere)
**Date**: 2026-04-03
**Status**: RESOLVED

**Problem**: The `providers-registry.js` file (and other shared data modules) must be consumed by both the Background Service Worker (which requires ES modules in MV3) and the Options/Popup pages. Content scripts in MV3 `content_scripts` manifest do NOT support ES modules natively.

**Options considered**:
1. **Option A (IIFE + window global)** — Pros: Works in content scripts natively. Cons: Cannot `import` in Background Worker; would need duplicated code or a build step.
2. **Option B (Hybrid UMD)** — Pros: Single file works in both environments via `if (window) window.X = X; export default X;`. Cons: Fragile pattern, `export` keyword causes SyntaxError in classic `<script>` tags, requires careful `type="module"` tagging everywhere.
3. **Option C (All ES Module)** — Pros: Clean, modern, no hacks. Service Worker is already module. Popup/Options use `<script type="module">`. Content scripts don't need shared modules directly — they get data from Background via `chrome.runtime.sendMessage()`. Cons: Content scripts cannot import modules directly; must use message passing or dynamic `import()` workaround for future needs.

**Resolution**: Chose **Option C (All ES Module)**. This is the cleanest architecture:
- Service Worker: already `"type": "module"` in manifest ✅
- Options Page: `<script type="module">` ✅
- Popup: `<script type="module">` (when it needs imports) ✅
- Content Scripts: remain classic (IIFE). They do NOT import shared modules directly. If they need provider data in the future, they request it from the Background Worker via message passing.

**References**: `providers-registry.js`, `options.js`, `service-worker.js`

---

### Decision 8 — Transition to Multi-Provider LLM Engine (BYOK)
**Date**: 2026-04-03
**Status**: RESOLVED

**Problem**: The initial Lingva (Option A in Decision 2) proved unreliable due to frequent HTTP 429 rate-limiting. Users need high-quality, professional-grade translations.

**Options considered**:
1. **Option A (Central Proxy)** — Pros: Easy for user. Cons: High cost for developer, privacy risks.
2. **Option B (Bring Your Own Key - BYOK)** — Pros: Zero cost for developer, maximum privacy, users choose their model/tier. Cons: Higher friction for non-technical users.

**Resolution**: Chose **Option B (BYOK)**. Implemented a robust provider registry supporting OpenAI, Gemini, Anthropic, etc. This ensures the extension scales infinitely without developer cost and provides the highest translation quality.

---

### Decision 9 — Provider Health & Failover (Circuit Breaker)
**Date**: 2026-04-03
**Status**: RESOLVED

**Problem**: LLM APIs can fail (invalid keys, rate limits, server downtime). A single failure shouldn't break the user's viewing experience.

**Options considered**:
1. **Option A (Simple Retry)** — Pros: Simple. Cons: Wastes quota on known-bad keys.
2. **Option B (Health Monitoring + Circuit Breaker)** — Pros: Smartly skips failing keys, uses backups, provides visual health status. Cons: More complex state management.

**Resolution**: Chose **Option B**. Implemented `HealthManager` to track success rates and average latency. If a key fails too many times, the "circuit opens" and it is skipped for a cooldown period (10 minutes).

---

### Decision 10 — Dual Subtitle Layout (Vertical Stack)
**Date**: 2026-04-03
**Status**: RESOLVED

**Problem**: Language learners want to see both translated and original text. How to display both without cluttering the screen?

**Options considered**:
1. **Option A (Side-by-side)** — Pros: Good for short lines. Cons: Awful for mobile/narrow players, breaks centering.
2. **Option B (Vertical Flexbox Stack)** — Pros: Natural reading flow, handles varying line lengths, maintains centered alignment.

**Resolution**: Chose **Option B**. The overlay uses `display: flex; flex-direction: column;` with the translated text prominent and original text subtle (smaller/gray).

---

### Decision 11 — Real-time Style Reactivity
**Date**: 2026-04-03
**Status**: RESOLVED

**Problem**: Users should see UI changes (font size, color) instantly without refreshing the YouTube page.

**Options considered**:
1. **Option A (Message Passing)** — Pros: Direct. Cons: Need to track every active tab.
2. **Option B (`chrome.storage.onChanged`)** — Pros: Automatic broadcast to all content scripts. Very "Manifest V3" native. Cons: Slight delay (negligible).

**Resolution**: Chose **Option B**. Content scripts listen for `yousub_appearance` changes and call `applyStyles()` immediately. This provides a "Premium" live-editing experience.

---

### Decision 12 — In-Player Status Feedback (Toast System)
**Date**: 2026-04-04
**Status**: RESOLVED

**Problem**: The extension takes time to extract and translate. "Silent" operation makes the user wonder if it's working.

**Options considered**:
1. **Option A (Popup-only status)** — Pros: Simple. Cons: Popup closes when user clicks away, losing the status updates.
2. **Option B (On-video Toasts)** — Pros: User sees progress (Extracting... Translating...) while watching. Professional feel.

**Resolution**: Chose **Option B**. Added a categorized (Info/Success/Warning/Error) toast system to `Overlay` that renders temporary messages above the subtitles.

### Decision 13 — Hybrid Extraction Architecture

**Date**: 2026-04-04
**Status**: RESOLVED

**Problem**: YouTube has different ways of providing subtitles (XHR vs. DOM Transcript Panel) and different page types (Watch vs. Shorts). Relying solely on DOM Scraping is slow because it requires opening/closing the Transcript panel and doesn't work on Shorts (no "Show transcript" button).

**Options considered**:
1. **Pure DOM Scraping** — Pros: Robust against bot detection. Cons: Slow, intrusive, doesn't work on Shorts.
2. **Pure Background Fetch** — Pros: Silent, fast. Cons: Aggressive bot detection (403/POT tokens required).
3. **Hybrid Extraction (Page Context XHR + DOM Fallback)** — Pros: Fast and silent when possible, works on Shorts, fallback to DOM if XHR is blocked. Cons: More complex state management.

**Resolution**: Adopted **Option 3**. The pipeline now uses the `MAIN` world (page context) to perform an XHR request with credentials. This mimics YouTube's internal behavior and bypasses Service Worker interception. If this fails, the system automatically triggers the "Legacy" DOM Scraping logic to open the transcript panel and cào data.

**References**: `main.js`, `main-world-fetcher.js`, `main-world-extractor.js`.

---
 
 ### Decision 14 — Cross-Browser Polyfill Strategy
 **Date**: 2026-04-04
 **Status**: RESOLVED
 
 **Problem**: How to support Chrome (chrome.*) and Firefox (browser.*) without duplicating code?
 
 **Options considered**:
 1. **Option A (Manual Wrapper)** — Pros: Tiny footprint. Cons: High maintenance.
 2. **Option B (webextension-polyfill)** — Pros: Industry standard, Promise-based, robust.
 
 **Resolution**: Chose **Option B**. Integrated `webextension-polyfill` as a no-build dependency. This allows us to use the standard `browser.*` namespace everywhere, đảm bảo extension hoạt động trên tất cả trình duyệt chính với một bộ code duy nhất.
 
 ---
 
 ### Decision 15 — Packaging and Distribution
 **Date**: 2026-04-04
 **Status**: RESOLVED
 
 **Problem**: Production releases need to exclude development files (tests, node_modules) and be versioned correctly.
 
 **Options considered**:
 1. **Option A (Manual Zipping)** — Pros: No tools needed. Cons: Error-prone, inconsistent.
 2. **Option B (Node.js Build Script + adm-zip)** — Pros: One-click release, consistent file structure, automatic versioning từ manifest.
 
 **Resolution**: Chose **Option B**. Created `scripts/package.js` sử dụng `adm-zip`. Điều này cho phép quy trình phát hành chuyên nghiệp (`npm run package`).

---

### Decision 16 — Numbered Envelope Strategy for Translation

**Date**: 2026-04-05
**Status**: RESOLVED (Tuning)

**Problem**: Advanced LLMs (Groq/Llama 3.3) often merge individual subtitle lines into coherent paragraphs (prose) to be "helpful," breaking the strict line-count requirement needed for synchronization.

**Options considered**:
1. **Single-line requests** — Pros: 100% structural accuracy. Cons: Extremely slow, exceeds rate limits immediately.
2. **Numbered Envelopes (N| Text)** — Pros: Forces the model to distinguish lines, easy to parse, handles empty lines. Cons: Slightly more tokens per request.
3. **JSON Schema** — Pros: Strict structure. Cons: High token overhead, some models hallucinate keys or escape quotes inconsistently.

**Resolution**: Chose **Option 2 (Numbered Envelopes)** combined with a reduced batch size (20 lines). This provides a balance between speed and structural integrity by giving the model a numeric anchor for every line.

**References**: [translator.js](file:///d:/Xinh/XinhTools/YouSub/src/background/translator.js), [CHANGELOG.md](CHANGELOG.md)

---

### Decision 17 — Full-Transcript Context Strategy
**Date**: 2026-04-06
**Status**: RESOLVED

**Problem**: 20-30 line batches often lose the "big picture" of a video, leading to inconsistent pronoun usage or contextually irrelevant translations. Initial 300-line samples were too narrow for long-form content.

**Resolution**: Chose **Option: Entire Transcript Analysis**. The system now performs a preliminary API call on the *full* transcript (no matter how long) to generate a concise summary. This summary is injected into every subsequent translation batch. This ensures thematic coherence and correct terminology throughout the entire video.

---

### Decision 18 — Unfiltered & Uncapped Translation
**Date**: 2026-04-06
**Status**: RESOLVED

**Problem**: Standard LLM tuning often censors "offensive" language or attempts to be "helpful" by summarizing or smoothing out vulgar content. Additionally, default `max_tokens` limits (1000-2000) frequently cut off responses when batch sizes were increased to 100 lines.

**Resolution**: 
1. **Uncensored Prompting**: Modified the `systemPrompt` to explicitly command AI to be "Unfiltered & Faithful," mandating the preservation of all profanity and vulgarity. 
2. **Uncapped Output**: Set `max_tokens` to an effectively infinite value (100,000) and removed artificial code-level minimums. This prioritizes completeness over token conservation, ensuring the entire subtitle batch is translated without interruption.

**References**: `translator.js`, `providers.js`
