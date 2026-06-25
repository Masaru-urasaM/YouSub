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

---

## Resolved

> Tombstones kept for traceability (Rule 8 — removed from the active list above).

- **D1** — B1 error-toast `esc()` escaping unit test. **Resolved 2026-06-25** (DEFERRED-backlog pass). Extracted the un-exported `esc()` closure from `src/content/main.js` to `src/shared/utils.js` as an exported `escapeHtml()` (verbatim move — `&<>`-only escaping, `&`-first ordering, `String(s||'')` coercion all preserved; `main.js` imports it as `esc`). Added 13 behavior-locking unit tests in `tests/unit/utils.test.js` (falsy coercion, `&`/`<`/`>` escaping, double-escape ordering, quote-scope exclusion, crafted `<script>`/`<img onerror>` payloads). Suite 443 → 456, `utils.js` 100% covered.
- **D2** — Options "Appearance" tab form population. **Resolved 2026-06-25** (investigated in Phase 76). Premise was stale: `tab-appearance.js` already has a working `loadSettings()` (called from `initAppearanceTab()`) that populates all inputs + value displays + the live preview from `yousub_appearance` storage. The removed `loadAppearance()` was a dead duplicate, not the live populator. No fix required.
