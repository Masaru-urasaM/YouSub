# YouSub — Active TODO

> **Updated**: 2026-11-17 · **Baseline**: 583/583 tests green (36 suites) · coverage **88.8% stmts / 75.1% branches / 88.8% funcs / 90.1% lines** (gate `84/72/84/85`) · ESLint 0 · Prettier clean · `npm audit` **0 vulnerabilities** · both v0.2.4 ZIPs `[VERIFY OK]`
> Previous technical-debt backlog (`T1–T17`, `T19–T21`) completed and archived in [`CHANGELOG.md`](CHANGELOG.md).

---

## Active Queue

_Empty — ready for the next task or feature phase._

---

## Manual / External (Developer Only)

- [ ] **Browser smoke test of v0.2.4** with a live API key (one normal video + one Shorts) + check `'Translator' in window` / `Translator.availability(...)` in page console.
- [ ] **Upload `dist/yousub-v0.2.4-chrome.zip`** (and Firefox ZIP if releasing there) to the store.
- [ ] **After 0.2.4 is live**: update `"shipped v0.2.2"` doc lines in `CLAUDE.md`, `README.md`, `YOUSUB_PROJECT_SPEC.md`.
- [ ] **Local disk cleanup**: move personal résumé `assets/icons/グエンバンフアン履歴書.docx` (and optional backup archives `icons.zip`, `icon128-original.png`) outside the project directory (already gitignored and excluded from ZIPs).

---

## Deferred (Trigger-Gated)

- **DEFERRED D8** — `LanguageDetector` source-language detection (`DEFERRED.md`). Revisit only when on-device `Translator` models are observed resident as `'available'`.
