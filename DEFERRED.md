# Deferred Items

Items deferred for later implementation. Each entry includes context and estimated effort.

## Shorts Extraction Resilience

**Context**: Some YouTube Shorts (e.g., specific English-language Shorts) do not show the "Show transcript" button in their description menu, and the metadata extraction logic is currently failing to retrieve a valid `baseUrl` for these tracks on certain videos, resulting in "Could not find subtitles" errors.

**What's needed**: 
- Research why `ytd-reel-video-renderer[is-active]` metadata is incomplete for some videos.
- Investigate if these videos use a different caption delivery mechanism (e.g., protobuf or streaming VTT) that isn't captured in the standard `playerResponse`.
- Implement a more robust track selection logic that handles cases where only auto-generated tracks are available but hidden.

**Effort**: Medium (Requires deep DOM/Network reverse engineering of specific Shorts).

**Reference**: `src/content/main-world-extractor.js`, `src/content/subtitle-parser.js`.

**Priority**: High (Revisit after stabilizing Phase 50 features).