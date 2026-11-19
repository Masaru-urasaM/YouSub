# YouSub — Active TODO

> **Updated**: 2026-11-19 · **Status**: **Milestone 9 COMPLETE (`v0.2.6`) — Firefox AMO `v0.2.5` LIVE / `v0.2.6` Submitted (`6731209`) · Chrome Web Store `v0.2.0` Live / `v0.2.5` Pending Review** · **Verified**: **773/773** tests green (**51** suites, `87.29%` stmts / `89.85%` lines) · ESLint `0` · Prettier clean · `addons-linter` 0 errors · Chrome & Firefox `v0.2.6` ZIPs `[VERIFY OK]`
> Completed engineering phases (`0–91` + Post-91 Store Visual Media Kit) are archived in [`ROADMAP_DONE.md`](ROADMAP_DONE.md), [`CHANGELOG.md`](CHANGELOG.md), and [`YOUSUB_DESIGN_DECISIONS.md`](YOUSUB_DESIGN_DECISIONS.md).
> **Architecture & Mission**: [`CONTEXT.md`](CONTEXT.md) · [`YOUSUB_PROJECT_SPEC.md`](YOUSUB_PROJECT_SPEC.md) · [`ROADMAP.md`](ROADMAP.md).

---

## Completed Recently (Milestone 9 & `v0.2.6` Release — 2026-11-19)

All Milestone 9 phases (`86–91` + `Post-91` Store Visual Media Kit), `v0.2.6` version bump, and Firefox AMO submission are complete:
- **Phases 86–91**: Mobile in-page floating pill & Glassmorphism Bottom Sheet drawer (`mobile-drawer.js`), Smart Sleep Timer (5s smooth volume fade-out + auto-pause + `"Sleep stop"` bookmark), Labeled Bookmark Notes + Per-Channel Speed Memory + A–B Repeat Loop, Opt-In Smart Auto-Enable (`manual` default | `smart_auto` | `always_auto`), Translation Style Presets + Custom Glossary + Video/Channel Metadata Context, and 30-Second BYOK Onboarding Wizard + Token/30-Day Cache Savings Dashboard (`usage-stats.js`).
- **Post-91 Store Visual Media Kit (`assets/store/`)**: 5 crisp `1280x800` screenshots (`01–05-*.png`), 20-frame looping walkthrough `yousub-demo.gif` (`960x600`), and reproducible `showcase.html` (excluded cleanly from distribution ZIPs in `scripts/package.js`).
- **Store Status (`2026-11-19`)**:
  - **Firefox Add-ons AMO (`yousub@xinh.tools`)**: `v0.2.5` live (`https://addons.mozilla.org/addon/yousub/`); **`v0.2.6` submitted** via `npm run publish:firefox` (`Version ID 6731209`, `listed`, Desktop + Android `>= 128.0`, awaiting automated/review signing).
  - **Chrome Web Store (`jlpgmjpekhnlncfdkmddoienleiljehk`)**: Live `v0.2.0`; **`v0.2.5` currently `PENDING_REVIEW`** — kept `dist/yousub-v0.2.6-chrome.zip` ready locally without overwriting the active `v0.2.5` review queue.

---

## Remaining Actions (Developer / Post-Approval)

- [ ] **Publish `v0.2.6` to Chrome Web Store** *(once CWS finishes reviewing `v0.2.5`)*:
  - Run `npm run publish:chrome` to upload & publish `dist/yousub-v0.2.6-chrome.zip` via CWS API v2, then sync Chrome Web Store status in docs.
- [ ] **Upload Store Listing Visual Media Kit (`assets/store/`)**:
  - Upload `assets/store/01-dual-subtitles.png` through `05-byok-presets-glossary.png` in **Chrome Web Store Developer Console → Store listing → Screenshots** and **Firefox AMO → Manage Listing → Images** (plus `assets/store/yousub-demo.gif` on AMO).
  - *(Optional)* Remove extra `yousub-publisher@...` entry from CWS *Trusted tester accounts* (keep it in *Service account*).
- [ ] **Manual real-browser smoke verification (`v0.2.6`)**: Verify Android in-page Bottom Sheet, 5s Sleep Timer fade-out, Labeled Bookmarks, A–B Loop, and Smart Auto-Enable live across Desktop + Firefox Android (`m.youtube.com`).
- [ ] **Local disk hygiene**: Personal résumé `assets/icons/グエンバンフアン履歴書.docx` remains intentionally untouched on local disk (excluded from git and release ZIPs). Move it outside the workspace whenever convenient.

---

## Deferred (Trigger-Gated)

- **DEFERRED D8** — `LanguageDetector` source-language detection ([`DEFERRED.md`](DEFERRED.md)). Revisit only when on-device Chrome `Translator` models are observed resident as `'available'`.
