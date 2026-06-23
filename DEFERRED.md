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
