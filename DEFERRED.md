# YouSub — Deferred Items

> Track deferred features and tasks per CLAUDE.md Rule 8.
> Review at milestone starts — flag items whose dependencies are now met.
> Remove when implemented.

---

### D1 — B1 error-toast `esc()` escaping unit test

**Deferred**: 2026-06-23 (Phase 66)
**Effort**: Small
**Why**: The `esc()` helper hardened in Phase 66 (B1) is an un-exported closure inside `src/content/main.js`. The Jest harness cannot currently load that content script (the same ESM/`eval()` blocker that fails `sync-engine.test.js`), so the escaping behavior cannot be unit-tested in isolation without exporting internals (disproportionate for a 3-line helper).
**Dependency**: Phase 68 — replace the `eval()`-based content-script test loader with dynamic `import()`, which makes `main.js` (or an extracted/exported `esc`) testable.
**Revisit when**: Phase 68 lands. Add a test feeding crafted failure messages (e.g. `try again in <script>…`, `Limit 100, Used <img onerror=…>`) and assert the rendered Overlay HTML is entity-escaped.

### D2 — Options "Appearance" tab may not populate the form from saved settings

**Deferred**: 2026-06-24 (Phase 67b)
**Effort**: Small
**Why**: Phase 67b removed a never-called `loadAppearance()` from `src/options/tab-appearance.js` (confirmed dead — no references repo-wide). Its existence suggests the Appearance form was meant to populate its inputs from `yousub_appearance` storage on open, but it was never wired. Current behavior: the form shows the HTML default values; the actual subtitle overlay still reads saved appearance from storage, so the end-user appearance works — only the settings *form* may not reflect saved values.
**Dependency**: none (independent UI fix).
**Revisit when**: Phase 76 (UI/UX polish + a11y). Re-add appearance-form population on tab open (read `yousub_appearance`, set inputs, call `updatePreview()`), or confirm it is intentional.
