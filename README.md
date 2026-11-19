# YouSub

Real-time AI subtitle translator & Audio/Long-Video Auto-Resume for YouTube. YouSub intercepts YouTube's native transcript tracks (or falls back to Gemini / local `.srt`/`.vtt`), translates them with your own LLM API keys (BYOK, multi-provider), renders a synced, customizable dual-subtitle overlay, and automatically preserves & syncs exact playback positions across Chrome, Firefox Desktop, and Firefox for Android (`m.youtube.com`).

> **Status**: **Live v0.2.5 / Submitted v0.2.6** on [Firefox Add-ons (Desktop + Android)](https://addons.mozilla.org/addon/yousub/); **Live v0.2.0 / v0.2.5 Pending Review (`v0.2.6` ZIP staged locally)** on [Chrome Web Store](https://chromewebstore.google.com/detail/yousub/jlpgmjpekhnlncfdkmddoienleiljehk) (**773/773 tests**, 51 suites). Manifest V3, vanilla JavaScript ES modules, **no build step**. Open source under GNU AGPL-3.0-only.

---

## Tech stack

- **Manifest V3** browser extension (Chrome Desktop, Firefox Desktop, Firefox for Android >= 128.0, Edge, Brave via the vendored `webextension-polyfill`).
- **Vanilla JavaScript (ES2020+ ESM)** — no bundler/transpiler. Declarative `"world": "MAIN"` helpers handle page-context YouTube Innertube extraction & on-device translation (`src/content/main-world-*.js`), while isolated content scripts load via `src/content/loader.js` dynamic-`import()`ing the ESM module graph (`window.YouSub` kept as a compatibility shim).
- **Background service worker** (`type: module`) hosts the multi-provider translation engine, key failover, health/circuit-breaker, and translation cache.
- **Tests**: Jest + jsdom (`node --experimental-vm-modules`).
- **Tooling**: ESLint 9 (flat config) + Prettier, EditorConfig, `.nvmrc` (Node 22), husky + lint-staged pre-commit hook.

## Develop

```bash
npm install            # install dev dependencies + register the git hook
npm test               # run the unit suite (jsdom) with the coverage gate
npm run lint           # ESLint
npm run format         # Prettier --write
npm run package        # build dist/ ZIPs for Chrome + Firefox
npm run verify         # run lint + format:check + test:log + package
npm run publish:dry-run # verify store ZIPs & API credentials without uploading
npm run publish:stores  # upload & submit dist/ ZIPs via CWS API v2 + AMO API v5
```

**Load the unpacked extension** (for manual testing): open `chrome://extensions`,
enable Developer Mode, "Load unpacked", and select the repository root.

Provide your own LLM API key(s) in the extension's Options page, open a YouTube
video, and start translation from the popup.

## Privacy

YouSub is **BYOK** (bring your own key). To translate, it sends the video's
transcript text to the third-party LLM provider(s) you configure (e.g. OpenAI,
Google, Anthropic, Groq, etc.). API keys are stored locally in
`chrome.storage.local`. No data is sent to any first-party YouSub server (there
isn't one). See the privacy policy for details.

## Documentation

| File | Purpose |
|------|---------|
| [`YOUSUB_PROJECT_SPEC.md`](YOUSUB_PROJECT_SPEC.md) | Architecture, data flow, file map — the spec hub |
| [`ROADMAP.md`](ROADMAP.md) | Active / upcoming work |
| [`ROADMAP_DONE.md`](ROADMAP_DONE.md) | Completed phases |
| [`YOUSUB_DESIGN_DECISIONS.md`](YOUSUB_DESIGN_DECISIONS.md) | Resolved design decisions |
| [`CHANGELOG.md`](CHANGELOG.md) | Change history by phase |
| [`DEFERRED.md`](DEFERRED.md) | Deferred items |
| [`CLAUDE.md`](CLAUDE.md) | AI-assistant working rules |

## License

[GNU AGPL-3.0-only](LICENSE) — Strong copyleft: anyone who distributes or hosts modified versions over a network must disclose the corresponding source code under AGPL-3.0.
