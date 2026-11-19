# YouSub — Development Roadmap

> **Hub**: [YOUSUB_PROJECT_SPEC.md](YOUSUB_PROJECT_SPEC.md) (architecture, data flow, appendices)
> **Version**: 10.2
> **Last updated**: 2026-11-19
> **Status**: **Milestone 9 COMPLETE (`v0.2.6`) — Firefox AMO `v0.2.5` LIVE / `v0.2.6` Submitted (`6731209`) · Chrome Web Store `v0.2.0` Live / `v0.2.5` Pending Review (`v0.2.6` ZIP staged locally).** Latest verified gate: **773/773 tests** across **51 suites** (`87.29%` stmts / `72.82%` branches / `84.11%` funcs / `89.85%` lines), ESLint `0`, Prettier clean, `addons-linter` 0 errors, Chrome & Firefox `v0.2.6` ZIPs `[VERIFY OK]`. Full phase history (`0–91` + Post-91) is archived in [`ROADMAP_DONE.md`](ROADMAP_DONE.md).

---

## INSTRUCTIONS FOR AI ASSISTANT — READ THIS ENTIRE SECTION BEFORE EVERY SESSION

### How to Use This Document

This file is the **single source of truth** for active/upcoming development work on YouSub. Before doing ANY work, you MUST:

1. Read `CLAUDE.md` — the single canonical hard-rules file for your behavior
2. Read this file (`ROADMAP.md`) — contains current status and any active upcoming phases
3. Read `ROADMAP_DONE.md` — contains all completed phases (including Milestone 8 Details)
4. Read `YOUSUB_DESIGN_DECISIONS.md` — contains resolved architectural decisions (Decisions 1–23; do NOT re-propose rejected approaches)

For architecture diagrams, data flows, folder structure, YouTube references, and API specs — see [YOUSUB_PROJECT_SPEC.md](YOUSUB_PROJECT_SPEC.md).

### Phase Execution Protocol — STRICTLY ENFORCED

```
ONE PROMPT = ONE PHASE. NO EXCEPTIONS.
```

**Rules**:
1. **Never execute more than one phase in a single prompt.** If you finish Phase N, STOP. Do NOT start Phase N+1.
2. **Execute strictly in order** when a multi-phase milestone is queued. Each phase builds on verified exports from the prior phase.
3. **Never write code without checking existing module patterns first**:
   - All extension code must be written **100% in English** (no Vietnamese in code, comments, or commit messages).
   - **No build step / bundler**: all ES module files imported by content scripts (`src/shared/*`, `src/content/*`) MUST be listed in `manifest.json` → `web_accessible_resources[0].resources`. All `MAIN` world scripts MUST be registered declaratively in `manifest.json` → `content_scripts[0].js` (`world: "MAIN"`, `run_at: "document_start"`).
   - Use `browser.*` (with `src/shared/libs/browser-polyfill.js`) or guarded `chrome.*` consistently with neighboring code in the file you edit.
   - Maintain Trusted Types compliance in `src/content/*`: never inject raw HTML strings into YouTube DOM without `TrustedTypes.toSafeHTML(...)`, or prefer safe DOM element builders (`document.createElement` + `textContent`).
   - Do NOT touch `MAX_LINES_PER_BATCH` in `src/background/translator.js` (Rule 12).
4. **After completing any phase**:
   - Run `npm run test:log` (all tests must pass; test count must increase monotonically)
   - Run `npm run lint` (0 errors, 0 warnings)
   - Run `npm run format:check` (clean; run `npx prettier --write` if needed)
   - Run `npm run package` (verify both Chrome & Firefox ZIPs pass `[VERIFY OK]`)
   - Update `CHANGELOG.md` under `## [Unreleased]`, mark the phase `DONE (YYYY-MM-DD)` in `ROADMAP.md`, archive completed phase details into `ROADMAP_DONE.md`, update `TODO.md` checkboxes, and update `MEMORY.md` (`CLAUDE.md` Rule 4 & Rule 10).
   - Report results to developer and propose the next phase, then wait for confirmation.

---

## ACTIVE & UPCOMING WORK

Milestone 8 (`Phases 81–85`) and Milestone 9 (`Phases 86–91` + `Post-91` Visual Media Kit, `v0.2.6`) are 100% complete and archived in [`ROADMAP_DONE.md`](ROADMAP_DONE.md). Remaining operational post-approval items live in [`TODO.md`](TODO.md#remaining-actions-developer--post-approval), and only **DEFERRED D8** (`LanguageDetector` — dormant pending resident on-device `Translator` models; see [`DEFERRED.md`](DEFERRED.md)) remains deferred.

---

## CURRENT STATUS — `v0.2.6` Released to Firefox AMO & Staged for Chrome Web Store (2026-11-19)

- **Quality gate**: **773/773 tests green** across **51 suites** (`87.29%` stmts / `72.82%` branches / `84.11%` funcs / `89.85%` lines), ESLint `0`, Prettier clean, `addons-linter` **0 errors**, `dist/yousub-v0.2.6-{chrome,firefox}.zip` (`68` files, `0.71 MB`) `[VERIFY OK]`.
- **Firefox Add-ons (AMO)**: **LIVE `v0.2.5`** + **`v0.2.6` submitted** (`Version ID 6731209`, `https://addons.mozilla.org/addon/yousub/`, `yousub@xinh.tools`, Desktop + Android `>= 128.0`).
- **Chrome Web Store**: Extension `jlpgmjpekhnlncfdkmddoienleiljehk` (`v0.2.0` live, `v0.2.5` currently `PENDING_REVIEW` — `dist/yousub-v0.2.6-chrome.zip` ready for `npm run publish:chrome` once `v0.2.5` clears review).
- **Store Media Kit**: `assets/store/` contains 5 `1280x800` screenshots + `yousub-demo.gif` (excluded from extension ZIPs via `scripts/package.js`).
- **Privacy Policy**: Canonical Gist `15f9846972ccb68a120d29e988f42847` synced to `November 18, 2026`.

---

## BUILD ORDER — QUICK REFERENCE

| Phases | Milestone / Area | Status |
|--------|------------------|--------|
| 0–61 | M1–M6 (MVP → Expansion) | DONE |
| 62–64 | M2/M3 (Overlay resize, batch distribution, streaming robustness) | DONE |
| 65–77 | **M7 — Professionalization & Hardening** | DONE (2026-06-25) |
| 78–80 | **Post-M7 Extensions** (Gemini fallback, Coalescer/Seek, Sparrow Telemetry) | DONE (2026-11-18) |
| Post-80 | **[Hotfix] Stabilization** (Overlay UX, `world: "MAIN"` silent extract, alignment v2) | DONE (2026-11-18) |
| 81–85 | **M8 — Firefox Mobile (`m.youtube.com`) & 3-Tier Audio/Video Auto-Resume Suite** | DONE (2026-11-18) |
| Post-85 | **Dark-Theme Popup Polish, CI/CLI Store Release Automation & `v0.2.5` Submissions** | DONE (2026-11-18) |
| 86–91 | **M9 — Mobile Drawer, Sleep Timer, Bookmarks/Speed/A–B, Smart Auto-Enable, Glossary & Onboarding** | **DONE (2026-11-19)** |
| Post-91 | **Store Listing Visual Media Kit (AMO & CWS Screenshots + Demo GIF) & `v0.2.6` Release** | **DONE (2026-11-19)** |

> **Milestone key**: M1 = MVP, M2 = Features, M3 = Robustness, M4 = Quality, M5 = Distribution, M6 = Expansion, M7 = Professionalization & Hardening, M8 = Firefox Mobile & Cross-Platform Audio/Video Auto-Resume Suite, M9 = Mobile In-Page UX, Smart AI Context & Audiobook Power Suite.
> **Status format**: `DONE (YYYY-MM-DD)` · `IN PROGRESS` · `BLOCKED (reason)` · `TODO` = not started.
