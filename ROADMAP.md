# YouSub — Development Roadmap

> **Hub**: [YOUSUB_PROJECT_SPEC.md](YOUSUB_PROJECT_SPEC.md) (architecture, data flow, appendices)
> **Version**: 8.1
> **Last updated**: 2026-07-06
> **Status**: **No active roadmap phases.** All phases complete — Phases 0-77 (Milestones M1-M7) + the post-M7 DEFERRED backlog (D1–D7) cleared + the [Privacy P0] fix and Phase B on-device-verification restore (2026-06-30 → 2026-07-06). Version **0.2.4** built + committed (2026-07-06), **not yet uploaded to the store**. Full phase history is archived in [`ROADMAP_DONE.md`](ROADMAP_DONE.md).

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
4. **If a phase is too large (an `[EPIC]`)**: split it into sub-phases (e.g., Phase 69a, Phase 69b). Each sub-phase = one prompt. Precedent: Phases 35.1-35.19, 50.1-50.7, 67a-d, 75a-c, 76a-c, 77a-b.
5. **Always wait for developer confirmation** before starting the next phase.

### Post-v0.2.2 Maintenance-Mode Note

The strict "ONE PROMPT = ONE PHASE" model was designed for sequential feature build-out (M1-M6) and the M7 hardening pass — all now complete. The project is in **maintenance mode**:
- The one-phase rule still applies to any new roadmap phase.
- For one-off hotfixes outside the roadmap, log them as `[Hotfix] <issue>: <description>` in `CHANGELOG.md` rather than forcing a phase number.
- Epics (`[EPIC]`) are split into sub-phases at execution time, not pre-enumerated here.

### After Each Phase — Mandatory Checklist

After completing any phase, you MUST do ALL of the following:

- [ ] Run all tests and verify they pass
- [ ] Update `ROADMAP.md` — change the phase status to `DONE (YYYY-MM-DD)`
- [ ] Update `CHANGELOG.md` — add entry under `## [Unreleased]`
- [ ] Update `YOUSUB_DESIGN_DECISIONS.md` — if any decisions were made
- [ ] Archive the completed phase to `ROADMAP_DONE.md` and remove its detail from this file (Rule 10)
- [ ] Report to developer: what was done, test results, any issues found
- [ ] Propose the next phase and wait for confirmation

### Prompt Pattern for Developer

To start a phase, the developer will say something like:
```
Execute Phase N: [Phase Title]
```
When you receive this, follow the `CLAUDE.md` workflow: Present -> Discuss -> Choose -> Plan -> Code.

---

## CURRENT STATUS — No Active Phases

All planned work is complete. There are **no active or queued roadmap phases**.

**Project state**:
- **Phases 0-77 complete** (Milestones M1-M7). M7 (Professionalization & Hardening) finished 2026-06-25 — full detail archived in [`ROADMAP_DONE.md`](ROADMAP_DONE.md).
- **Post-M7 DEFERRED backlog cleared** — D1–D7 cleared 2026-06-25; **D5** (npm audit) and **D9** (`main.js` harness) resolved 2026-11-17 during the `TODO.md` technical-debt pass. Only **D8** (`LanguageDetector`) remains deferred pending on-device model residency.
- **Technical Debt Hardening Pass (2026-11-17)**: `npm audit` **0 vulnerabilities**, **583/583 tests** green across 36 suites, global coverage **90.1% lines / 88.8% stmts / 75.1% branches / 88.8% funcs** (threshold ratcheted to `84/72/84/85`, exceeding Milestone-7 exit target ≥ 70%), `translator.js` and `tab-translation.js` modularized, `npm run test:log` + `npm run verify` + `.husky/pre-push` added, both v0.2.4 ZIPs rebuilt (`[VERIFY OK]`, ZIP size reduced via `preview_bg.jpg` optimization & unused `logo_618.png` exclusion).

**Pending — manual, developer only (cannot be automated)**:
1. **Upload `dist/yousub-v0.2.4-chrome.zip`** (and the Firefox ZIP if/when releasing there) to the store. This is the only step that puts 0.2.4 in users' hands. (The published privacy-policy gist `15f9846972ccb68a120d29e988f42847` was synced to `privacy-policy.md` on 2026-11-17.)
2. **Recommended browser smoke-test before upload**: one normal video + one Shorts with a live API key, to confirm the real translation path (carried from DEFERRED D6 — the harness stubs the sanitize / foreign-script / untranslated / MergeFixer cascades). For Phase B specifically, open the page main-world console and check `'Translator' in window` + `await Translator.availability({sourceLanguage:'en',targetLanguage:'vi'})`; if it reports `available`, confirm a `YOUSUB_ROUGH_TRANSLATE` round-trip fires (single-track video, concrete src). `unavailable`/`downloadable` is expected and degrades cleanly to the offline heuristic.
3. **After 0.2.4 is live**, update the "shipped v0.2.2 on the Chrome Web Store" lines in `CLAUDE.md` / `README.md` / `YOUSUB_PROJECT_SPEC.md` (left at 0.2.2 now because 0.2.4 is not yet published).
4. **Personal/repo hygiene on disk**: move `assets/icons/グエンバンフアン履歴書.docx` (and optionally `icons.zip`, `icon128-original.png`) outside the workspace.

**Open backlog (deferred, not scheduled)**:
- **DEFERRED D8** — `LanguageDetector` source-language detection (revisit once on-device `Translator` models are observed resident as `'available'`). See `DEFERRED.md`.

**To start new work**: the developer proposes a new phase here (`Execute Phase 78: <title>`), and the AI follows the `CLAUDE.md` Present → Discuss → Choose → Plan → Code workflow.

---

## BUILD ORDER — QUICK REFERENCE

All phases are complete; the full table with per-phase summaries lives in [`ROADMAP_DONE.md`](ROADMAP_DONE.md).

| Phases | Milestone | Status |
|--------|-----------|--------|
| 0-61 | M1-M6 (MVP → Expansion) | DONE |
| 62-64 | M2/M3 (overlay resize, batch distribution, streaming timeout) | DONE |
| 65-77 | **M7 — Professionalization & Hardening** | DONE (2026-06-25) |

> **Milestone key**: M1 = MVP, M2 = Features, M3 = Robustness, M4 = Quality, M5 = Distribution, M6 = Expansion, **M7 = Professionalization & Hardening**.
> **Status format**: `DONE (YYYY-MM-DD)` · `IN PROGRESS` · `BLOCKED (reason)` · `TODO` = not started.
