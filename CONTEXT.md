# YouSub — Context and Background

> **Purpose**: This document provides the high-level reasons, goals, and desired outcomes of the YouSub project. It captures *why* the project exists so the developer and AI can remain aligned on the core mission.

## 1. Background
The creator of YouSub is a solo developer building a cross-browser WebExtension (Chrome Desktop, Firefox Desktop, and Firefox for Android Mobile) to solve two major pain points on YouTube:
1. **Real-Time AI Subtitle Translation**: Translating YouTube transcripts (or generating subtitles for uncaptioned videos) using the user's own LLM API keys (BYOK) with a customizable dual-subtitle overlay.
2. **Bulletproof Long-Form Audio/Video Playback Auto-Resume & Cross-Device Sync**: Automatically saving and restoring exact playback positions across Desktop (`www.youtube.com`) and Mobile (`m.youtube.com`) — specifically engineered for multi-hour audiobooks, podcasts, and lectures (10–50+ hours) where YouTube's native resume feature frequently fails or resets progress to `0:00`.

## 2. The Core Goals
1. **Real-Time Subtitle Translator**:
   - Access YouTube's native transcripts/subtitles (via silent Innertube APIs, DOM scraping fallback, `.srt`/`.vtt` import, or Gemini video URL fallback) while the video is playing.
   - Coalesce fragmented cues, translate them via multi-provider LLM batching with seek-aware priority, and render a synced, customizable overlay.
2. **Cross-Platform Playback Auto-Resume & Audio Bookmarking Suite (PC + Firefox Mobile)**:
   - Run seamlessly on both Desktop (`www.youtube.com`) and Firefox for Android (`m.youtube.com`), completely independent of whether subtitle translation is active.
   - Continuously persist playback progress locally (`storage.local`), across same-browser profiles (`storage.sync`), and across Chrome ↔ Firefox via the user's logged-in YouTube account (`startSeconds` + hardened `/api/stats/watchtime` sync).
   - Protect multi-hour audio listeners against accidental seek jumps, `0:00` page-reload overwrites, and falling asleep while playback runs to 100%.

## 3. Reasons (The "Why")
- **Limitations of Native Subtitle Features**: YouTube's native auto-translate is rigid, poorly formatted, and lacks dual-language display or LLM contextual quality.
- **Unreliability of YouTube's Native Playback Resume on Long Audio/Videos**:
  - **The `0:00` Overwrite Bug**: When reopening a 20–50 hour audiobook on mobile or desktop, network lag, ad insertion, or mobile tab eviction often initializes the player at `0:00`. Within 1–2 seconds, YouTube's player fires a `/api/stats/watchtime` ping at `0:01`, permanently overwriting the user's 15-hour progress on YouTube's servers.
  - **The >95% Completion Reset (Sleep Hazard)**: Audiobook listeners frequently fall asleep while the video plays to the end. Once playback crosses ~95% duration, YouTube marks the video as "Watched" and resets future playback to `0:00`, leaving the user with no idea where they were before falling asleep.
  - **Mobile OS Suspension & Adblockers**: On Firefox Mobile, locking the screen or switching apps suspends network requests before YouTube's periodic `watchtime` heartbeat fires; furthermore, privacy filters (uBlock Origin / Firefox Enhanced Tracking Protection) frequently block `s.youtube.com/api/stats/watchtime`.
- **Personal Need & Total Control**: By embedding a multi-tier resume engine directly into YouSub, the developer guarantees zero lost progress across PC and Firefox Mobile while keeping a strict zero-third-party-server privacy posture.

## 4. Desired Outcomes
- **A Working Cross-Browser Manifest V3 Extension**: Live on [Firefox Add-ons (AMO)](https://addons.mozilla.org/addon/yousub/) at **v0.2.5** (`yousub@xinh.tools`, Desktop + Firefox for Android `gecko_android >= 128.0`) and shipped on [Chrome Web Store](https://chromewebstore.google.com/detail/yousub/jlpgmjpekhnlncfdkmddoienleiljehk) (`v0.2.0` live; `v0.2.5` resubmitted & `Pending review`).
- **Efficient Data Interception & Silent Extraction**: Captures YouTube's subtitle payloads and player metadata on both `www.youtube.com` and `m.youtube.com` without CORS errors or visible UI flashes.
- **Accurate & Reliable Translation**: Robust BYOK LLM translation engine with failover intelligence, semantic sentence coalescing, and seek-aware batch prioritization.
- **Bulletproof Playback Auto-Resume & Sync**:
  - **4-Timestamp Safety Net per Video**: Tracks `lastTimeSec` (latest playhead), `furthestTimeSec` (high-water mark immune to accidental backward seeks), `lastInteractionTimeSec` (playhead at last real user interaction to recover from falling asleep), and rolling 30-minute `checkpoints` + manual 1-tap `bookmarks`.
  - **3-Tier Cross-Device Sync**: Instant 3-second local persistence (`storage.local`) + debounced browser profile sync (`storage.sync`) + hardened YouTube Account Watchtime sync (`window.location.origin + '/api/stats/watchtime'` with `0:00` overwrite blocking and `>95%` completion clamping) so switching between Chrome PC and Firefox Mobile under the same YouTube account resumes seamlessly.
  - **Non-Intrusive On-Video & Popup UX**: Smart rewind (`-3s` on resume), compact on-video status toast with quick-jump pills (`[0:00]`, `[Furthest]`, `[Last Active]`), and a dedicated Popup/Options manager for recent audiobooks and bookmarks.
