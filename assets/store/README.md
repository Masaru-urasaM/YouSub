# YouSub Store Listing Visual Media Kit (`v0.2.6+`)

All assets in `assets/store/` are excluded automatically from Chrome/Firefox release ZIP packages by [`scripts/package.js`](../../scripts/package.js).

## Included Store Screenshots (`1280x800` PNG)

| File | Feature Focus | Dimensions |
|------|---------------|------------|
| [`01-dual-subtitles.png`](01-dual-subtitles.png) | Real-Time Dual Subtitles Overlay, Smart Auto-Enable & No-Caption AI Fallback | `1280x800` |
| [`02-audiobook-resume-sleep.png`](02-audiobook-resume-sleep.png) | 3-Tier Audiobook Auto-Resume, 5s Fade-Out Sleep Timer, Bookmarks & A–B Loop | `1280x800` |
| [`03-mobile-drawer-android.png`](03-mobile-drawer-android.png) | Firefox for Android In-Page Floating Pill & Glassmorphism Bottom Sheet (`m.youtube.com`) | `1280x800` |
| [`04-sparrow-pipeline-visualizer.png`](04-sparrow-pipeline-visualizer.png) | Live Sparrow 5-Stage Telemetry Visualizer & Seek-Priority Batch Queue | `1280x800` |
| [`05-byok-presets-glossary.png`](05-byok-presets-glossary.png) | Translation Style Presets, Custom Glossary, 30s BYOK Wizard & 30-Day Cache Savings | `1280x800` |

## Animated Demo & Source Deck

- [`yousub-demo.gif`](yousub-demo.gif) (`960x600`, 20-frame looping crossfade walkthrough, ~1.79 MB) — suitable for Firefox AMO gallery upload and GitHub README showcase.
- [`showcase.html`](showcase.html) (`?slide=1` .. `?slide=5`) — reproducible source slides rendered via Chromium headless (`--window-size=1280,800 --force-device-scale-factor=1`).

## Store Upload Notes

- **Chrome Web Store Developer Console**: Upload the 5 `1280x800` PNG screenshots directly under **Store listing → Screenshots** (recommended up to 5 screenshots, 1280×800 or 640×400, PNG/JPEG without alpha issues).
- **Firefox Add-ons (AMO) Edit Listing**: Upload the 5 `1280x800` PNG screenshots and/or `yousub-demo.gif` under **Manage Status & Listing → Images**.
