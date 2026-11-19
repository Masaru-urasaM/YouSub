# YouSub — Active TODO

> **Updated**: 2026-11-19 · **Status**: **Firefox AMO `v0.2.5` LIVE · Chrome Web Store `v0.2.5` Pending Review** · **Verified**: 743/743 tests green (48 suites, `88.59%` stmts / `91.03%` lines) · ESLint `0` · Prettier clean · Chrome & Firefox ZIPs `[VERIFY OK]`
> Completed engineering phases (`0–85` + Post-85 Release Automation) are archived in [`ROADMAP_DONE.md`](ROADMAP_DONE.md), [`CHANGELOG.md`](CHANGELOG.md), and [`YOUSUB_DESIGN_DECISIONS.md`](YOUSUB_DESIGN_DECISIONS.md).
> **Architecture & Mission**: [`CONTEXT.md`](CONTEXT.md) · [`YOUSUB_PROJECT_SPEC.md`](YOUSUB_PROJECT_SPEC.md) · [`ROADMAP.md`](ROADMAP.md).

---

## Completed Recently (Milestone 8 & Store Submissions — 2026-11-18)

All 5 Milestone 8 engineering phases (Firefox Mobile `m.youtube.com` + 3-tier Audio/Video Auto-Resume Suite), dark-theme UI contrast polish, automated release tooling (`scripts/publish.js`, `.github/workflows/release.yml`), Privacy Policy Gist sync, and Store submissions for `v0.2.5` are complete:
- **Privacy Policy Gist**: Synced `15f9846972ccb68a120d29e988f42847` (`November 18, 2026`).
- **Firefox Add-ons AMO (`yousub@xinh.tools`)**: **APPROVED & LIVE `v0.2.5`** (`https://addons.mozilla.org/addon/yousub/`, Version ID `6728292`, Desktop `>= 128.0` + Android `>= 128.0`). `.env` `FIREFOX_AMO` updated.
- **Chrome Web Store (`jlpgmjpekhnlncfdkmddoienleiljehk`)**: Draft Privacy justifications updated; initial `0.2.5` rejected by automated check for `Yellow Argon` (*Keyword Spam* on stacked LLM provider names in `en` & `ja` descriptions) → cleaned both `en` & `ja` descriptions to brand-free wording and **resubmitted `v0.2.5`** (`Pending review`; `v0.2.0` currently live).
- **GitHub repository sync (`Masaru-urasaM/YouSub`)**: Pushed Milestone 7/8 + release automation changes to `origin/master` and configured GitHub Actions secrets for `.github/workflows/release.yml`.

*(Details archived in [`ROADMAP_DONE.md`](ROADMAP_DONE.md#milestone-8--firefox-mobile--cross-platform-audiovideo-auto-resume-suite-phases-8185).)*

---

## Remaining Actions (Developer / Post-Approval)

- [ ] **Post-approval Chrome Web Store doc sync** *(once Chrome Web Store approves `v0.2.5` `Pending review` live)*:
  - Flip Chrome Web Store status `"pending review"` → `"live v0.2.5"` in [`CLAUDE.md`](CLAUDE.md), [`README.md`](README.md), [`YOUSUB_PROJECT_SPEC.md`](YOUSUB_PROJECT_SPEC.md), and [`MEMORY.md`](MEMORY.md).
  - *(Optional)* Verify AMO listing screenshots under **Edit Listing** (`https://addons.mozilla.org/en-US/developers/addon/yousub/versions/6728292`), and remove the extra `yousub-publisher@...` entry from CWS Settings → *Trusted tester accounts* (keep it in *Service account*).
- [ ] **Manual real-browser smoke verification**: Install/update from Firefox AMO on Firefox Desktop + Firefox for Android (`https://addons.mozilla.org/addon/yousub/`) and test cross-device Audio/Video Auto-Resume (`www.youtube.com` ↔ `m.youtube.com`, Chrome Desktop ↔ Firefox Desktop/Android).
- [ ] **Local disk hygiene**: Move personal résumé `assets/icons/グエンバンフアン履歴書.docx` (and optional backup files `icons.zip`, `icon128-original.png`) outside the workspace (already excluded from git and release ZIPs).

---

## Deferred (Trigger-Gated)

- **DEFERRED D8** — `LanguageDetector` source-language detection ([`DEFERRED.md`](DEFERRED.md)). Revisit only when on-device Chrome `Translator` models are observed resident as `'available'`.
