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

### D2 — Options "Appearance" tab form population — RESOLVED (no action needed)

**Deferred**: 2026-06-24 (Phase 67b) · **Resolved**: 2026-06-25 (Phase 76)
**Outcome**: Investigated in Phase 76 — the premise was stale. `tab-appearance.js` already has a working `loadSettings()` that is called from `initAppearanceTab()` and populates all inputs (font-size / font-color / bg-opacity / pos-bottom) + their value displays + the live preview from `yousub_appearance` storage `{fontSize, fontColor, bgOpacity, posBottom}`. The removed `loadAppearance()` was a genuinely-dead duplicate, not the live populator. No fix required; only the `chrome.→browser.` swap was applied on that file in Phase 76.

### D7 — Deduplicate shared modal/button CSS (Phase 76b, deferred)

**Deferred**: 2026-06-25 (Phase 76)
**Effort**: Medium
**Why**: `src/popup/popup.css` (491 lines) and `src/options/options.css` (753 lines) duplicate modal-overlay/button/`.secondary-btn`/`.danger-btn` rules. Extracting them into a shared stylesheet is maintainability-only (no user-facing change) and risky to do safely without **visual regression testing** (CSS specificity/cascade differences between the two contexts could shift the look). Phase 76 delivered the user-facing wins (a11y + hygiene) instead.
**Dependency**: a way to visually diff the popup + options UI before/after (manual screenshots or a headless visual-regression pass).
**Revisit when**: a dedicated CSS pass with visual verification. Low priority — the duplication is cosmetic-stable, not buggy.

### D3 — `Providers.chat()` timeout-message says "30s" but default is 15s

**Deferred**: 2026-06-24 (Phase 69)
**Effort**: Small
**Why**: Found while unit-testing `providers.js`. `Providers.chat()` (src/background/providers.js:336-337) defaults `timeoutMs` to **15000** but the default `timeoutMsg` reads "Request timed out (30s)". On a real 15s abort the user-facing message would wrongly say "(30s)". Cosmetic only — no functional impact; not fixed in Phase 69 (test-only phase, no `src/` changes).
**Dependency**: none.
**Revisit when**: Phase 75 (translator/providers touch-up) — align the message with the actual default, or make the message derive from `timeoutMs`. Also note two effectively-dead defensive branches confirmed during testing (`chat()` "Unknown API style" return, `fetchQuota()` trailing `return null`) — harmless, reachable only if the provider registry loses a valid `apiStyle`/endpoint.

### D4 — Personal résumé `.docx` remains in git history

**Deferred**: 2026-06-24 (Phase 73)
**Effort**: Medium (history rewrite)
**Why**: Phase 73 `git rm --cached`'d `assets/icons/グエンバンフアン履歴書.docx` (a personal résumé that had been committed) and added `*.docx` to `.gitignore`, so it is no longer tracked. But untracking does **not** remove it from past commits — it is still retrievable from git history. The repo is private, so this is not an active exposure.
**Dependency**: none.
**Revisit when**: **Before any public push / open-sourcing.** Scrub it (and re-check for any other sensitive blobs) from history with `git filter-repo` (or BFG), then force-push. Until then, keeping the repo private is sufficient.

### D5 — 19 npm-audit vulnerabilities in dev-only transitive deps

**Deferred**: 2026-06-24 (Phase 73)
**Effort**: Small–Medium
**Why**: After removing the `jimp` dependency in Phase 73, `npm audit` dropped from 38 → **19** (1 low / 17 moderate / 1 high). The remaining advisories are all transitive dependencies of **dev** tooling (jest/eslint/etc.), which are **not shipped** in the extension ZIP — so there is no user-facing exposure. `npm audit fix --force` would pull breaking major bumps.
**Dependency**: none.
**Revisit when**: A dedicated tooling-maintenance pass (or alongside Phase 70 CI hardening). Try `npm audit fix` (non-breaking) first; evaluate majors individually. Low priority since it's dev-only.

### D6 — Further `tryKeyForBatch` structural splitting (optional)

**Deferred**: 2026-06-25 (Phase 75c)
**Effort**: Medium
**Why**: Phase 75c removed the biggest win — the two duplicated ~95-line post-success pipelines (now `finalizeSuccessfulBatch`). What remains inside `tryKeyForBatch` (the provider-call **retry loop** and the **text/timestamp parser** block) is cohesive but **not duplicated**, so extracting it is lower value, while it's still the shipped core with only partial behavior coverage (the 75b harness pins JSON-success/429-failover/abort/guards, not the 5xx-retry, non-JSON text path, 413-split, or quality thresholds).
**Dependency**: extend `tests/unit/translator-translate.test.js` to characterize the 5xx-retry, non-JSON text-parser, 413-split, and parse/quality-threshold branches (and unmock `MergeFixer` for one case) **first** — those tests are the gate.
**Revisit when**: a future translator-maintenance pass, or when a bug/feature already requires touching `tryKeyForBatch`. Not worth the risk purely for cleanliness right now.
