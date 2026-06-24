# YouSub — Development Roadmap

> **Hub**: [YOUSUB_PROJECT_SPEC.md](YOUSUB_PROJECT_SPEC.md) (architecture, data flow, appendices)
> **Version**: 8.0
> **Last updated**: 2026-06-23
> **Status**: Shipped v0.2.2. In **Milestone 7 — Professionalization & Hardening** (Phases 65-77); Phases 65-66 done, 67 in progress (67a-b done).

---

## INSTRUCTIONS FOR AI ASSISTANT — READ THIS ENTIRE SECTION BEFORE EVERY SESSION

### How to Use This Document

This file is the **single source of truth** for all development work on YouSub. Before doing ANY work, you MUST:

1. Read `CLAUDE.md` — the canonical hard rules for your behavior (`GEMINI.md` is being retired in Phase 72; until then it mirrors the same core rules)
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
| **67** | **Dev-tooling foundation (ESLint/Prettier/EditorConfig/.nvmrc) + pre-commit + metadata** | IN PROGRESS (67a-b done 2026-06-24) | M7 |
| **68** | **Test recovery — fix the remaining 10 failing tests** | TODO | M7 |
| **69** | **[EPIC] Coverage expansion 34% → ≥70%** | TODO | M7 |
| **70** | **CI pipeline (GitHub Actions) — optional (private repo)** | TODO | M7 |
| **71** | **SPEC reconciliation + README + LICENSE** | TODO | M7 |
| **72** | **AI-governance consolidation (retire GEMINI.md, CLAUDE.md canonical)** | TODO | M7 |
| **73** | **Repo hygiene cleanup** | TODO | M7 |
| **74** | **Privacy / store compliance** | TODO | M7 |
| **75** | **[EPIC] Refactor `translator.js` + remove dead code (behavior-preserving)** | TODO | M7 |
| **76** | **[EPIC] UI/UX polish + accessibility** | TODO | M7 |
| **77** | **Transcript-button locale resilience (+ optional Japanese UI i18n)** | TODO | M7 |

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
**Status**: IN PROGRESS (67a done 2026-06-24) · **Risk**: Low · **Group**: tooling
Split into reviewable sub-phases (Rule 5):
- **67a (DONE 2026-06-24)** — ESLint 9 flat config + Prettier + `.editorconfig` + `.nvmrc` (22) + `package.json` metadata/scripts/`engines`; removed dangling `main`; `LICENSE` = **AGPLv3** (developer choice), `license` field ISC → `AGPL-3.0-only` + `private:true`. No code/format changes. Baseline: ESLint **89** (34 err/55 warn), Prettier **63** files.
- **67b (DONE 2026-06-24)** — ESLint cleanup to **0 problems** (was 89 → 66 after config → 0). Config: `no-empty` allowEmptyCatch, `YouSub` src global, ignore `resize_icons.js`. Then 15 parallel per-file agents fixed the residual 11 errors + 55 `no-unused-vars` warnings surgically (dead-code removal, `catch(e)`→`catch`, intentional-regex inline-disables; **developer opted to also clear all warnings**). Net −176 lines. Gated by `eslint .`=0 + tests 202/15 + manual diff review. Latent find → DEFERRED D2 (appearance-form load).
- **67c (TODO)** — repo-wide `prettier --write` as one **format-only** commit (developer opted in). Decide markdown inclusion (recommend excluding the hand-crafted `*.md` specs/roadmap to protect tables/wording).
- **67d (TODO)** — pre-commit hook (husky + lint-staged) running `eslint --fix` + prettier on staged files.
- **Verify**: `npm run lint` 0 errors after 67b; `npm test` green throughout.

### Phase 68 — Test recovery (remaining 10 failures)
**Status**: TODO · **Risk**: Low · **Group**: tests · **Depends**: 67
- Fix the 6 ESM/`eval()` content-script tests (use dynamic `import()` in the test instead of `eval()` on ESM source).
- Fix the 4 api-manager mock tests (disable model-rotation in setup, or update assertions to account for per-model key expansion).
- (B3/B4 tests already handled in Phase 66.)
- **Verify**: **0 failing tests** (217/217 — Phase 66 added 2 race tests).

### Phase 69 — [EPIC] Coverage expansion 34% → ≥70%
**Status**: TODO · **Risk**: Low · **Group**: tests · **Depends**: 68
Split at execution:
- **69a** — Export `translator.js` pure functions via `_internals`; unit-test `computeForceTimeoutMs`, `soonestCooldownWaitMs`, `splitForGroqPayload`.
- **69b** — Test the Phase 64 port/watchdog protocol (mock `chrome.runtime.connect`) + `sync-engine`.
- **69c** — Cover `providers.js` (currently 0.35%) + `api-manager`.
- Add `coverageThreshold` to `jest.config.cjs`, raised gradually to avoid an abrupt gate.
- **Verify**: ≥70% global, ≥80% on critical paths.

### Phase 70 — CI pipeline (optional)
**Status**: TODO · **Risk**: Low · **Group**: tooling · **Depends**: 67-69
- `.github/workflows/test.yml`: run test + lint + coverage gate on PR; verify `npm run package`.
- Consider renaming default branch `master → main`.
- *Optional because the repo is private*; a local pre-commit hook (Phase 67) may suffice. Confirm whether the repo is hosted on GitHub.
- **Verify**: workflow green.

### Phase 71 — SPEC reconciliation + README + LICENSE
**Status**: TODO · **Risk**: Low · **Group**: docs
- `YOUSUB_PROJECT_SPEC.md` §2.5/2.7: remove phantom files (`toast.js`, `tab-about.js`, `logo.svg`); rewrite §2.6/2.7 to the real architecture (ESM modules loaded via `loader.js` dynamic `import()`, with `window.YouSub` as a compatibility shim); fix the dependency graph; document `src/debug/`.
- Add a light, private-repo `README.md`; record removed-feature decisions + the cache-TTL choice in `YOUSUB_DESIGN_DECISIONS.md`.
- **Verify**: no broken cross-references, no references to non-existent files.

### Phase 72 — AI-governance consolidation
**Status**: TODO · **Risk**: Low · **Group**: docs
- Delete `GEMINI.md`; make `CLAUDE.md` the complete canonical rules file (fold in any uniquely useful content, e.g. the context-check rule). Clean up `.gemini/` references.
- Fix the Documentation Architecture tables (remove the phantom `PROMPT.md`, or create it).
- Reconcile the stale "A new software project / Tech Stack: TBD" boilerplate.
- **Verify**: a single source of AI rules; no dangling references.

### Phase 73 — Repo hygiene cleanup
**Status**: TODO · **Risk**: Low · **Group**: hygiene
- `git rm --cached` the personal résumé `.docx`, `icons.zip`, `icon128-original.png`, `tests/unit/jest_output.txt`, `tests/unit/translator_test.html`, `tmp/*`.
- Update `.gitignore` (`*.docx`, `tmp/`, `coverage/`, `*_output.txt`, `*-original.png`).
- Move `resize_icons.js` → `scripts/` (parameterize the hard-coded path) or remove it.
- Decide `src/debug/` fate: keep + document as an internal dev tool (it is wired via `popup.js`), or remove.
- *(Private repo → no urgent git-history scrub; just stop tracking.)*
- **Verify**: `git status` clean; `npm run package` still produces valid Chrome + Firefox ZIPs with no junk files.

### Phase 74 — Privacy / store compliance
**Status**: TODO · **Risk**: Low · **Group**: privacy
- Create an in-repo `privacy-policy.md` (mirror the gist content) so the policy isn't solely an external gist.
- Fix Firefox AMO `data_collection_permissions` — currently `["none"]`, but the extension sends transcript text to third-party LLMs (BYOK). Declare the correct category.
- Verify whether `RoughTranslator` actually uses `translate.googleapis.com`; remove the host_permission if unused, otherwise document it.
- Record the plaintext-API-key-storage tradeoff in `YOUSUB_DESIGN_DECISIONS.md`.
- **Verify**: manifest valid; privacy doc complete.

### Phase 75 — [EPIC] Refactor `translator.js` (behavior-preserving)
**Status**: TODO · **Risk**: **High** · **Group**: refactor · **Depends**: 68, 69
- **Only after the suite is solid (68 + 69).** Split at execution.
- Extract post-processing (merge-fix / sanitize / untranslated-detect) into testable modules; separate the concerns bundled in `tryKeyForBatch` (~255 lines).
- Remove dead code: `getFirstAvailableKey`, `allFailuresMap`; unify the divergent health-score formula (`api-manager` inline vs `HealthManager.getScore`).
- **Gate**: full suite green before AND after; behavior must be identical.
- **Verify**: tests green + compare real translation output on a sample video.

### Phase 76 — [EPIC] UI/UX polish + accessibility
**Status**: TODO · **Risk**: Med · **Group**: ux · **Depends**: 71
Split at execution:
- **76a** — Accessibility: ARIA for tabs/modals, focus trap + Escape dismiss, `aria-label` on icon-only buttons, visible focus indicators.
- **76b** — Deduplicate modal/button CSS shared between popup & options into a shared stylesheet.
- **76c** — Hygiene: `chrome.* → browser.*` consistency, HTML-vs-JS default-value drift, stale comments, inline-style → class, pull the version badge from constants. Wire or remove the dead GitHub/Issue links (private repo → clear placeholder or remove).
- **Verify**: manual UI pass.

### Phase 77 — Transcript-button locale resilience (+ optional Japanese UI)
**Status**: TODO · **Risk**: Med · **Group**: feature · **Depends**: 76
- **Committed work**: make transcript-button detection locale-resilient (`aria-label` containing "transcript" + a locale dictionary EN/VI/JA + `html[lang]`), so non-English YouTube uses the fast DOM-scrape path instead of the slow Innertube fallback.
- **Optional (await developer confirmation)**: localize the UI to Japanese via `chrome.i18n`. NOTE: the global rule "English + Japanese" governs the language of **code/comments**, not necessarily product localization — confirm scope before committing.
- **Verify**: non-English YouTube uses the fast path; if i18n is built, language switch works.

---

## OPEN QUESTIONS (resolve at the relevant phase)
- **Phase 65/71**: Is SPEC's "v0.4.0" intentional (future roadmap version) or a typo? (Do not overwrite without confirming.)
- ~~**Phase 66**: Cache TTL — keep 30 days or change to 7?~~ **RESOLVED (2026-06-23)**: keep 30 days. Also kept the circuit-breaker threshold at 10 (not 3). See Decision 11.
- **Phase 70**: Is the repo hosted on GitHub (CI worthwhile) or is a local pre-commit hook sufficient?
- **Phase 73**: Keep `src/debug/` (documented dev tool) or remove it?
- **Phase 77**: Is Japanese UI localization actually wanted, or only the transcript-selector resilience?

---

## DETAILED PHASE SPECIFICATIONS (legacy)

(Phases 0-64 are archived — see `ROADMAP_DONE.md`. Active work is Milestone 7 above.)
