# YouSub — Design Decisions

> **Date**: 2026-04-03
> **Status**: Pre-development — 0 problems resolved, 0 design decisions finalized
> **Scope**: Architecture, library choices, algorithm selections, data model designs

---

## Part 1: OPEN Technical Problems

<!-- Use this format for each open problem:

### Problem N — Title

**Status**: OPEN / RESOLVED (YYYY-MM-DD)

**Problem**: Describe the technical problem or question that needs to be resolved.
Include context on why this is important and what depends on the answer.

**Options under consideration**:
1. **Option A** — Description. Pros: ... Cons: ...
2. **Option B** — Description. Pros: ... Cons: ...

**Resolution**: [To be decided]

**References**: Related files, specs, or external resources
-->

*No open problems yet.*

---

## Part 2: RESOLVED Design Decisions

<!-- Use this format for each resolved decision:

### Decision N — Title

**Date**: YYYY-MM-DD
**Status**: RESOLVED

**Problem**: What needed to be decided and why

**Options considered**:
1. **Option A** — Description. Pros: ... Cons: ...
2. **Option B** — Description. Pros: ... Cons: ...

**Resolution**: What was chosen, why, and what was rejected.
Include specific technical details and rationale.

**References**: Related files, sections, or external resources
-->

### Decision 1 — Background Anti-Deadlock Architecture

**Date**: 2026-04-09
**Status**: RESOLVED

**Problem**: The Service Worker (Background Script) was frequently hanging or crashing, causing "Extension context invalidated" errors and infinite loading states. Identified two causes: 1. Background tasks continuing after timeout (Zombie Requests). 2. Heavy storage I/O for logging during intensive translation tasks.

**Options considered**:
1. **Implicit cleanup** — Relying on browser garbage collection. Pros: No code change. Cons: Doesn't work for in-flight fetches.
2. **AbortController + I/O Suppression** — Explicitly killing fetches on timeout and disabling persistent logging during active translation. Pros: Total control over background state. Cons: Loses persistent logs during translation window.

**Resolution**: Option 2 was chosen. 
- Integrated `AbortController` to kill every in-flight fetch when the 55s safety guard triggers.
- `Logger` was modified to skip storage persistence during translation. This eliminated the I/O bottleneck that was deadlocking the Service Worker.

**References**: [logger.js](file:///d:/Xinh/XinhTools/YouSub/src/shared/logger.js), [translator.js](file:///d:/Xinh/XinhTools/YouSub/src/background/translator.js)

### Decision 2 — Payload Management & Recursive Failover

**Date**: 2026-04-09
**Status**: RESOLVED

**Problem**: Multiple API providers (especially Groq) were returning 413 (Payload Too Large) even for small line counts. Additionally, parallel recursive splitting for 413 errors was causing an "API Request Explosion," triggering 429 (Rate Limit) errors and exhausting the key pool.

**Options considered**:
1. **Parallel Splitting** — Split and run sub-batches simultaneously. Pros: Faster. Cons: Destroys Rate Limits.
2. **Sequential Splitting & Context Capping** — Split and run sub-batches one after another. Cap `systemPrompt` context. Pros: Stable, predictable traffic. Cons: Slightly slower for failed batches.

**Resolution**: Option 2 was chosen. 
- Batch splitting for 413 errors is now strictly **sequential** (`await part1; await part2;`).
- Implemented **Pre-flight Payload Estimation**: Bundles are split *before* sending if they exceed 95KB.
- **Context Capping**: Video summary is hard-capped at 500 characters to ensure the `systemPrompt` doesn't consume the entire payload budget.

**References**: [translator.js](file:///d:/Xinh/XinhTools/YouSub/src/background/translator.js)

### Decision 3 — Cancellation of Group B (Feature Scoping)

**Date**: 2026-04-10
**Status**: RESOLVED

**Problem**: Group B features (Subtitle Uploads, General Website Translation) were under consideration to expand the extension's utility. However, these features add significant complexity to the UI and background processing.

**Resolution**: Group B has been **Canceled**. The decision was made to keep YouSub focused strictly on providing a premium, high-performance experience for YouTube. Resources will be reallocated to Phase 49 (Production Readiness) to ensure a stable release on the Chrome Web Store.

**References**: [ROADMAP.md](file:///d:/Xinh/XinhTools/YouSub/ROADMAP.md)

---

## Part 3: Architecture Summary

<!-- Update this checklist as decisions are made:
- [x] Language / Framework chosen: Vanilla JS (EMAScript 2022+)
- [x] State management approach: Message Passing + LocalStorage
- [x] Database / storage strategy: chrome.storage.local
- [x] API / protocol design: Custom Message Protocol
- [x] Authentication / authorization: API Key BYOK (Bring Your Own Key)
- [x] Testing strategy: Jest + Manual Verification
- [x] Deployment / distribution: Unpacked Extension / ZIP Packaging
- [x] Logging / monitoring: JSONL Logger (LocalStorage)

---

> This document tracks all technical problems and design decisions for YouSub.
> When Gemini starts a new session, it reads this file to understand past decisions and avoid re-proposing rejected approaches.
> **When to record**: Architecture choices, library selections, algorithm choices, data model designs — anything where "why did we do it this way?" might be asked later.