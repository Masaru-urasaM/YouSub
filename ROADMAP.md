# YouSub — Development Roadmap

> **Hub**: [YOUSUB_PROJECT_SPEC.md](YOUSUB_PROJECT_SPEC.md) (architecture, data flow, appendices)
> **Version**: 4.0
> **Last updated**: 2026-04-09
> **Total phases**: 36 (Phases 0-48 = archived, Phase 49+ = active/pending)

---

## INSTRUCTIONS FOR AI ASSISTANT — READ THIS ENTIRE SECTION BEFORE EVERY SESSION

### How to Use This Document

This file is the **single source of truth** for all development work on YouSub. Before doing ANY work, you MUST:

1. Read `GEMINI.md` — contains hard rules for your behavior
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
4. **If a phase is too large**: split it into sub-phases (e.g., Phase 5a, Phase 5b). Each sub-phase = one prompt.
5. **Always wait for developer confirmation** before starting the next phase.

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
When you receive this, follow the GEMINI.md workflow: Present -> Discuss -> Choose -> Plan -> Code.

---

## BUILD ORDER — QUICK REFERENCE

| Phase | Description | Status | Milestone |
|-------|-------------|--------|-----------|
| 0-48 | Core infrastructure, optimization, premium UI, smart extraction/caching/parsing, incremental translation, ESM Refactor, Error Notifications, Live API Sync, Dual Mode Fix, Cache Transparency, Timestamp Tracking, Merge Propagation, Dashboard Stability, Security (Trusted Types), Batch Optimization, Stability Patch (Wait Fix/Key Trimming), Diagnostic/Permission Patch, Deep Diagnostic/Sanitization, UI/Background Sync/State Hardening, and **Anti-Deadlock/Stability Overhaul** | DONE (2026-04-09) | M5 |
| 49   | Production Bundling & Log Management   | TODO               | M5 |

> **Status format**: `DONE (YYYY-MM-DD)` · `IN PROGRESS` · `BLOCKED (reason)` · empty = not started

---

## DETAILED PHASE SPECIFICATIONS

> **Status format**: `DONE (YYYY-MM-DD)` · `IN PROGRESS` · `BLOCKED (reason)` · empty = not started
>
> **Milestone key**: M1 = MVP, M2 = Features, M3 = Robustness, M4 = Quality, M5 = Distribution
