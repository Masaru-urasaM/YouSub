# YouSub

Real-time AI subtitle translator for YouTube. YouSub intercepts YouTube's native
transcript tracks, translates them with your own LLM API keys (BYOK,
multi-provider), and renders a synced, customizable subtitle overlay on the
player — including a dual (original + translated) mode.

> **Status**: Shipped — **v0.2.2** (Chrome Web Store). Manifest V3, vanilla
> JavaScript ES modules, **no build step**. This repository is private.

---

## Tech stack

- **Manifest V3** browser extension (Chrome primary; Firefox/Edge/Brave compatible via the vendored `webextension-polyfill`).
- **Vanilla JavaScript (ES2020+ ESM)** — no bundler/transpiler. Content scripts are loaded by a single entry (`src/content/loader.js`) that dynamic-`import()`s the ESM module graph; `window.YouSub` is a compatibility shim.
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

[GNU AGPL-3.0-only](LICENSE).
