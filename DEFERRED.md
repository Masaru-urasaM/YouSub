# YouSub — Deferred Items

> Track deferred features and tasks per CLAUDE.md Rule 8.
> Review at milestone starts — flag items whose dependencies are now met.
> Remove when implemented (resolved items are tombstoned under "## Resolved").

---

### D7 — Deduplicate shared modal/button CSS (Phase 76b, deferred)

**Deferred**: 2026-06-25 (Phase 76)
**Effort**: Medium
**Why**: `src/popup/popup.css` (491 lines) and `src/options/options.css` (753 lines) duplicate modal-overlay/button/`.secondary-btn`/`.danger-btn` rules. Extracting them into a shared stylesheet is maintainability-only (no user-facing change) and risky to do safely without **visual regression testing** (CSS specificity/cascade differences between the two contexts could shift the look). Phase 76 delivered the user-facing wins (a11y + hygiene) instead.
**Dependency**: a way to visually diff the popup + options UI before/after (manual screenshots or a headless visual-regression pass).
**Revisit when**: a dedicated CSS pass with visual verification. Low priority — the duplication is cosmetic-stable, not buggy.

### D4 — Personal résumé `.docx` remains in git history

**Deferred**: 2026-06-24 (Phase 73)
**Effort**: Medium (history rewrite)
**Why**: Phase 73 `git rm --cached`'d `assets/icons/グエンバンフアン履歴書.docx` (a personal résumé that had been committed) and added `*.docx` to `.gitignore`, so it is no longer tracked. But untracking does **not** remove it from past commits — it is still retrievable from git history. The repo is private, so this is not an active exposure.
**Dependency**: none.
**Revisit when**: **Before any public push / open-sourcing.** Scrub it (and re-check for any other sensitive blobs) from history with `git filter-repo` (or BFG), then force-push. Until then, keeping the repo private is sufficient. (Currently moot: the repo is local-only — there is no remote to push to.)

### D5 — 18 npm-audit vulnerabilities in dev-only transitive deps (high-severity `ws` now fixed)

**Deferred**: 2026-06-24 (Phase 73) · **Updated**: 2026-06-25 (DEFERRED-backlog pass — high-severity `ws` closed)
**Effort**: Medium (the remainder needs a breaking jest/babel major migration)
**Progress (2026-06-25)**: the one **high**-severity advisory — `ws` (`GHSA-58qx-3vcg-4xpx` uninitialized-memory + `GHSA-96hv-2xvq-fx4p` memory-exhaustion DoS), pulled transitively by `jest-environment-jsdom → jsdom@26 → ws@8.20.0` — was closed **surgically** via a `package.json` `overrides: { "ws": "^8.21.0" }` entry (8.20.0 → 8.21.0). Dev-only, full suite stays **458/458** green, lockfile diff is 3 lines. Audit count 19 → **18**.
**Why the rest stays deferred**: the remaining 18 (1 low / 17 moderate) are all transitive deps of the **dev** toolchain (`babel-jest` → `@jest/transform` → `babel-plugin-istanbul`, etc.), **not shipped** in the extension ZIP — no user-facing exposure. **Empirically verified**: a plain `npm audit fix` (no `--force`) reshuffles jest's internal packages and **breaks the entire test suite** (`TypeError: this._moduleMocker.clearMocksOnScope is not a function` — jest-runtime/jest-mock version desync); it was reverted. `--force` would pull breaking jest/babel majors.
**Dependency**: a deliberate jest (and/or babel) major-version migration, with the suite re-validated after.
**Revisit when**: a dedicated tooling-maintenance pass that can absorb a jest major bump. Low priority — dev-only, not shipped.

### D6 — Further `tryKeyForBatch` structural splitting (optional)

**Deferred**: 2026-06-25 (Phase 75c)
**Effort**: Medium
**Why**: Phase 75c removed the biggest win — the two duplicated ~95-line post-success pipelines (now `finalizeSuccessfulBatch`). What remains inside `tryKeyForBatch` (the provider-call **retry loop** and the **text/timestamp parser** block) is cohesive but **not duplicated**, so extracting it is lower value, while it's still the shipped core with only partial behavior coverage (the 75b harness pins JSON-success/429-failover/abort/guards, not the 5xx-retry, non-JSON text path, 413-split, or quality thresholds).
**Dependency**: extend `tests/unit/translator-translate.test.js` to characterize the 5xx-retry, non-JSON text-parser, 413-split, and parse/quality-threshold branches (and unmock `MergeFixer` for one case) **first** — those tests are the gate.
**Revisit when**: a future translator-maintenance pass, or when a bug/feature already requires touching `tryKeyForBatch`. Not worth the risk purely for cleanliness right now.

---

## Resolved

> Tombstones kept for traceability (Rule 8 — removed from the active list above).

- **D1** — B1 error-toast `esc()` escaping unit test. **Resolved 2026-06-25** (DEFERRED-backlog pass). Extracted the un-exported `esc()` closure from `src/content/main.js` to `src/shared/utils.js` as an exported `escapeHtml()` (verbatim move — `&<>`-only escaping, `&`-first ordering, `String(s||'')` coercion all preserved; `main.js` imports it as `esc`). Added 13 behavior-locking unit tests in `tests/unit/utils.test.js` (falsy coercion, `&`/`<`/`>` escaping, double-escape ordering, quote-scope exclusion, crafted `<script>`/`<img onerror>` payloads). Suite 443 → 456, `utils.js` 100% covered.
- **D2** — Options "Appearance" tab form population. **Resolved 2026-06-25** (investigated in Phase 76). Premise was stale: `tab-appearance.js` already has a working `loadSettings()` (called from `initAppearanceTab()`) that populates all inputs + value displays + the live preview from `yousub_appearance` storage. The removed `loadAppearance()` was a dead duplicate, not the live populator. No fix required.
- **D3** — `Providers.chat()` timeout message said "30s" but the default abort is 15s. **Resolved 2026-06-25** (DEFERRED-backlog pass). The default message now derives from the actual `timeoutMs`: `` `Request timed out (${Math.round(timeoutMs / 1000)}s)` `` (15s by default; reflects any caller-supplied `timeoutMs`); a caller-supplied `timeoutMsg` still takes precedence. +2 pinning tests in `providers.test.js`. The two harmless dead-defensive branches noted alongside D3 (`chat()` "Unknown API style", `fetchQuota()` trailing `return null`) were intentionally left as defense-in-depth (out of scope; reachable only on a corrupted provider registry).
