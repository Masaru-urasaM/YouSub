# YouSub — Development Roadmap

> **Hub**: [YOUSUB_PROJECT_SPEC.md](YOUSUB_PROJECT_SPEC.md) (architecture, data flow, appendices)
> **Version**: 8.0
> **Last updated**: 2026-06-25
> **Status**: Shipped v0.2.2. **Milestone 7 COMPLETE** (Phases 65-77) + **post-M7 DEFERRED backlog cleared** (D1–D7; only D5's dev-only npm-audit items remain deferred — they need a jest/babel major migration). Comprehensive pass done: **468 tests green**, ESLint 0, Prettier clean, build VERIFY OK (both ZIPs), version 0.2.2 consistent. **Pending (manual, developer)**: Chrome/Firefox store upload + recommended browser smoke-tests (esp. the D6 translator path: one real video + one Shorts with a live API key).

---

## INSTRUCTIONS FOR AI ASSISTANT — READ THIS ENTIRE SECTION BEFORE EVERY SESSION

### How to Use This Document

This file is the **single source of truth** for all development work on YouSub. Before doing ANY work, you MUST:

1. Read `CLAUDE.md` — the single canonical hard-rules file for your behavior (the former `GEMINI.md` mirror was retired in Phase 72)
2. Read this file (`ROADMAP.md`) — contains what to do next
3. Read `ROADMAP_DONE.md` — contains what has already been completed
4. Read `YOUSUB_DESIGN_DECISIONS.md` — contains past decisions (do NOT re-propose rejected approaches)

For architecture diagrams, data flows, folder structure, YouTube references, and API specs — see [YOUSUB_PROJECT_SPEC.md](YOUSUB_PROJECT_SPEC.md).

### Phase Execution Protocol — STRICTLY ENFORCED

```
ONE PROMPT = ONE PHASE. NO EXCEPTIONS.
```

**Rules**:
1. **Never execute more than one phase in a single prompt.** If you finish Phase N, STOP. Do NOT start Phase N+1.
2. **After finishing a phase**: run tests, verify everything works, report results, then propose the next phase.
3. **If a phase has problems**: stay on that phase. Fix the problems before proposing the next phase.
4. **If a phase is too large (an `[EPIC]` below)**: split it into sub-phases (e.g., Phase 69a, Phase 69b). Each sub-phase = one prompt. Precedent: Phases 35.1-35.19, 50.1-50.7.
5. **Always wait for developer confirmation** before starting the next phase.

### Post-v0.2.2 Maintenance-Mode Note

The strict "ONE PROMPT = ONE PHASE" model was designed for sequential feature build-out (M1-M6, now complete). Milestone 7 is a mix of release-prep, tooling, test recovery, docs, hygiene, refactor and polish. It still follows the one-phase rule, but:
- Phase 64 verification is a **release gate**, not a new feature phase.
- For one-off hotfixes outside this roadmap, log them as `[Hotfix] <issue>: <description>` rather than forcing a phase number.
- Epics (`[EPIC]`) are split into sub-phases at execution time, not pre-enumerated here.

### After Each Phase — Mandatory Checklist

After completing any phase, you MUST do ALL of the following:

- [ ] Run all tests and verify they pass
- [ ] Update `ROADMAP.md` — change the phase status to `DONE (YYYY-MM-DD)`
- [ ] Update `CHANGELOG.md` — add entry under `## [Unreleased]`
- [ ] Update `YOUSUB_DESIGN_DECISIONS.md` — if any decisions were made
- [ ] Check if the completed phase should be archived to `ROADMAP_DONE.md`
- [ ] Report to developer: what was done, test results, any issues found
- [ ] Propose the next phase and wait for confirmation

### Prompt Pattern for Developer

To start a phase, the developer will say something like:
```
Execute Phase N: [Phase Title]
```
When you receive this, follow the `CLAUDE.md` workflow: Present -> Discuss -> Choose -> Plan -> Code.

---

## BUILD ORDER — QUICK REFERENCE

| Phase | Description | Status | Milestone |
|-------|-------------|--------|-----------|
| 0-61 | Core infrastructure through Cascade Shift Detection (see `ROADMAP_DONE.md`) | DONE (2026-05-07) | M1-M6 |
| 49 | Production Bundling & Log Management (see `ROADMAP_DONE.md`) | DONE (2026-05-07) | M5 |
| 51.1 | Resolve Shorts Metadata/Transcript Extraction Failure | DONE (2026-05-07) | M6 |
| 62 | Subtitle Overlay Resize, Move & Reset | DONE (2026-05-12) | M2 |
| 63 | Smart Batch Distribution — Round-Robin + Model Rotation | DONE (2026-05-14) | M3 |
| 64 | Streaming Timeout Robustness + Completeness Sweep (fixes TIMEOUT_BACKGROUND) | DONE (2026-06-08) — browser-verified, committed `95b75ae` | M3 |
| **65** | **Commit Phase 64 + Version-Truth Sync** | DONE (2026-06-23) | M7 |
| **66** | **Fix correctness blockers (B2 race, B4 circuit) + hardening (B1, B3)** | DONE (2026-06-23) | M7 |
| **67** | **Dev-tooling foundation (ESLint/Prettier/EditorConfig/.nvmrc) + pre-commit + metadata** | DONE (2026-06-24) | M7 |
| **68** | **Test recovery — fix the remaining 15 failing tests** | DONE (2026-06-24) | M7 |
| **69** | **[EPIC] Coverage expansion (23% → 40% honest; 70% = M7 exit)** | DONE (2026-06-24) | M7 |
| **70** | **CI pipeline (GitHub Actions) — ready-to-use, dormant until pushed** | DONE (2026-06-24) | M7 |
| **71** | **SPEC reconciliation + README + LICENSE** | DONE (2026-06-24) | M7 |
| **72** | **AI-governance consolidation (retire GEMINI.md, CLAUDE.md canonical)** | DONE (2026-06-24) | M7 |
| **73** | **Repo hygiene cleanup** | DONE (2026-06-24) | M7 |
| **74** | **Privacy / store compliance** | DONE (2026-06-24) | M7 |
| **75** | **[EPIC] Refactor `translator.js` + remove dead code (behavior-preserving)** | DONE (2026-06-25) | M7 |
| **76** | **[EPIC] UI/UX polish + accessibility** | DONE (2026-06-25) — 76b CSS dedup → DEFERRED D7 | M7 |
| **77** | **Transcript-button locale resilience + Japanese UI i18n** | DONE (2026-06-25) — overlay i18n optional | M7 |

> **Status format**: `DONE (YYYY-MM-DD)` · `IN PROGRESS` · `BLOCKED (reason)` · `TODO` = not started
>
> **Milestone key**: M1 = MVP, M2 = Features, M3 = Robustness, M4 = Quality, M5 = Distribution, M6 = Expansion, **M7 = Professionalization & Hardening**

---

## MILESTONE 7 — PROFESSIONALIZATION & HARDENING

> **Why this milestone exists**: YouSub is a shipped, working product (v0.2.2) built quickly across 60+ phases. A read-only 7-dimension audit (which actually ran `npm test`) confirmed the core engine works, but found real technical debt in three areas — **documentation drift, missing tooling/CI/test-recovery, and repo hygiene** — plus a handful of verified correctness/security issues. This milestone professionalizes the project **surgically**: low-risk, behavior-preserving changes first; the one genuinely risky refactor (translator.js) is gated behind a solid test suite. Ordering: release-critical → tooling → tests → docs → hygiene → refactor → polish.

> **Audit ground-truth (2026-06-23)**:
> - **Version**: real version is **0.2.2** (`constants.js` = `manifest.json` = `package.json`, in the working tree). Last *commit* is still Phase 63 (`e7fe8e0`) at 0.2.1.
> - **Tests**: 13 suites, **215 tests — 198 pass / 17 fail**, **34.29% coverage**. The 17 failures are real (6 ESM/`eval()` content-script tests, 4 api-manager mock key-count, 1 cache TTL, 1 circuit-breaker, rest minor).
> - **Verified code findings**: B2 (SyncEngine async race → TypeError on Shorts swipe) is a real blocker; B4 (circuit breaker `isCircuitOpen()` returns false when open) needs investigation; B3 (cache TTL comment "7-day" vs code 30-day) is a doc/code mismatch; B1 (error-toast `innerHTML` not fully `esc()`-ed) is low-risk defense-in-depth (sinks are not attacker-controlled), not a release blocker.

### Phase 65 — Commit Phase 64 + Version-Truth Sync
**Status**: DONE (2026-06-23) · **Risk**: Low · **Group**: release/docs · **Commit**: `95b75ae`
- Commit the uncommitted Phase 64 work (developer-confirmed browser-verified): 10 modified files + 2 untracked test files.
- Move the Phase 64 CHANGELOG entry out of "pending verify" into released state.
- Update `MEMORY.md`: add Phases 62/63/64 to the Implementation Log, set status to v0.2.2, refresh the date.
- Fix `src/options/options.html` version badge `0.2.0 → 0.2.2` (both the header badge and the About-tab line). Establish `constants.js`/`manifest.json` as the single source of truth for version.
- **Open question to confirm first**: SPEC header says "v0.4.0" — is that an intentional future-roadmap version or a typo? If typo → set to 0.2.2; if intentional → keep with a clarifying note. Do not overwrite silently.
- **Verify**: `manifest`/`package`/`constants`/options-UI/`MEMORY` all read 0.2.2; `git status` clean.

### Phase 66 — Fix correctness blockers + hardening
**Status**: DONE (2026-06-23) · **Risk**: Low-Med · **Group**: correctness · **Depends**: 65
- **B2 (real blocker — FIXED)** `sync-engine.js`: the `timeupdate` listener was armed inside the async storage `.then()`; converted that callback to an arrow function (correct lexical `this`) and added an `if (!videoElement) return` guard so a `stop()` that wins the race no longer throws `TypeError` on `addEventListener(null)` nor re-arms a torn-down engine. New regression suite `tests/unit/sync-engine-race.test.js` (2 deterministic tests).
- **B4 (was a TEST bug, not a code bug)** `health.js`: re-verification showed `isCircuitOpen()` is correct (`Date.now() < circuitBreakerUntil`) and the breaker opens at `consecutiveFails >= 10` (health.js:65). The failing test wrongly expected it open after **3** fails — fixed `health.test.js` (loop to 10, renamed). `health.js` code **unchanged**.
- **B3 (decision: keep 30-day behavior)** `cache.js`: the code shipped a 30-day TTL while the comment + test claimed 7. Per developer decision, kept the 30-day behavior, corrected the comment, and updated `cache.test.js` (8-day → 31-day fixture). See Decision 11.
- **B4 threshold (decision: keep 10)**: kept the shipped `>= 10` circuit threshold (rejected reverting to 3) — preserves live backoff behavior. See Decision 11.
- **B1 (hardening — done; test deferred)** `main.js`: wrapped `esc()` around `failureReason`, `retryMatch[1]`, and the `limitMatch` captures. The dedicated escaping test is deferred to Phase 68 (`esc()` is an un-exported closure in a content script the harness cannot yet load). See `DEFERRED.md` D1.
- **Tests**: 198 → **202 pass** / 17 → **15 fail** (215 → **217 total**); +2 race tests, cache-TTL + circuit-breaker recovered. Remaining 15 failures are Phase 68 scope (subtitle-parser, sync-engine `eval`, api-manager mocks).
- **Verify**: targeted suites green (16/16); full suite no regressions. Browser re-check of B2 (normal video + rapid Shorts swipe) recommended before next release.

### Phase 67 — Dev-tooling foundation
**Status**: DONE (2026-06-24) · **Risk**: Low · **Group**: tooling
Split into reviewable sub-phases (Rule 5):
- **67a (DONE 2026-06-24)** — ESLint 9 flat config + Prettier + `.editorconfig` + `.nvmrc` (22) + `package.json` metadata/scripts/`engines`; removed dangling `main`; `LICENSE` = **AGPLv3** (developer choice), `license` field ISC → `AGPL-3.0-only` + `private:true`. No code/format changes. Baseline: ESLint **89** (34 err/55 warn), Prettier **63** files.
- **67b (DONE 2026-06-24)** — ESLint cleanup to **0 problems** (was 89 → 66 after config → 0). Config: `no-empty` allowEmptyCatch, `YouSub` src global, ignore `resize_icons.js`. Then 15 parallel per-file agents fixed the residual 11 errors + 55 `no-unused-vars` warnings surgically (dead-code removal, `catch(e)`→`catch`, intentional-regex inline-disables; **developer opted to also clear all warnings**). Net −176 lines. Gated by `eslint .`=0 + tests 202/15 + manual diff review. Latent find → DEFERRED D2 (appearance-form load).
- **67c (DONE 2026-06-24)** — repo-wide `prettier --write` (52 files, commit `50462db`), `*.md` + `LICENSE` excluded to protect docs. Format-only, gated by eslint=0 + `prettier --check` + tests 202/15. Added `.git-blame-ignore-revs`.
- **67d (DONE 2026-06-24)** — husky v9 + lint-staged pre-commit (`eslint --fix` + `prettier --write` on staged js/json/css/html; md excluded). Replaced husky's default `npm test` hook — the 15 known failures would block every commit; full-suite gating → CI/Phase 70.
- **Verify**: `npm run lint` 0 errors after 67b; `npm test` green throughout.

### Phase 68 — Test recovery (remaining 15 failures)
**Status**: DONE (2026-06-24) · **Risk**: Low · **Group**: tests · **Depends**: 67
- **Done — test-only, no production code touched.** The real count was **15** failing across 3 suites (the audit's "10/6 ESM" was an undercount): `subtitle-parser` (6, eval) + `sync-engine` (5, eval) + `api-manager` (4, mock).
- Replaced the `eval(scriptContent)` loaders with direct ESM `import` — `subtitle-parser` imports cleanly; `sync-engine` needs `jest.unstable_mockModule('overlay.js', …)` since it calls the imported `Overlay` binding directly.
- Updated stale assertions to shipped behavior: `renderSubtitles` 4th `isTranslated` arg; `decodeHtml` strips inline tags; hide-on-gap needs a prior valid index. `api-manager`: set `yousub_model_rotation:false` to isolate failover/circuit/sort; **added** a rotation-on expansion test.
- (B3/B4 tests already handled in Phase 66.)
- **D1** (`esc()` test): eval blocker cleared but `esc()` is an un-exported closure in the side-effectful `main.js` entry → re-pointed to Phase 75 (extract to `utils.js`). See `DEFERRED.md`.
- **Verify**: **0 failing tests — 218/218** (217 + 1 new rotation test); `npm run lint` + `prettier --check` clean.

### Phase 69 — [EPIC] Coverage expansion (honest 23% → 40%; 70% reframed as M7 exit)
**Status**: DONE (2026-06-24) · **Risk**: Low · **Group**: tests · **Depends**: 68
- **Strategy decision (Decision 12, developer-approved)**: an honest coverage denominator (`src/**` minus vendored `browser-polyfill.js`) measured a **23%** baseline. "≥70% global" is not achievable in one phase without the Phase 75 translator refactor or low-value UI-glue grinding → reinterpreted as a **Milestone-7 exit** target reached incrementally (69 now, 75 translator, 76 UI). Chose the "realistic ratchet": write honest high-value tests now, gate at the achieved level.
- **Done as one coordinated coverage pass** (folded the planned 69a/b/c into a 4-agent parallel workflow, each agent gated to green + lint/prettier-clean, no `src/` production edits):
  - `providers.js` 0.35% → **97%** (50 tests, mock `fetch`); `overlay.js` 6% → **61%** (30 tests, jsdom); translator **pure helpers** via expanded `_internals` (59 tests, translator.js 11% → 24%); `page-detector` **100%**, `subtitle-extractor` **90%**, `video-binder` **88%**, `trusted-types` **100%**, `utils` **100%** (63 tests).
  - **+202 tests** (218 → **420**); **global 23% → 39.9%** lines; `coverageThreshold` set a hair below achieved (lines/stmts 38, branches 34, funcs 36) — ratchets, never lower.
- Config: `jest.config.cjs` gained `collectCoverageFrom` + `coverageThreshold`; `translator.js` `_internals` expanded (behavior-preserving); `tests/mocks/chrome.js` gained storage-level `onChanged` (real-API shape; was a latent footgun).
- Findings → DEFERRED **D3** (providers `chat()` "30s" message vs 15s default; two dead defensive branches).
- **Deferred to their refactor phases**: deep `translator.js` orchestration coverage → Phase 75; UI-glue (`tab-translation`/`popup`/`options`) + entries → Phase 76.
- **Verify**: 420/420 green, `npm test` exits 0 with the threshold gate, `npm run lint` + `prettier --check` clean.

### Phase 70 — CI pipeline (ready-to-use)
**Status**: DONE (2026-06-24) · **Risk**: Low · **Group**: tooling · **Depends**: 67-69
- **Decision (developer)**: repo is currently local-only (no GitHub remote, kept private by design). Chose to **write the workflow now, dormant** — it activates automatically the moment the repo is pushed to GitHub. Did **not** rename `master → main` (deferred to if/when a remote is added).
- Created `.github/workflows/test.yml`: on push/PR to main|master → `npm ci` → `npm run lint` → `npm run format:check` → `npm test` (with the Phase 69 coverage-threshold gate) → `npm run package` (Chrome + Firefox build smoke test). Node 22 (matches `.nvmrc`), `HUSKY=0` to skip hook install in CI.
- Every step was verified locally before commit: lint 0, format:check 0, test exit 0 (420/420 + gate), package exit 0 (both ZIPs, VERIFY OK). The workflow YAML is Prettier-clean so it won't fail its own `format:check` step.
- **Verify**: all gate commands pass locally; workflow will run green once a GitHub remote exists.

### Phase 71 — SPEC reconciliation + README + LICENSE
**Status**: DONE (2026-06-24) · **Risk**: Low · **Group**: docs
- Ran a SPEC-vs-reality audit (Explore agent, line-referenced). `YOUSUB_PROJECT_SPEC.md` §2.5/2.7: removed phantom files (`toast.js`, `tab-about.js`, `logo.svg` — confirmed never existed); §2.6/2.7 rewritten to the real ESM architecture (single `loader.js` entry → dynamic `import()` of `main.js` → ESM module graph; `window.YouSub` = compat shim; documented `web_accessible_resources`). Added the previously-undocumented real modules (`loader.js`, `shared/trusted-types.js`, `shared/utils.js`, `shared/libs/browser-polyfill.js`, `background/merge-fixer.js`, `background/rough-translator.js`) and the `src/debug/` panel; fixed the icon list.
- Added a light, private-repo `README.md` (tech stack, dev quickstart, privacy/BYOK note, doc map, AGPL-3.0). LICENSE was already added in Phase 67.
- Recorded the reconciliation as **Decision 13** (phantom modules were specced but never built — do not re-add); cache-TTL choice is **Decision 11**.
- **Verify**: `grep` confirms zero remaining `toast.js`/`tab-about`/`logo.svg` references in the SPEC; folder map matches the real tree.

### Phase 72 — AI-governance consolidation
**Status**: DONE (2026-06-24) · **Risk**: Low · **Group**: docs
- Deleted `GEMINI.md` (it was a near-duplicate of `CLAUDE.md` with "Gemini" swapped in). Folded its one unique item — the `MAX_LINES_PER_BATCH` "do not touch" guard — into `CLAUDE.md` as **Rule 12**. Added **Rule 13** (CLAUDE.md is the single canonical rules file + the maintenance-mode/`[Hotfix]` note). No `.gemini/` dir existed.
- Removed the phantom `PROMPT.md` from CLAUDE.md's Documentation Architecture table + Directory Structure (kept `CONTEXT.md`, which exists; added `README.md`). Fixed the `.Claude/` casing artifact.
- Replaced the stale "A new software project / Tech Stack: TBD" Project-Overview boilerplate with the real YouSub description + tech stack.
- Updated the ROADMAP session-instructions note (line 16) — `GEMINI.md` is now retired, not "being retired".
- **Verify**: only one AI-rules file (`CLAUDE.md`); remaining "Gemini" matches are the LLM provider, not the retired file.

### Phase 73 — Repo hygiene cleanup
**Status**: DONE (2026-06-24) · **Risk**: Low · **Group**: hygiene
- `git rm --cached` (untracked, kept on disk): the personal résumé `.docx`, `assets/icons/icons.zip`, `assets/icons/icon128-original.png`, `tests/unit/jest_output.txt`, `tmp/test_logic.js`, `tmp/test_parser.js`. Fully deleted the stale `tests/unit/translator_test.html`.
- **Removed `resize_icons.js`** (not relocated): it was doubly dead — a hard-coded source path into another tool's temp folder AND jimp v0.x API (`.resize(128,128).writeAsync`) incompatible with the installed jimp 1.6, and it only emitted 3 of the 6 required icon sizes. Removing its sole consumer let me also drop the orphaned **`jimp` dependency** → `npm audit` **38 → 19** vulnerabilities (the rest are dev-only transitive deps of jest/eslint, not shipped).
- Updated `.gitignore` (`tmp/`, `*.docx`, `*.zip`, `*_output.txt`, `*-original.png`); removed the now-unneeded `resize_icons.js` entry from `eslint.config.js`.
- `src/debug/` — **kept** (developer-confirmed): it's a shipped advanced-diagnostics panel wired via `popup.js`; documented in the SPEC (Phase 71).
- **Privacy note (DEFERRED D4)**: untracking stops future tracking but the résumé `.docx` **remains in git history**. Private repo → no urgent scrub; must scrub before any public push.
- **Verify**: `git status` clean; `npm run lint` 0; `npm test` 420/420 + gate; `npm run package` produces valid Chrome + Firefox ZIPs (the skip-list already excluded the junk, so the ZIPs are unchanged).

### Phase 74 — Privacy / store compliance
**Status**: DONE (2026-06-24) · **Risk**: Low · **Group**: privacy
- Added in-repo `privacy-policy.md` mirroring the canonical published gist (`Masaru-urasaM/15f9846…`), with a header pointing back to the gist as the store-linked source of truth.
- Fixed Firefox `data_collection_permissions`: `["none"]` → **`["websiteContent"]`** — the extension transmits the YouTube transcript (website content) to the user's chosen third-party LLM, so "none" was a false declaration. ⚠️ The `data_collection_permissions` schema is a newer/evolving Firefox feature — **verify the exact accepted category set against current AMO review guidance at submission time** (Rule 2: honest about uncertainty). Manifest re-validated as JSON; `npm run package` VERIFY OK.
- `translate.googleapis.com` host_permission — **verified IN USE** by `rough-translator.js:66` (free Google-Translate `translate_a/single` endpoint for the rough-translation tier). **Kept**, not removed.
- Recorded the plaintext-API-key-storage tradeoff as **Decision 14** (keep plaintext `chrome.storage.local`; encryption-at-rest adds UX cost for little gain against the real threat model).
- **Verify**: manifest valid JSON + build VERIFY OK; `privacy-policy.md` present and consistent with the declared data flow.

### Phase 75 — [EPIC] Refactor `translator.js` (behavior-preserving)
**Status**: DONE (2026-06-25) · **Risk**: High · **Group**: refactor · **Depends**: 68, 69
Split into reviewable sub-phases:
- **75a (DONE)** — Unified the divergent health-score formula. Found `HealthManager.getScore` is dead-in-prod (only tests call it); the live formula is api-manager's inline one (10s cap). Added `HealthManager.computeScore(entry)` as the single source of truth (live 10s formula), wired both call sites to it, + 4 pinning tests. Behavior-preserving (prod key-ordering unchanged). See Decision-supporting note in CHANGELOG.
- **75b (DONE)** — Built `tests/unit/translator-translate.test.js`, a characterization harness for the exported `translate()` (mocks the `providers.js` module, not fetch): pins happy-path, 429-failover, abort, and input guards. `translator.js` coverage 24% → 48.5%.
- **75c (DONE)** — Deduplicated `tryKeyForBatch`: the two near-identical ~95-line post-success pipelines (JSON-parse path + text-parse path) were extracted **verbatim** into one `finalizeSuccessfulBatch(...)` helper. Net −96 lines, no logic change. Gated by the 75b harness + full suite (429/429) + manual review.
- **Dead code** (`getFirstAvailableKey`, `allFailuresMap`) was already removed in Phase 67b.
- **Deferred (DEFERRED D6)**: further splitting of the (non-duplicated) retry loop / text-parser inside `tryKeyForBatch` — lower value, needs the harness extended to the 5xx/text/413/threshold branches first; not worth the shipped-core risk purely for cleanliness now.
- **Verify**: full suite 429/429 green before & after each step; lint + prettier clean. (Browser re-check on a sample video recommended before the next release, since the harness doesn't cover the sanitize/untranslated cascades.)

### Phase 76 — [EPIC] UI/UX polish + accessibility
**Status**: DONE (2026-06-25) · **Risk**: Med · **Group**: ux · **Depends**: 71
- **76a (DONE)** — Accessibility: full ARIA tab pattern on the options tabs (tablist/tab/tabpanel + `aria-selected`/roving `tabindex` synced in `setupTabs`, + Arrow-key nav); `role="dialog"`+`aria-modal`+labelledby/describedby on both confirm modals, with focus-to-cancel on open, Escape-to-close, and focus-return to opener; `aria-label` on the ✕ icon button; `role="status"`+`aria-live="polite"` on the popup health + loading regions.
- **76b (DEFERRED → D7)** — Deduplicate shared modal/button CSS: maintainability-only and needs visual-regression verification; deferred to a dedicated CSS pass to protect the look.
- **76c (DONE)** — Hygiene: `chrome.* → browser.*` (4 calls; 3 callbacks properly rewritten to `.then()`); removed the dead GitHub link + pointed "Report an Issue" at `mailto:`; version badge + About version now read from `Constants.VERSION` (no hardcoded drift). DEFERRED **D2** found already-resolved (`loadSettings()` populates the Appearance form).
- **Verify**: new `tests/unit/options-a11y.test.js` (6 tests) asserts the ARIA wiring; full suite **435/435** green; lint 0; `npm run package` VERIFY OK. (Manual/screen-reader pass still recommended before release.)

### Phase 77 — Transcript-button locale resilience + Japanese UI i18n
**Status**: DONE (2026-06-25) · **Risk**: Med · **Group**: feature · **Depends**: 76
- **77a (DONE)** — `main-world-extractor.js` `findTranscriptButton()` made locale-resilient: the aria-label/text fallbacks now match EN (case-insensitive substring) + JA (`文字起こし` / `文字起こしを表示`); the primary structural selectors (`ytd-…-transcript-section-renderer`) are already language-agnostic. Per the hard rule (code = English + Japanese only), the label list is EN + JA, not VI; other locales rely on the structural path.
- **77b (DONE)** — Full Japanese UI i18n via the WebExtensions `i18n` API: `_locales/en/messages.json` + `_locales/ja/messages.json` (**98 keys each, identical set**, natural JA translations); `src/shared/i18n.js` `applyI18n()` helper (textContent + placeholder/aria-label/title; **graceful** — untagged/missing strings keep their hardcoded English, never blank); `data-i18n*` tags across popup + options (incl. the cloned API-key-row template); `manifest.json` `default_locale: "en"`; `scripts/package.js` packs `_locales` (verified in both ZIPs); `chrome.i18n` mock added. **Bug caught** (advisor): a `$INDEX$` token without a `placeholders` block would render blank in real Chrome → switched to a `{index}` token + tightened the parity test. **Surfaces**: popup + options done; overlay status strings skipped (optional — content-script i18n works but was out of scope); manifest name/description left literal ("YouSub" is a brand).
- **Verify**: full suite **435 → 443** green; lint 0; `prettier --check` clean; `npm run package` VERIFY OK with `_locales/en` + `_locales/ja` in both ZIPs; en/ja key-parity test enforced.

---

## OPEN QUESTIONS (resolve at the relevant phase)
- ~~**Phase 65/71**: Is SPEC's "v0.4.0" intentional or a typo?~~ **RESOLVED**: the SPEC header was already corrected to v0.2.2 in Phase 65; the only remaining "v0.4.0" is a historical row in the SPEC's own revision-history table (left as history). No action needed.
- ~~**Phase 66**: Cache TTL — keep 30 days or change to 7?~~ **RESOLVED (2026-06-23)**: keep 30 days. Also kept the circuit-breaker threshold at 10 (not 3). See Decision 11.
- ~~**Phase 70**: Is the repo hosted on GitHub (CI worthwhile)?~~ **RESOLVED (2026-06-24)**: repo is local-only; wrote a ready-to-use workflow that stays dormant until a GitHub remote is added. No branch rename.
- ~~**Phase 73**: Keep `src/debug/` or remove it?~~ **RESOLVED**: keep + document — it's a shipped advanced-diagnostics panel wired via `popup.js` (`open-debug-btn` → `src/debug/debug.html`); removing it would break the popup.
- ~~**Phase 77**: Is Japanese UI localization wanted, or only selector resilience?~~ **RESOLVED (2026-06-24)**: do BOTH — transcript-selector locale resilience **and** full Japanese UI i18n via `chrome.i18n`.

---

## DETAILED PHASE SPECIFICATIONS (legacy)

(Phases 0-64 are archived — see `ROADMAP_DONE.md`. Active work is Milestone 7 above.)
