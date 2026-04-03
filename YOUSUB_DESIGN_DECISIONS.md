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
