# YouSub — Deferred Items

> Track deferred features and tasks per CLAUDE.md Rule 8.
> Review at milestone starts — flag items whose dependencies are now met.
> Remove when implemented.

---

### D1 — B1 error-toast `esc()` escaping unit test

**Deferred**: 2026-06-23 (Phase 66) · **Updated**: 2026-06-24 (Phase 68) — re-pointed to Phase 75
**Effort**: Small
**Why**: The `esc()` helper hardened in Phase 66 (B1) is an un-exported closure inside `src/content/main.js`. Phase 68 cleared the original blocker (the `eval()`-based content-script loader is gone — clean ESM modules like `sync-engine`/`subtitle-parser` are now importable in tests). **However**, `main.js` is the content-script *entry*: importing it runs top-level side effects (`TrustedTypes.init()` and a `chrome.runtime.onMessage.addListener`), which would wire global listeners into the jsdom env and risks destabilizing the now-green suite. Testing `esc()` in isolation still requires extracting it (e.g. to `shared/utils.js` next to `sanitizeKey`) — a behavior-preserving refactor, not a test-only change.
**Dependency**: Phase 75 (`translator.js` / content-script refactor) — extract `esc()` to a small exported util as part of that pass.
**Revisit when**: Phase 75 lands. Then add a test feeding crafted failure messages (e.g. `try again in <script>…`, `Limit 100, Used <img onerror=…>`) and assert the escaped output is entity-encoded.

### D2 — Options "Appearance" tab may not populate the form from saved settings

**Deferred**: 2026-06-24 (Phase 67b)
**Effort**: Small
**Why**: Phase 67b removed a never-called `loadAppearance()` from `src/options/tab-appearance.js` (confirmed dead — no references repo-wide). Its existence suggests the Appearance form was meant to populate its inputs from `yousub_appearance` storage on open, but it was never wired. Current behavior: the form shows the HTML default values; the actual subtitle overlay still reads saved appearance from storage, so the end-user appearance works — only the settings *form* may not reflect saved values.
**Dependency**: none (independent UI fix).
**Revisit when**: Phase 76 (UI/UX polish + a11y). Re-add appearance-form population on tab open (read `yousub_appearance`, set inputs, call `updatePreview()`), or confirm it is intentional.

### D3 — `Providers.chat()` timeout-message says "30s" but default is 15s

**Deferred**: 2026-06-24 (Phase 69)
**Effort**: Small
**Why**: Found while unit-testing `providers.js`. `Providers.chat()` (src/background/providers.js:336-337) defaults `timeoutMs` to **15000** but the default `timeoutMsg` reads "Request timed out (30s)". On a real 15s abort the user-facing message would wrongly say "(30s)". Cosmetic only — no functional impact; not fixed in Phase 69 (test-only phase, no `src/` changes).
**Dependency**: none.
**Revisit when**: Phase 75 (translator/providers touch-up) — align the message with the actual default, or make the message derive from `timeoutMs`. Also note two effectively-dead defensive branches confirmed during testing (`chat()` "Unknown API style" return, `fetchQuota()` trailing `return null`) — harmless, reachable only if the provider registry loses a valid `apiStyle`/endpoint.
