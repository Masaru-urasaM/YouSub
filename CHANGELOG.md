# Changelog

All notable changes to the YouSub project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### [Hotfix] Chrome dev-load warning `'background.scripts' requires manifest version of 2 or lower` (2026-06-25)

**Problem**: Loading the project root unpacked in Chrome (the daily dev workflow) showed a warning on `chrome://extensions`. The source `manifest.json` carried **both** `background.service_worker` (Chrome MV3) and `background.scripts` (Firefox MV3) for cross-browser support; Chrome warns on the Firefox-only `scripts` key. Non-fatal (Chrome still loads via `service_worker`), but noise. The shipped ZIPs were already clean — the build strips the foreign key per platform.

**Changed**

- `manifest.json` — removed the Firefox-only `"scripts": ["src/background/service-worker.js"]` line from `background`; the source manifest is now Chrome-clean (`service_worker` + `type: module` only) → no `chrome://extensions` warning on dev-load.
- `scripts/package.js` — the Firefox build transform now **injects** `background.scripts` (derived from the `service_worker` path) before deleting `service_worker`, instead of relying on it being present in source. The Chrome transform is unchanged (its `delete m.background.scripts` is now a defensive no-op). Firefox ZIP output is functionally identical (key order differs only).
- `scripts/package.js` — hardened `verifyZip`: the Firefox ZIP is now asserted to **contain** `background.scripts` (catches a regression in the new transform).

**Decision rationale**: Developer confirmed YouSub is only ever tested/released on **Chrome** (never Firefox), so making the source manifest Chrome-clean has no downside. (Tradeoff noted: this would break Firefox dev-from-source, which Firefox stable can't run with `service_worker`-only — but that workflow does not exist here. The Firefox **ZIP** build remains correct for any future Firefox release.)

**Verification**: `node scripts/package.js all` → both `[VERIFY OK]` (Chrome ZIP `{service_worker, type}`, Firefox ZIP `{scripts, type}`, source `{service_worker, type}`); full suite **468/468 passed**. **Manual**: developer reloads the source-unpacked extension in Chrome to confirm the warning is gone (the native "Load unpacked" dialog / privileged `chrome://extensions` page can't be driven by automation).

### DEFERRED Backlog — D4 resolved: scrub résumé + junk from git history (2026-06-25)

**Security / hygiene (developer-approved, destructive history rewrite)**

- Rewrote the full local git history with `git filter-repo --invert-paths` to purge 4 blobs that were untracked (`git rm --cached` in Phase 73) but still retrievable from history: the personal résumé `assets/icons/グエンバンフアン履歴書.docx` and 3 junk binaries (`icon128-original.png`, `icons.zip`, `tests/unit/jest_output.txt`).
- The résumé was matched via `regex:.*\.docx$` (the only `.docx` in history) after a literal UTF-8 paths-file entry failed to match the non-ASCII filename — a Windows/encoding quirk caught by the mandatory **dry-run** before the real run.
- **Safety**: a full-history `git bundle` backup (`../yousub-pre-d4-scrub.bundle`) was created **and restore-verified** (test-clone → 44 commits, blob present) before the rewrite.
- **Result**: all **44 commits preserved**, only the blobs removed; commit hashes changed (HEAD `883800d` → `9428c69`); `master` + working tree intact; **full suite 468/468 green**; **build VERIFY OK** (both ZIPs, 49 files). No remote exists, so only the local repo was affected; the on-disk untracked copies remain (gitignored).
- **Verification**: `git rev-list --all --objects | grep -iE 'docx|履歴書|icon128-original|icons.zip|jest_output'` returns nothing; `git cat-file -e <résumé-blob>` now fails (gone).

### DEFERRED Backlog — D7 resolved: CSS dedup investigated, declined (2026-06-25)

**Investigated, no code change (developer-approved outcome)**

- Compared `src/popup/popup.css` vs `src/options/options.css` rule-by-rule. The "duplicated modal/button CSS" turned out to be **shared selector names with divergent values**, not real duplication: only `.modal-overlay` + `@keyframes modalFadeIn` are byte-identical. `.secondary-btn`, `.modal-content`, `.danger-btn`, `modalSlideUp`, and the modal heading/body rules all differ by design (compact hard-coded popup vs wider CSS-variable options, with a different modal DOM — `.modal-content h3`/`p` vs `.modal-header h3`/`.modal-body p`). Merging would risk the visual regression the deferral flagged; extracting only the 2 identical blocks would split the `modalSlideUp` pair for ~15 lines. **D7 closed as "investigated — not meaningfully dedupable"; no files changed.**

### DEFERRED Backlog — D6 (extraction): tryKeyForBatch split, behavior-preserving (2026-06-25)

Developer-approved during the backlog pass. Done behind the just-built characterization gate.

**Changed — `src/background/translator.js`**

- Extracted the provider-call **retry loop** out of `tryKeyForBatch` into a new `callProviderWithRetry({...}) → { result, duration }` helper (verbatim move; same transient-only retry on Timeout/5xx, `RETRY_ATTEMPTS`, `wait`, break conditions).
- Extracted the **timestamp text parser** block into a new `parseTimestampedText(responseText, segments) → { lines, validCount }` helper (verbatim; mirrors `parseJsonResponse`'s shape). The threshold / finalize / `parse_fail` / `quality_fail` decisions stay in `tryKeyForBatch`.
- Verified by reading `git diff`: both function bodies are **character-identical** to the removed blocks (sole deltas — `callProviderWithRetry` adds `return { result, duration }`; `parseTimestampedText` reads its `responseText` param instead of `result.text`). The only other change is the two call-site replacements + the `_internals` export.

**Added**

- `parseTimestampedText` exposed via `_internals`; 6 focused unit tests in `tests/unit/translator-helpers.test.js` (in-order mapping, zero-match→originals, duplicate-timestamp FIFO `shift()`, consecutive-tag accumulation, `#<n> ` index-marker strip, partial-match fallback) — the branches the `translate()` harness does not pin directly.

**Tests**: 462 → **468** (+6). Full suite green; the D6-gate harness (5xx-retry, text-parse, 413-split, accept-on-last-key) passes unchanged, confirming the move is behavior-preserving.

**⚠ Manual verification still required (developer)**: the harness deliberately stubs the sanitize / foreign-script / untranslated-re-translation / MergeFixer cascades, so the unit suite proves the *move* but not the full shipped translation path. A browser smoke-test (one real video + one Shorts with a live API key) is recommended before the next release.

### DEFERRED Backlog — D6 (gate): translator characterization harness extended (2026-06-25)

**Added**

- `tests/unit/translator-translate.test.js` — 4 characterization tests pinning the previously-uncovered branches of `tryKeyForBatch` (the stated gate for any future D6 extraction): (1) a 5xx transient failure retries the **same** key and recovers (drives the `wait(RETRY_DELAYS_MS[0])` retry through fake timers); (2) a non-JSON timestamped-text response falls through to the `[HH:MM:SS]` text parser and maps lines in order; (3) a 413 on the full batch triggers the failover layer's recursive split and still translates every line; (4) a zero-valid-line JSON response is accepted on the last/only key (accept-on-last-key escape hatch), preserving the originals. Each asserts observable outputs/decisions of `translate()`, not line execution.

**Tests**: 458 → **462** (+4). Full suite green; coverage gate passes.

**Still deferred (D6)**: the actual structural extraction of the retry loop / text parser out of `tryKeyForBatch` is cleanliness-only on the shipped core and is left for an explicit developer go-ahead — the harness is the safe, valuable half; the extraction is the risky half.

### DEFERRED Backlog — D5 (partial): high-severity `ws` advisory closed (2026-06-25)

**Security (dev-only toolchain)**

- `package.json` — added an `overrides: { "ws": "^8.21.0" }` entry forcing the transitive `ws` dependency (`jest-environment-jsdom → jsdom@26 → ws@8.20.0`) to the patched `8.21.0`, closing the single **high**-severity advisory (`GHSA-58qx-3vcg-4xpx` uninitialized-memory disclosure + `GHSA-96hv-2xvq-fx4p` memory-exhaustion DoS). `ws` is **dev-only** (absent from the shipped extension ZIP), so this is hardening, not a user-facing exposure — but the override is clean: lockfile diff is 3 lines and the full suite stays 458/458 green.

**Investigated, intentionally NOT applied**

- A plain `npm audit fix` (no `--force`) was tried and **reverted** — it reshuffles jest's internal package tree and breaks the whole suite with `TypeError: this._moduleMocker.clearMocksOnScope is not a function` (jest-runtime ↔ jest-mock version desync). The remaining advisories live in the `babel-jest` / `@jest/transform` / `babel-plugin-istanbul` dev chain and need a deliberate jest/babel major migration — kept deferred (D5).

**Audit**: 19 → **18** vulnerabilities (1 high removed; 1 low + 17 moderate remain, all dev-only). **Tests**: 458/458 unchanged.

### DEFERRED Backlog — D3 resolved (2026-06-25)

**Fixed**

- `src/background/providers.js` — the default `Providers.chat()` timeout message now derives from the actual `timeoutMs` (`` `Request timed out (${Math.round(timeoutMs / 1000)}s)` ``) instead of a hardcoded "30s". The default `timeoutMs` is 15000, so the old literal misreported every default abort as "(30s)"; the message now reads "(15s)" by default and reflects any caller-supplied `timeoutMs`. A caller-supplied `timeoutMsg` still takes precedence. Only the `chat()` 336–337 mismatch was touched — the genuine 30s defaults on the `fetchQuota()` path (lines 33/172) are unrelated and left alone.

**Added**

- `tests/unit/providers.test.js` — 2 tests pinning the derived message: default abort → "Request timed out (15s)", and a caller-supplied `timeoutMs: 90000` → "Request timed out (90s)". The existing custom-`timeoutMsg` and `/timed out/i` tests still pass unchanged.

**Tests**: 456 → **458** (+2). Full suite 458/458 green; coverage gate passes.

**Left deferred (out of scope)**: the two harmless dead-defensive branches noted alongside D3 (`chat()` "Unknown API style" return, `fetchQuota()` trailing `return null`) — defense-in-depth, reachable only on a corrupted provider registry.

### DEFERRED Backlog — D1 + D2 resolved (2026-06-25)

Closing out the post-Milestone-7 deferred backlog (see `DEFERRED.md`). This entry covers **D1** (code + test) and **D2** (doc-only — re-confirmed already resolved in Phase 76).

**Added**

- `src/shared/utils.js` — exported `escapeHtml(s)`, the HTML-metacharacter escaper extracted **verbatim** from the un-exported `esc()` closure in `src/content/main.js` (DEFERRED D1). Scope unchanged: `& < >` only (text-node contexts; no quote escaping), `&`-first replacement order, `String(s || '')` falsy→`''` coercion.
- `tests/unit/utils.test.js` — 13 `escapeHtml` tests locking behavior: falsy coercion (`null`/`undefined`/`0`/`''`), `&`/`<`/`>` escaping, `&`-first double-escape ordering (`&lt;` → `&amp;lt;`), quote-scope exclusion, and crafted `<script>` / `<img onerror>` API-error payloads.

**Changed**

- `src/content/main.js` — imports `escapeHtml as esc` from `../shared/utils.js` and removed the local 5-line `esc` closure; all six `esc(...)` call sites are **byte-identical** (behavior-preserving). Comment updated to note the import.
- `DEFERRED.md` — moved D1 + D2 from the active list to a new `## Resolved` tombstone section.

**Tests**: 443 → **456** (+13). Full suite 456/456 green; coverage gate passes; `eslint` 0 on touched files; `utils.js` now 100% covered.

### Phase 77b — Japanese UI Internationalization (2026-06-25)

Adds full Japanese UI localization via the standard WebExtensions `i18n` API, with graceful English fallback for any untagged/missing string.

**Added**

- `_locales/en/messages.json` + `_locales/ja/messages.json` — Chrome-format catalogs, **identical key set** (98 keys each), every entry a non-empty `message`. JA translations are natural (not literal MT): "翻訳" / "設定" / "外観" / "概要" / "二言語字幕" / "APIキー", `YouSub` kept as a brand.
- `src/shared/i18n.js` — `applyI18n(root = document)` ESM helper. Localizes `data-i18n` (textContent) + `data-i18n-placeholder` / `data-i18n-aria-label` / `data-i18n-title` (attributes); only applies a message when `getMessage` is non-empty, so missing keys keep the hardcoded English.
- `tests/unit/i18n.test.js` — 8 tests: locale-catalog validity + identical-key-set + non-empty + placeholder parity; `applyI18n` DOM text/attribute wiring, graceful fallback, and cloned-template path.

**Changed**

- `manifest.json` — added `"default_locale": "en"`. `name`/`description` left **literal** (deliberate: "YouSub" is a brand; localizing `name` is a no-op and keeps the identical-key-set test clean).
- `src/popup/popup.html` + `src/options/options.html` — `data-i18n*` tags on the visible static UI (incl. the cloned `api-key-row` template labels/placeholders/titles).
- `src/popup/popup.js`, `src/options/options.js`, `src/options/tab-translation.js` — import + call `applyI18n` on load (and `applyI18n(clone)` per rendered API-key row); the most visible **dynamic** strings (translate-button label, health statuses, clear-cache flow, save indicator, row enable/disable/show-hide/not-tested) now resolve via `browser.i18n.getMessage` with English fallback.
- `scripts/package.js` — added `'_locales'` to `includeList` so the folder is packaged. **Verified**: both ZIPs contain `_locales/en/messages.json` + `_locales/ja/messages.json`, `default_locale=en` survives the manifest transform.
- `tests/mocks/chrome.js` — added a `chrome.i18n` mock (`getMessage` loads `_locales/en/messages.json`, applies `$NAME$`/`$N$` substitutions, falls back to ''; load wrapped in try/catch so a path slip can't wipe the suite) + `getUILanguage`.

**Scope notes**: content-script **overlay** status strings were **skipped** (optional per the phase brief; overlay is a content script that would also need a `web_accessible_resources` entry — deferred). OK/Failed API-test status lines that embed server text are left literal.

**Tests**: 435 → **443** (+8). Full suite **443/443** green; `eslint .` = 0; `prettier --check` clean on touched files; `npm run package` VERIFY OK both platforms; `manifest.json` valid JSON.

### Phase 77a — Transcript-Button Locale Resilience (2026-06-25)

Makes the fast DOM-scrape path work on non-English YouTube UIs (e.g. Japanese), instead of falling back to the slow Innertube path.

**Changed — `src/content/main-world-extractor.js` `findTranscriptButton()`**
- Strategy B (aria-label): `button[aria-label="Show transcript"]` (English exact) → `button[aria-label*="transcript" i], button[aria-label*="文字起こし"]` (EN case-insensitive substring + JA).
- Strategy D (text search): exact `'show transcript'`/`'transcript'` → a label list `['show transcript', 'transcript', '文字起こしを表示', '文字起こし']`.
- The primary, **language-agnostic** structural selectors (`ytd-video-description-transcript-section-renderer`, Strategies A/C) are unchanged — they already work in any locale; this hardens the aria-label/text fallbacks.

**Scope note**: per the project's hard rule (code in English + Japanese only, never Vietnamese), the label list is EN + JA; other locales are covered by the structural selectors. `main-world-extractor.js` is a page-injected MAIN-world script (not unit-testable in jsdom, consistent with the Phase 69 coverage finding) — verified by lint + the full suite (435 green, no regression) + build VERIFY OK.

### Phase 76 — UI/UX Accessibility + Hygiene (2026-06-25)

Adds accessibility to the popup + options UI and fixes UI hygiene items. Surgical — no redesign. Full suite **429 → 435** green; lint 0; `npm run package` VERIFY OK.

**Accessibility (76a)**
- **Options tabs** → full ARIA tab pattern: `role="tablist"` / `role="tab"` (with `id`, `aria-controls`, `aria-selected`, roving `tabindex`) / `role="tabpanel"` (`aria-labelledby`). `options.js` `setupTabs` now syncs `aria-selected`/`tabindex` on switch and supports ArrowLeft/ArrowRight focus movement.
- **Confirm modals** (both popup & options) → `role="dialog"`, `aria-modal="true"`, `aria-labelledby`/`aria-describedby`; both `showConfirmModal` helpers now move focus to the cancel button on open, close on **Escape**, and return focus to the opener on close.
- **Icon-only ✕** button (`delete-custom-model`) → `aria-label`. **Popup** `health-status` + `loading` → `role="status"` `aria-live="polite"`.

**Hygiene (76c)**
- Dead About-tab links: removed the placeholder **GitHub Repository** link (private repo, no public URL); pointed **Report an Issue** at `mailto:` the contact address.
- `chrome.*` → `browser.*` in `tab-appearance.js` (1) and `tab-translation.js` (3) — the 3 callback-style calls were properly converted to `.then()` (the vendored polyfill returns Promises and rejects extra args; `permissions` confirmed supported).
- **Version badge from source of truth**: `options.js` now imports `Constants` and sets the header badge + About-tab version from `Constants.VERSION` (no more hardcoded `v0.2.2` drift risk).

**Added**: `tests/unit/options-a11y.test.js` (6 tests) asserting the ARIA wiring (tablist/tab/tabpanel + dialog) is present. **Tests 429 → 435.**

**Notes**
- DEFERRED **D2** (Appearance form population) — **RESOLVED**: investigation found `loadSettings()` already populates the form from `yousub_appearance`; the dead `loadAppearance()` removed in 67b was a duplicate. No fix needed.
- **76b** (deduplicate shared modal/button CSS) → **DEFERRED D7**: maintainability-only, needs visual-regression verification; the user-facing a11y + hygiene wins were prioritized.

### Phase 75c — Deduplicate `tryKeyForBatch` Post-Success Pipeline (2026-06-25)

The behavior-preserving decomposition (developer-approved go), gated by the Phase 75b harness + full suite + manual review.

**Changed — `src/background/translator.js`**
- `tryKeyForBatch` had **two near-identical ~95-line blocks** running the post-success pipeline (`MergeFixer.fix` → shifted-line re-translation → foreign-script sanitize → untranslated verification → final sanitize → build the success result) — one after a successful JSON parse, one after a successful text parse. They differed only in the input lines (`jsonResult.lines` vs `resultLines`) and the `hadFallback` signal.
- Extracted that pipeline **verbatim** into a single `finalizeSuccessfulBatch(rawLines, segments, key, tabId, options, hadFallback, result)` helper; both call sites now `report(true)` then `return await finalizeSuccessfulBatch(...)`. Net **−96 lines**, removes the duplication, no logic change.

**Why behavior-preserving**: the two blocks were byte-for-byte identical except the two parameterized values (verified by reading both); the helper is the same code with those two values passed in. The error branches (`parse_fail`/`quality_fail`/`413`/`429`/`error`/`exception`), the retry loop, and the JSON→text fallthrough are untouched.

**Verify**: full suite **429/429** green (incl. the 75b `translate()` harness: happy path, 429-failover, abort, input guards) + coverage gate exit 0; `npm run lint` 0; `prettier` clean. `translator.js` coverage 48.5% → **50.6%** (the shared helper is now hit by both paths).

**Scope note**: this completes Phase 75's headline win (de-duplication + the 75a health-score unify). Further structural splitting of `tryKeyForBatch` (extracting the retry loop / the text-timestamp parser into their own functions) is **lower-value, non-duplicated code on the shipped engine** and is left as optional future work (DEFERRED D6) rather than spent against the Phase 76/77 + deploy budget.

### Phase 75b — `translate()` Characterization Harness (2026-06-25)

Adds a behavior-pinning safety net for the translation orchestration, as the gate for the upcoming `tryKeyForBatch` decomposition (developer chose to proceed with the full refactor). Pure value regardless — advances the Decision-12-deferred translator coverage.

**Added — `tests/unit/translator-translate.test.js` (5 tests)**
- Drives the exported `translate()` end-to-end by mocking the `providers.js` **module** (`Providers.chat`/`chatStream`) — not `fetch` — and seeding `chrome.storage.local` with a config. Pins observable behavior (not line execution):
  - **Happy path**: N segments → same-length, in-order translated output, one batch call.
  - **Failover**: batch call #1 returns HTTP 429 → next attempt/key recovers; translation still completes.
  - **Abort**: an already-aborted `externalSignal` resolves fast with no batch calls.
  - **Input guards**: `[]` and all-invalid-segment inputs return `{ translated: [], hadFallback: false }` with zero provider calls.
- Mocks `merge-fixer.js` to a 1:1 pass-through and uses a `ja` target to keep the foreign-script/untranslated cascades out of scope for these baseline tests.

**Coverage**: `translator.js` **24% → 48.5%** lines. **Tests**: 424 → **429** (all green); gate exit 0.

**Honest scope note**: this pins the *common* paths (JSON-success, 429-failover, abort, guards) but not yet the 5xx-transient retry loop, the non-JSON text-parser fallback, 413/recursive-split, the parse/quality thresholds, or the real MergeFixer contract. The decomposition (75c) extends this and treats uncovered branches as verbatim-move-only.

### Phase 75a — Unify the Health-Score Formula (2026-06-24)

First slice of the [EPIC] Phase 75 translator refactor — the safe, behavior-preserving part.

**Context**: The key health score was computed by two divergent formulas — an inline copy in `api-manager.getValidKeys()` (10s speed cap) and `HealthManager.getScore()` (5s cap). Investigation found `getScore()` is **dead in production** (only called from tests); the live key-ordering uses the inline api-manager formula.

**Changed (behavior-preserving)**
- Added `HealthManager.computeScore(entry)` — the single source of truth, using the **live production 10s-cap** formula. `getScore()` and `api-manager.getValidKeys()` both now call it. Production key ordering is provably unchanged (same formula, hoisted); only the dead `getScore()` path changes (5s → 10s), and nothing in `src/` calls it.

**Added**
- 4 `computeScore` unit tests pinning the formula (neutral default, 10s-capped speed weighting, 0.1 floor, untimed no-penalty). `health.js` coverage 69% → 80%.

**Tests**: 420 → **424** (all green); `npm test` exit 0 with the coverage gate; lint + prettier clean.

**Note**: the rest of Phase 75 (decomposing the ~420-line `tryKeyForBatch`) is **gated on developer go/no-go** — it is pure structural cleanup of the shipped engine (no bug), and the translator suite can't yet certify behavior-identical. Characterization tests for the `translate()` path are being added first as the safety net (per Decision 12, which deferred deep translator coverage to Phase 75).

### Phase 74 — Privacy / Store Compliance (2026-06-24)

**Added**
- `privacy-policy.md` — in-repo mirror of the canonical published gist (`Masaru-urasaM/15f9846…`), with a header noting the gist is the store-linked source of truth. So the policy is now versioned in the repo, not solely an external gist.
- `YOUSUB_DESIGN_DECISIONS.md` **Decision 14** — documents the plaintext BYOK-key storage tradeoff (keep plaintext `chrome.storage.local`; passphrase encryption adds UX cost for little real-world gain).

**Changed — `manifest.json`**
- `browser_specific_settings.gecko.data_collection_permissions.required`: `["none"]` → **`["websiteContent"]`**. The extension transmits the YouTube transcript (website content) to the user's chosen third-party LLM, so declaring "none" was inaccurate. ⚠️ This Firefox key is relatively new — the developer should confirm the exact accepted category set against current AMO review guidance when next submitting to AMO.

**Verified (no change)**
- `translate.googleapis.com` host_permission is **in use** (`rough-translator.js:66`, the rough-translation tier's Google-Translate `translate_a/single` call) → kept, not removed.

**Verify**: `manifest.json` re-validated as JSON; `npm run package` builds Chrome + Firefox ZIPs with VERIFY OK.

### Phase 73 — Repo Hygiene Cleanup (2026-06-24)

Stops tracking committed junk and removes dead tooling. No source/behavior change; build output is byte-identical (the packager already skip-listed these files).

**Removed (untracked via `git rm --cached`, kept on disk)**
- Personal résumé `assets/icons/グエンバンフアン履歴書.docx`, `assets/icons/icons.zip`, `assets/icons/icon128-original.png`, `tests/unit/jest_output.txt`, `tmp/test_logic.js`, `tmp/test_parser.js`.

**Removed (deleted)**
- `tests/unit/translator_test.html` — stale manual test page.
- `resize_icons.js` — doubly-dead: hard-coded source path into another tool's temp folder + jimp v0.x API (`.resize(128,128).writeAsync`) incompatible with the installed jimp 1.6, and only emitted 3 of the 6 icon sizes. Not relocated (would need a rewrite to be usable).
- The orphaned **`jimp` dependency** (its only consumer was `resize_icons.js`) → `npm audit` **38 → 19** vulnerabilities. The remaining 19 are dev-only transitive deps (jest/eslint), not shipped (see DEFERRED D5).

**Changed**
- `.gitignore`: added `tmp/`, `*.docx`, `*.zip`, `*_output.txt`, `*-original.png`.
- `eslint.config.js`: dropped the now-unneeded `resize_icons.js` ignore; reworded the `tmp/**` ignore comment.
- `package.json` / `package-lock.json`: `jimp` removed.

**Notes**
- `src/debug/` is **kept** (developer-confirmed) — shipped advanced-diagnostics panel wired via `popup.js`; documented in the SPEC (Phase 71).
- **Privacy (DEFERRED D4)**: untracking does not scrub git history — the résumé `.docx` is still retrievable from past commits. Private repo → no urgent action, but it must be scrubbed (`git filter-repo`/BFG) before any public push.

**Verify**: `git status` clean; `npm run lint` 0; `npm test` 420/420 + coverage gate; `npm run package` produces valid Chrome + Firefox ZIPs (VERIFY OK, unchanged).

### Phase 72 — AI-Governance Consolidation (2026-06-24)

Makes `CLAUDE.md` the single canonical AI-rules file.

**Removed**
- `GEMINI.md` (deleted) — it was a near-verbatim duplicate of `CLAUDE.md` with "Gemini" substituted for "Claude". Its one unique item (the `MAX_LINES_PER_BATCH` "do not touch / stop blaming it" guard) was folded into `CLAUDE.md`.

**Changed — `CLAUDE.md`**
- Added **Rule 12** (do not change/propose changing `MAX_LINES_PER_BATCH` while diagnosing — it's not the cause of merge/timeout/alignment bugs) and **Rule 13** (single canonical rules file + post-v0.2.2 maintenance mode with `[Hotfix]` logging).
- Replaced the stale "A new software project / Tech Stack: To be determined" Project-Overview boilerplate with the real YouSub description and tech stack.
- Removed the phantom `PROMPT.md` from the Documentation Architecture table + Directory Structure; added `README.md`/`CONTEXT.md`; fixed the `.Claude/` casing.
- `ROADMAP.md`: updated the session-instructions note — `GEMINI.md` is now retired, not "being retired".

**Verify**: a single source of AI rules; the only remaining "Gemini" references are the LLM provider (CHANGELOG/SPEC), not the retired file. `CONTEXT.md` confirmed to exist (kept in the doc map).

### Phase 71 — SPEC Reconciliation + README (2026-06-24)

Brings the documentation back in line with the shipped code.

**Changed — `YOUSUB_PROJECT_SPEC.md`**
- Removed three phantom files from §2.5/§2.7 (audit-confirmed never existed): `src/content/toast.js` (status messaging lives in `overlay.js` `showStatus`), `src/options/tab-about.js` (About tab is inline markup in `options.html`), `assets/options/logo.svg` (page uses PNG icons).
- Rewrote §2.6 (module pattern) and §2.7 (dependency graph) from the stale "sequential IIFE content scripts sharing `window.YouSub`" model to the real one: the manifest injects a single `src/content/loader.js`, which dynamic-`import()`s `main.js`; modules are ESM with `window.YouSub` as a compatibility shim; documented `web_accessible_resources`.
- Added the previously-undocumented real modules to the folder map: `loader.js`, `shared/trusted-types.js`, `shared/utils.js`, `shared/libs/browser-polyfill.js`, `background/merge-fixer.js`, `background/rough-translator.js`, and the `src/debug/` diagnostics panel. Corrected the icon list.

**Added**
- `README.md` — light, private-repo readme: tech stack, dev quickstart (`npm test`/`lint`/`format`/`package`, load-unpacked), BYOK privacy note, documentation map, AGPL-3.0.
- `YOUSUB_DESIGN_DECISIONS.md` **Decision 13** — records that the phantom modules were specced but never built (re-adding any would be a *new* feature, not a fix).

**Verify**: `grep` confirms zero remaining `toast.js`/`tab-about`/`logo.svg` references in the SPEC. (LICENSE was already added in Phase 67.)

### Phase 70 — CI Pipeline (ready-to-use GitHub Actions) (2026-06-24)

Adds a CI workflow that mirrors the local quality gates so they also run on GitHub.

**Added**
- `.github/workflows/test.yml` — on push/PR to `main`|`master`: `npm ci` → `npm run lint` → `npm run format:check` → `npm test` (with the Phase 69 coverage-threshold gate) → `npm run package` (Chrome + Firefox build smoke test). Node 22 (matches `.nvmrc`), `HUSKY=0` to skip hook install in CI.

**Notes**
- Decision (developer): the repo is local-only (no GitHub remote, private by design). The workflow is written **dormant** — it activates automatically once the repo is pushed to GitHub. The default branch was **not** renamed (`master` kept); revisit `master → main` if/when a remote is added.
- Every gate command was verified locally before commit: lint 0, format:check 0, `npm test` exit 0 (420/420 + threshold), `npm run package` exit 0 (both ZIPs, VERIFY OK). The YAML is Prettier-clean so it won't fail its own `format:check` step.

### Phase 69 — [EPIC] Coverage Expansion: Honest 23% → 40% (+202 tests) (2026-06-24)

Raises real test coverage with high-value, behavior-meaningful tests. Strategy is **Decision 12** (developer-approved): an honest denominator (`src/**` minus the vendored polyfill) measured a **23%** baseline; "≥70% global" is reframed as a **Milestone-7 exit** target reached across Phases 69/75/76, not a single-phase deliverable. Phase 69 does the honest winnable work now and ratchets the gate at the achieved level.

**Added — 8 new test files, +202 tests (218 → 420 total, all green)**
- `providers.test.js` (50) — `providers.js` **0.35% → 97%** lines. Mocks `global.fetch`; exercises `chat`/`chatStream` for openai/gemini/anthropic styles (+ auto-detect/abort/timeout/signal), `handleResponse` status mapping (401/403/404/429/500, retry-after), SSE `handleStreamResponse`, `fetchQuota`, `testApiKey`.
- `overlay.test.js` (30) — `overlay.js` **6% → 61%**. jsdom DOM assertions for lazy container creation, `renderSubtitles` (single/dual/translated/loading), show/hide, `showStatus`, `applyStyles`/`refreshStyles`, Phase 62 custom-layout load + reset, `destroy`.
- `translator-helpers.test.js` (59) — `translator.js` **11% → 24%** via the (expanded) `_internals` pure helpers: `formatTimestamp`, `normalizeTs`, prompt builders, `getProviderJsonConfig`, `parseJsonResponse` (object/array/markdown/mismatch/garbage), `cleanResponse`, `partitionKeysByProvider`, `splitForGroqPayload`, `groupByPhysicalKey`, `sortGroupsByHealth`, `selectGroupForBatch`.
- `page-detector.test.js` (14) → **100%**; `subtitle-extractor.test.js` (14) → **90%**; `video-binder.test.js` (14) → **88%**; `trusted-types.test.js` (6) → **100%**; `utils.test.js` (15) → **100%**.

**Changed (non-test, behavior-preserving)**
- `jest.config.cjs`: added `collectCoverageFrom: ['src/**/*.js', '!src/shared/libs/**']` (honest denominator) and a `coverageThreshold` global gate set a hair below the achieved numbers (statements/lines 38, branches 34, functions 36) — ratchets, never lowered.
- `src/background/translator.js`: expanded `export const _internals` with 14 already-existing pure helpers so they can be unit-tested. **No logic change** (lint clean, the 55 existing translator tests still pass).
- `tests/mocks/chrome.js`: added `chrome.storage.onChanged` at the storage level (matches the real WebExtensions API that `overlay.js` subscribes to; previously only nested under `storage.local` — a latent footgun surfaced by the overlay tests).

**Notes / follow-ups**
- Global lines **23.27% → 39.91%**; `npm test` now enforces the threshold (exit 0).
- Deferred to their refactor phases: deep `translator.js` orchestration coverage → **Phase 75** (test the extracted modules, not the soon-to-be-rewritten `_translateInternal`/`tryKeyForBatch`); UI glue (`tab-translation` 818 L, `popup`, `options`) + entries → **Phase 76**.
- DEFERRED **D3**: `Providers.chat()` default `timeoutMs` is 15s but its timeout message says "(30s)" — cosmetic; plus two effectively-dead defensive branches. No `src/` fix in this test-only phase.

**Tests**: 218 → **420** (+202); 0 failing; coverage 23% → **40%** global.

### Phase 68 — Test Recovery: All 15 Failing Tests Green (2026-06-24)

Recovers the 3 remaining red suites with **test-only changes** — no production code touched. Suite goes from **202 passing / 15 failing (217)** to **218 passing / 0 failing (218)** (+1 new rotation test). `npm run lint` and `prettier --check` clean on all three rewritten files.

**Fixed — `subtitle-parser.test.js` (6 tests)**
- Replaced the `eval(scriptContent)` loader (threw `Cannot use import statement outside a module` on the ESM file) with a direct `import { SubtitleParser }`. The module is pure (only `DOMParser`, which jsdom provides), so no mocking is needed.
- Updated the "decode HTML entities" assertion to the **actual shipped behavior**: `decodeHtml()` parses the decoded markup as HTML and returns `textContent`, so inline `<b>` formatting tags are **stripped** while entities are decoded (`<b>Encoded &amp; Text</b>` → `Encoded & Text`, not the test's never-validated `<b>…</b>`). See note below.

**Fixed — `sync-engine.test.js` (5 tests)**
- Replaced `eval()` with a direct ESM `import` + `jest.unstable_mockModule('overlay.js', …)` (same pattern as `logger.test.js`). Necessary because `SyncEngine` calls the *imported* `Overlay` binding directly — assigning `window.YouSub.Overlay` no longer intercepts it.
- Updated two stale assertions to the current code: `Overlay.renderSubtitles(...)` now takes a **4th `isTranslated` arg**; and the "hide on gap" test now first enters a subtitle (so `currentIndex` becomes valid) before moving into the gap — a fresh engine sitting in a gap correctly renders nothing.
- Added a `flushMicrotasks()` helper + non-zero `offsetWidth/Height` on the mock video (so the Shorts hidden-video guard doesn't early-return).

**Fixed — `api-manager.test.js` (4 tests)**
- `getValidKeys()` defaults model-rotation **on**, fanning each base key out across its provider's models (e.g. 3 keys → 12 entries). The four failover/circuit/sort tests now set `yousub_model_rotation: false` to isolate the logic they actually assert.
- **Added** one test verifying the rotation-**on** path still expands keys (`isRotationClone` clones present, base keys intact) so that branch keeps coverage.

**Notes / follow-ups**
- The `decodeHtml` tag-stripping is the long-shipped (v0.2.2) behavior; the old test expectation was never validated (eval always threw before reaching it). Recorded as actual behavior here — flag for the developer if literal `<b>`/`<i>` markers in subtitles should instead be preserved (would be a separate feature change, not a Phase 68 fix).
- DEFERRED **D1** (B1 `esc()` escaping test): the eval→import blocker is now cleared, but `esc()` remains an un-exported closure inside the side-effectful `main.js` entry (top-level `TrustedTypes.init()` + `onMessage` listener). Importing that entry into a unit test would wire global listeners and risks destabilizing the now-green suite, so D1 is re-pointed to **Phase 75** (extract `esc()` to `shared/utils.js` alongside the translator refactor, then unit-test it). Not blocking.

**Tests**: 217 → **218** total; 15 failing → **0 failing**; 3 suites recovered (`subtitle-parser`, `sync-engine`, `api-manager`).

### Phase 67d — Pre-Commit Hook (husky + lint-staged) (2026-06-24)

Adds a pre-commit hook so future commits stay lint-clean and formatted. **Completes Phase 67.**

**Added**
- `husky` v9 + `lint-staged` (dev deps); `prepare: "husky"` script; `.husky/pre-commit` runs `npx lint-staged`.
- `lint-staged` config: staged `*.{js,cjs,mjs}` → `eslint --fix` + `prettier --write`; staged `*.{json,css,html}` → `prettier --write`. Markdown is intentionally excluded (consistent with 67c).

**Notes**
- The hook runs **lint-staged only**, not `npm test` (husky's default) — the suite has 15 known pre-existing failures (Phase 68), so a test hook would block every commit. Full-suite gating belongs in CI (Phase 70).
- `core.hooksPath` = `.husky/_` (auto-gitignored). On a fresh clone, `npm install` re-runs `prepare` to reinstate the hook.

### Phase 67c — Repo-Wide Prettier Format (2026-06-24)

One-time mechanical `prettier --write` across all code (js/json/css/html); the hand-crafted `*.md` governance docs + `LICENSE` are excluded (`.prettierignore`) to protect their tables/wording. **52 files reformatted** (commit `50462db`). **No logic change** — gated by `eslint .`=0, `prettier --check`=clean, tests 202/15 unchanged. Added `.git-blame-ignore-revs` (configure via `git config blame.ignoreRevsFile .git-blame-ignore-revs`) so the reformat doesn't pollute `git blame`.

### Phase 67b — Dev-Tooling: Lint Cleanup to Zero Problems (2026-06-24)

Resolves all 66 ESLint problems from the 67a baseline (11 errors + 55 `no-unused-vars` warnings) across 16 files. Executed as 15 parallel per-file agents under strict surgical rules, then gated by `eslint .` (0 problems) + the full test suite (no regression) + manual diff review of every under-tested content/options script. **Behavior-preserving** — net −176 lines, almost all dead code.

**Fixed (errors → 0)**
- `no-useless-catch`: unwrapped the rethrow-only `try/catch` around `handleRequest` (`service-worker.js`).
- `no-useless-escape`: `/[\[\]]/g` → `/[[\]]/g` (`translator.js`, identical inside a char class).
- `no-redeclare`: `moreBtn` → `expandMoreBtn` in the regular-video branch (`main-world-extractor.js`); the Shorts branch's `moreBtn` is a mutually-exclusive path.
- Intentional sanitizer regexes (control / combining / irregular-whitespace chars deliberately matched to strip them) → documented `// eslint-disable-next-line`, regex byte-for-byte unchanged: `translator.js` foreign-script detect/strip (L98-99), `utils.js` `sanitizeKey` (L3, byte-verified identical), `tab-translation.js` `sanitizeKey` (L69).

**Removed (dead code, `no-unused-vars` → 0)**
- `translator.js`: dead `RATE_LIMIT_MAX_RETRIES`/`RATE_LIMIT_BASE_DELAY_MS`, dead `getFirstAvailableKey()`, dead `allFailuresMap` (all audit-confirmed dead).
- `main.js`: the entire non-streaming `requestTranslation()` fallback (~100 lines) — the pipeline only uses the streaming path.
- `main-world-extractor.js`: dead `setSafeHTML()` / `closeTranscriptPanel()`. Both `main-world-*.js`: dropped unused `policy` binding but **kept the `createPolicy()` side-effect** (it registers a Trusted Types policy).
- `tab-appearance.js`: unused `Logger` import + never-called `loadAppearance()` (see DEFERRED D2). `popup.js`: dead `showError()` + unused `loadingDiv`/`loadingText`. `tab-translation.js`: unused `Logger` import + `healthDot`.
- Many unused caught-error bindings `catch (e)` → `catch` (ES2019 optional binding); unused args → `_`-prefixed. Config: `no-empty` allows empty catch; `YouSub` added as a src global; `resize_icons.js` ignored.

**Tests**: 202 passing / 15 pre-existing failures (217) — unchanged. `npm run lint` now exits clean (0 errors, 0 warnings).

### Phase 67a — Dev-Tooling Foundation: Config + Metadata + LICENSE (2026-06-24)

First slice of Phase 67, split (Rule 5) into **67a** config → **67b** lint-triage → **67c** repo-wide Prettier format → **67d** pre-commit hook. Adds lint/format/editor tooling and project metadata with **no code or formatting changes**.

**Added**
- ESLint 9 flat config (`eslint.config.js`) — `@eslint/js` recommended + per-area globals (src → browser/serviceworker/webextensions, scripts → node, tests → node/jest/browser); ignores `node_modules`, `coverage`, `dist`, the bundled polyfill, and `tmp/` junk. `no-unused-vars` set to `warn` for the Milestone 7 triage.
- Prettier config (`.prettierrc`: `singleQuote`, `printWidth:100`, `arrowParens:always`, `endOfLine:auto`) + `.prettierignore`; `.editorconfig`; `.nvmrc` (Node 22).
- `LICENSE` — full official GNU AGPL-3.0 text (34,523 bytes, fetched from gnu.org). Developer chose AGPLv3.
- Dev deps: `eslint`, `@eslint/js`, `globals`, `prettier`. New scripts: `lint`, `lint:fix`, `format`, `format:check`.

**Changed**
- `package.json` metadata: filled `description`, `author` (Masaru), `keywords`, `engines` (`node >=20`); `license` ISC → `AGPL-3.0-only` + `private: true`; **removed** the dangling `main: index.js` (no such file; meaningless for a browser extension).

**Baseline captured (no fixes applied — drives 67b/67c)**
- ESLint: **89 problems (34 errors, 55 warnings)**. Top: `no-unused-vars` (55, warn), `no-undef` (mostly missing-global config — bare `console`/`YouSub` in a file the globs didn't cover → fixable via config in 67b), `no-empty` (14, mostly intentional empty catches), plus a few genuine ones (`no-redeclare`, `no-useless-escape`, `no-irregular-whitespace`).
- Prettier: **63 files** would reformat → isolated commit in 67c (markdown scoping decided at 67c).

**Tests**: unchanged — 202 passing / 15 pre-existing failures (217 total). Tooling does not touch runtime or test logic.

### Phase 66 — Fix Correctness Blockers + Hardening (2026-06-23)

Fixes the verified correctness/hygiene findings from the Milestone 7 audit. A read-only re-verification (which ran the real suite) reframed two of the four: **B4 was a test bug, not a code bug**, and the failing **B3** cache test was caused by the 7-vs-30-day mismatch, not just a stale comment. Behavioral forks (cache TTL, circuit threshold) were resolved by the developer in favor of **keeping the shipped behavior** — see `YOUSUB_DESIGN_DECISIONS.md` Decision 11.

**Fixed**
- **B2 (real blocker)** `sync-engine.js` — the `timeupdate` listener was registered inside the async `chrome.storage.local.get(...).then()` callback. A `stop()` that won the race (e.g. rapid Shorts swipe) left `videoElement` null, so the late callback threw `TypeError` on `addEventListener(null)`. Converted the callback to an arrow function (correct lexical `this`) and added an `if (!videoElement) return` guard.
- **B4 (test bug)** `health.test.js` — `isCircuitOpen()` and the breaker logic are correct (opens at `consecutiveFails >= 10`, `Date.now() < circuitBreakerUntil`). The test wrongly expected the circuit open after **3** failures; corrected it to loop to 10 and renamed it. `health.js` unchanged.
- **B3 (doc + test)** `cache.js` / `cache.test.js` — kept the shipped **30-day** TTL behavior, corrected the stale "7-day" comment, and updated the test fixture (8-day → 31-day) to exercise the real expiry boundary.
- **B1 (hardening)** `main.js` — wrapped `esc()` around `failureReason`, `retryMatch[1]`, and the `limitMatch` captures before they reach the Overlay `innerHTML` (TrustedTypes passthrough). Defense-in-depth; the sinks are internal constants / tightly-constrained regex captures, not attacker-controlled.

**Added**
- `tests/unit/sync-engine-race.test.js` (2 tests) — deterministic start()/stop() race regression for B2 (late-callback-bails-out + happy-path-still-arms), using the working ESM-import pattern (not the `eval()` loader).

**Deferred**
- A dedicated `esc()` escaping test for B1 → Phase 68: `esc()` is an un-exported closure in a content script the Jest harness cannot yet load (the same ESM/`eval()` blocker that reds `sync-engine.test.js`). Tracked in `DEFERRED.md`.

**Tests**: 198 → **202 passing** / 17 → **15 failing** (215 → **217 total**, 14 suites). Recovered the cache-TTL and circuit-breaker tests and added 2 race tests. The remaining 15 failures (suites `subtitle-parser`, `sync-engine` `eval`-loader, `api-manager` mock key-count) are unchanged and scheduled for Phase 68.

### Phase 65 — Commit Phase 64 + Version-Truth Sync (2026-06-23)

Opens **Milestone 7 — Professionalization & Hardening**. Commits the previously-uncommitted Phase 64 work and reconciles the version label, which had drifted across six surfaces (real version is 0.2.2; docs/UI variously claimed 0.2.0 / 0.4.0).

**Added**
- Milestone 7 roadmap (Phases 65-77) in `ROADMAP.md` (v8.0): release-prep → tooling → test recovery → docs → hygiene → refactor → polish, with a post-v0.2.2 maintenance-mode governance note.

**Changed**
- Committed the 0.2.1 → 0.2.2 version bump (`manifest.json`, `package.json`, `src/shared/constants.js`) — previously uncommitted.
- `src/options/options.html` — version badge and About-tab version `0.2.0` → `0.2.2`.
- `MEMORY.md` — logged Phases 62/63/64 + Phase 65, status → v0.2.2, date → 2026-06-23.
- `YOUSUB_PROJECT_SPEC.md` — header status `v0.4.0` → `v0.2.2` (stale label corrected; structural §2.5/2.7 fixes deferred to Phase 71).
- Phase 64 entry below — "pending manual browser verify" resolved (developer-confirmed verified 2026-06-23).

**Tests**: unchanged — 198 passing / 17 pre-existing failures (215 total, 13 suites). The 17 failures are scheduled for Phases 66 (cache TTL, circuit breaker) and 68 (ESM/eval content tests, api-manager mocks).

### Phase 64 — Streaming Timeout Robustness + Completeness Sweep (2026-06-08)

Fixes the `Translation failed: TIMEOUT_BACKGROUND` bug (Chrome + Firefox) where mid-translation every rendered batch vanished. Root cause: a fixed 60s content-side deadline that was never reset by streaming progress, firing while the background was still healthy, after which the failure path destroyed the overlay. See `YOUSUB_DESIGN_DECISIONS.md` Decision 10.

**Added**
- `SyncEngine.getTranslatedCount()` (`sync-engine.js`) — number of lines currently translated; drives the preserve-partials decision.
- `computeForceTimeoutMs(segmentCount)` (`translator.js`) — background job backstop scaled by transcript length (floor 180s, +2.5s/line, ceiling 600s), replacing the fixed 100s cap.
- `soonestCooldownWaitMs(activeKeys, cooldownMap, now, maxWaitMs)` (`translator.js`) — cooldown-aware pacing for the completeness sweep (pure, unit-tested).
- Completeness sweep in `_translateInternal` — after the main pass, failed batches are retried up to `MAX_SWEEP_ROUNDS=3`, cooldown-aware; recovered batches stream via `onBatchComplete`. Still-missing → `success:false` / `failureReason:'INCOMPLETE_AFTER_SWEEP'`.
- Per-batch timeout (`BATCH_TIMEOUT_MS=90000`) via a `batchAbort` AbortController chained to `globalAbort`, in both the main loop and the sweep.
- `tests/unit/sync-engine-partial.test.js` (4 tests), `tests/unit/translator-timeout.test.js` (9 tests).

**Changed**
- `requestTranslationStreaming` (`main.js`) — the fixed 60s guardian is replaced by a **150s idle watchdog** re-armed on `CHUNK` and on a per-batch `PROGRESS` heartbeat (intentionally **not** on `PONG`, which would reduce it to an "is the SW alive" check). On fire it calls `port.disconnect()` (stops the orphaned background burn) then resolves `TIMEOUT_BACKGROUND`. Centralized cleanup via `finish()`; added `PROGRESS` and no-op `PONG` branches.
- `service-worker.js` — the stream port now forwards a `PROGRESS` message from the translator's per-batch `onProgress` callback so the content watchdog can distinguish a stalled background from a slow-but-advancing one (e.g. consecutive failing/rate-limited batches that emit no `CHUNK`).
- `translate()` / `_translateInternal` (`translator.js`) — added an `onProgress` heartbeat fired at every batch boundary (success or failure) in both the main loop and the sweep.
- `retranslateWithVerification` (`translator.js`) — now threads the abort `signal` into its `Providers.chat` call and checks `signal.aborted` per round/chunk, so a batch stuck in untranslated-verification actually honors the per-batch cap / port disconnect (previously it could run unbounded, defeating the 90s cap).
- `processEntries` failure branch (`main.js`) — preserves already-rendered partials (`getTranslatedCount() > 0` → keep subtitles, show soft "Translation incomplete: X/Y" warning); only tears down (`SyncEngine.stop()` + `Overlay.destroy()`) when nothing was translated.
- `_translateInternal` (`translator.js`) — main loop breaks promptly on `globalAbort`; force-cap uses `computeForceTimeoutMs`; stale "55s" comment corrected.
- `translateBatchWithFailover` (`translator.js`) — `'cooldown'` failover status is now tagged `status:429` ("Key on cooldown (rate limited)") in both the group and flat loops, surfacing rate limiting in the UI instead of a cryptic `cooldown` row.
- Rate-limit hint added to the content error toast when failures include a 429.
- **Success semantics (deliberate)**: a run is successful only if `anyBatchSucceeded && !incompleteAfterSweep` (was `anyBatchSucceeded`). Incomplete runs report failure but keep partials on screen.

**Tests**: 185 → 198 passing (+13 new). 17 pre-existing failures unchanged. The rewritten async/port protocol paths in `main.js` and the sweep loop in `translator.js` are **not** unit-tested (browser-glue / integration paths); they were covered by an adversarial multi-agent diff review and confirmed via manual browser verification (2026-06-23). Unit tests cover the extracted pure helpers (`computeForceTimeoutMs`, `soonestCooldownWaitMs`) and `getTranslatedCount`.

**Note**: `manifest.json` / `package.json` / `src/shared/constants.js` already carried an uncommitted `0.2.1 → 0.2.2` version bump (not part of this change); left untouched.

### Smart Batch Distribution — Round-Robin + Model Rotation (2026-05-14)

**Added**
- `getCooldownKey(apiKey, model)` — model-aware cooldown key (`apiKey::model`), isolates per-model rate limits so a 429 on one model no longer blocks other models of the same provider
- `groupByPhysicalKey(activeKeys)` — groups expanded virtual key slots by physical API key for round-robin scheduling
- `sortGroupsByHealth(groups)` — sorts key groups by health score (best-first) once per translation call
- `selectGroupForBatch(keyGroups, batchIndex)` — round-robin batch selector that skips fully-cooled-down groups
- Two-tier failover in `translateBatchWithFailover()`: outer loop rotates across key groups (round-robin), inner loop rotates across models within a group (model rotation on 429)

**Changed**
- `_translateInternal()` — batch loop now builds key groups and uses round-robin group selection instead of always starting from key index 0
- `translateBatchWithFailover()` — standard failover section replaced with group-based iteration; legacy flat iteration preserved for recursive 413-split calls
- Cooldown Map key changed from `apiKey` to `apiKey::model` at 3 call sites (`getFirstAvailableKey`, `tryKeyForBatch` check, `tryKeyForBatch` 429 handler)
- 413 errors now skip the entire key group (same provider = same payload limit for all models)

**Tests**: 185 tests passing (17 pre-existing failures unchanged), build verified for Chrome and Firefox

### Subtitle Overlay Resize, Move & Reset (2026-05-12)

**Added**
- Interactive resize from 4 corners — drag to change overlay width/height, minimum 200x40px enforced
- Move handle at top-center edge — drag to reposition overlay anywhere within video player
- Reset handle at bottom-center edge — click to restore default centered position
- 6 handle DOM elements (`.yousub-handle`) with visual indicators: dots at corners, bars at center edges, appear on hover
- `yousub_overlay_layout` storage key — persists custom position/size as percentages of player dimensions, separate for regular videos and Shorts
- `ResizeObserver` on player element — re-clamps overlay position on fullscreen, theater mode, or window resize
- Boundary clamping: overlay can never leave the video player area
- `isDragging` guard in `Overlay.hide()` — prevents SyncEngine from hiding overlay during user interaction
- `.yousub-custom-position` CSS mode — switches from default centering to absolute positioning with user-defined coordinates
- `.yousub-dragging` CSS class — disables `backdrop-filter` and `box-shadow` during drag for smooth performance

**Changed**
- `overlay.js` — added 250 lines of resize/move/reset logic with Pointer Events API and `setPointerCapture` for reliable drag tracking
- `overlay.css` — added 85 lines for custom position mode, handle styles, and drag performance class
- `Overlay.destroy()` — now cleans up `ResizeObserver`, handle elements, and layout state

**Tests**: Build verified (`npm run package`), 185 tests passing (17 pre-existing failures unchanged), manual browser testing confirmed all interactions working

### Foreign Script Contamination Detection — Issue 1 (2026-05-07)

**Added**
- `detectForeignScriptLines(lines, tgt)` in `translator.js` — detects lines containing non-expected script characters (CJK, Cyrillic, Arabic, Hebrew, Devanagari, Bengali, Thai, Hangul, CJK Compatibility)
- Foreign script re-translation pipeline — contaminated lines are re-translated via existing `retranslateShiftedLines()` before fallback stripping
- `FOREIGN_SCRIPT_DETECT` / `FOREIGN_SCRIPT_STRIP` regex constants — expanded Unicode coverage beyond original inline regex
- `_internals` export in `translator.js` for testing
- `tests/unit/translator-sanitize.test.js` — 30 tests covering detection + sanitization

**Changed**
- `sanitizeForeignScript()` now accepts `segments` parameter — strip-to-empty lines fall back to original source text instead of returning empty string
- `sanitizeForeignScript()` regex expanded to cover Arabic, Hebrew, Devanagari, Bengali, Thai, CJK Compatibility (previously only Cyrillic + CJK + Hangul)

**Tests**: 30 new (translator-sanitize), 141 total across translator-sanitize + merge-fixer + logger suites

### Shorts Extraction Resilience — Phase 51.1 (2026-05-07)

**Added**
- `fetchTracksViaInnertube(videoId)` in `main-world-extractor.js` — YouTube Innertube API fallback for caption track extraction when all 3 metadata sources fail
- Innertube conditional block in `run()` — bridges metadata extraction gap for Shorts and swiped videos

**Fixed**
- "Could not find subtitles" on certain YouTube Shorts — caused by missing transcript button and stale metadata sources failing to provide caption tracks
- Swiped Shorts caption extraction — `ytInitialPlayerResponse` is stale after swiping; Innertube API provides fresh tracks with valid `baseUrl`

### Production Bundling & Log Management — Phase 49 (2026-05-07)

**Added**
- `Logger._bufferEntry()` — in-memory ring buffer (10,000 entries) with debounced flush to `chrome.storage.session` every 5s
- ERROR-level dual-path persistence — errors written to both `storage.session` and `storage.local` (max 200 entries, survives browser close)
- `Logger._readAllLogs()` — fallback chain: session storage → error storage → in-memory buffer
- `devLog()`, `devWarn()` exported from `constants.js` — production-gated console helpers
- `window.YouSub.devLog`, `window.YouSub.devWarn` — global access for MAIN world scripts
- `BUILD_DATE`, `BUILD_HASH` fields in `Constants` — injected during build from git metadata
- `chrome.storage.session` mock in `tests/mocks/chrome.js`
- `tests/unit/logger.test.js` — 15 new tests (buffering, flush, rotation, export, format)
- Pre-build validation in `package.js` — version sync, file existence, IS_PRODUCTION check
- Post-build ZIP verification — manifest validity, platform transforms, IS_PRODUCTION=true
- Stale dist/ artifact cleanup — removes old ZIPs before build
- Asset exclusion patterns — `*.zip`, `*-original.*`, `*.docx` skipped during packaging

**Changed**
- `logger.js` rewritten — replaced disabled `_persist()` with batch+debounce `storage.session` architecture
- `options.js` `exportLogs()` — now delegates to `Logger.export()`, shows entry count
- `package.js` fully rewritten — v2.0 with validation, cleanup, metadata, verification pipeline
- 140 raw `console.log/warn` calls replaced with `devLog`/`devWarn` across 15 source files
- 6 raw console calls in `providers.js` routed through `Logger.trace`/`Logger.warn`
- 1 raw `console.error` in `translator.js` routed through `Logger.error`

**Fixed**
- Export Debug Logs always showed "No logs found" — storage was never written since Phase 52
- Duplicate event listener on export button in `options.js` (bound twice at lines 66-72)
- Production builds leaked 140+ debug messages in DevTools despite `IS_PRODUCTION: true`
- Build ZIP contained junk files (`icon128-original.png`, `icons.zip`, `.docx`) — ZIP size reduced ~25%
- Stale dist/ artifacts accumulated across builds (old version ZIPs never cleaned)

**Tests**: 156 total (139 passed, 17 pre-existing failures), +15 new logger tests, 0 regressions

### Patched Tail Detection — Phase 61a (2026-05-07)

**Fixed**
- `detectTailAnomalies()` broke immediately on first non-anomalous line scanning backward — hallucinated tail content sandwiched between normal lines was never detected, preventing shift detection path from activating
- Overlap check only compared with next line (`outputLines[i+1]`) — lines with high overlap to previous line (`outputLines[i-1]`) were missed

**Changed**
- Added `TAIL_MAX_GAPS = 2` constant — gap counter allows up to 2 consecutive normal lines before breaking backward scan; gap lines are included in tail count when a subsequent anomaly is found
- Overlap detection now checks both neighbors (i-1 and i+1) bidirectionally

**Tests**: 65 → 69 (+4 new: gap bridging, bidirectional overlap, gap limit, multi-gap bridging)

### Offline Cascade Shift Detection — Phase 61b (2026-05-07)

**Added**
- `extractPreservedTokens(text)` — extracts numbers and all-caps acronyms (2+ chars); returns empty for CJK input
- `computeTokenAnchorScore()` — measures token misplacement between output line and its neighbors (score 0-1)
- `computeBoundaryAlignmentScore()` — compares terminal punctuation (.?!) between input/output (0=match, 1=mismatch)
- `computeLengthOutlierScore()` — per-line length ratio deviation from batch median (clamped 0-1)
- `computeMedianRatio()` — computes median word-count ratio across batch
- `detectCascadeShifts()` — main orchestrator combining 3 weighted signals with two-signal minimum guardrail
- `_computeLineCascadeScore()` — shared per-line scoring used by both `detectCascadeShifts` and `detectMerges`
- Constants: `CASCADE_SCORE_THRESHOLD=0.6`, `CASCADE_TOKEN_WEIGHT=0.4`, `CASCADE_BOUNDARY_WEIGHT=0.3`, `CASCADE_LENGTH_WEIGHT=0.3`, `CASCADE_MIN_BATCH_SIZE=5`, `MERGE_RATIO_MEDIUM=1.5`

**Changed**
- `detectMerges()` now has secondary threshold: when ratio is 1.5-2.0, runs cascade signals to confirm small merges that the 2.0 threshold would miss
- `MergeFixer.fix()` runs `detectCascadeShifts()` after tail anomaly check, before merge detection loop; returns `pendingIndices` for re-translation
- `_internals` export expanded with 6 new functions

**Tests**: 69 → 96 (+27 new: extractPreservedTokens, computeTokenAnchorScore, computeBoundaryAlignmentScore, computeLengthOutlierScore, computeMedianRatio, detectCascadeShifts unit + integration)

### 3-Tier RoughTranslator — Phase 61c (2026-05-07)

**Added**
- Tier 1: Chrome Translator API support — feature-detects `self.translation.canTranslate` / `self.ai.translator.capabilities`, creates on-device translator with 3s timeout, caches availability per language pair and translator instances per pair
- Tier 2: Google Translate scraping — extracted existing logic to `_translateWithGoogle()`, unchanged behavior
- Tier 3: returns null when both tiers fail (offline signals / proportional split in merge-fixer)
- `_internals` export for test access to internal state/functions
- New test file `tests/unit/rough-translator.test.js` with 14 tests

**Changed**
- `rough-translator.js` rewritten from 26 to 97 lines with 3-tier fallback chain
- Public API (`translate`, `translateBatch`) signature unchanged — zero caller modifications needed

**Tests**: 14 new tests (Chrome available, Chrome fallback, Google fallback, both fail, batch, caching)

### Enhanced Quota/Rate-Limit Display on API Key Test — Phase 60.1 (2026-04-25)

**Fixed**
- [BUG] `row.querySelector('.quota-detail')` in `tab-translation.js:481` referenced undefined `row` variable (should be `rowDev`), causing quota display to silently crash on every test. Quota info was never visible despite being fetched.
- [BUG] Anthropic rate-limit headers (`anthropic-ratelimit-*`) were never captured — code only checked `x-ratelimit-*` prefix. Anthropic quota info now extracted via provider-specific header mapping.
- [BUG] DeepSeek balance of 0 (user out of credits) was displayed as nothing due to `parseFloat("0") || null` evaluating to `null`. Fixed with explicit `isNaN()` check.

**Added**
- `fetchQuota()` method in `providers.js` — dedicated quota API calls for OpenRouter (`/api/v1/auth/key`) and DeepSeek (`/user/balance`) with 5s timeout, non-blocking (never breaks test flow)
- `quotaEndpoint` field in `providers-registry.js` for OpenRouter and DeepSeek
- `buildQuotaDisplay()` helper in `tab-translation.js` — provider-aware quota formatting with color-coded warnings (`--warning` at <10%, `--error` at <3%)
- Anthropic input/output token breakdown display (separate from aggregate tok/min)
- OpenRouter free tier display (`Used: $X.XX (free tier)`)
- DeepSeek balance display with zero-balance danger styling
- `.quota-detail`, `.quota-warn`, `.quota-danger` CSS classes in `options.css`

**Changed**
- Quota display separator changed from ` | ` to ` · ` for consistency
- Inline styles on `.quota-detail` replaced with CSS class
- `existingQuota.textContent` replaced with `existingQuota.innerHTML` for span-based color coding

### Translation Pipeline Error Visibility & Quota Diagnostics — Phase 60 (2026-04-25)

**Fixed**
- [CRITICAL] `_translateInternal()` always returned `success: true` even when ALL translation batches failed, causing UI to show "Translation complete!" with original (untranslated) text. Now tracks `anyBatchSucceeded` flag and returns `success: false` with `failureReason: 'ALL_BATCHES_FAILED'` when no batch succeeded.
- [CRITICAL] `onBatchComplete` callback fired with original text when batches failed, sending CHUNK messages with untranslated text to SyncEngine. Now gated on `result.success`.
- [HIGH] `SyncEngine.updatePartial()` and `updateSubtitles()` unconditionally marked all entries as "translated" via `translatedIndices.add()`. Now compares `text !== original` before marking.
- [HIGH] Context summary `generateContextSummary()` set `keyCooldowns` on 429 from Groq, poisoning the batch translation phase — all Groq models using the same API key were blocked even though different models might work. Removed cooldown side-effect.
- [MEDIUM] Error messages from provider API responses (quota details, retry timing) were lost in `tryKeyForBatch()` — returned `{ status: '429' }` without `message`. Now propagates `result.message` through entire chain.

**Added**
- Detailed failure overlay: when translation fails, UI shows per-provider breakdown with provider name, model, HTTP status, quota used/limit, and retry timing. Deduped, limited to 5 entries.
- `failures` array propagation through all translation paths: sequential failover, Groq waterfall (`processGroqWaterfall`), non-Groq fallback (`fallbackToNonGroq`), and recursive 413 split. Each entry includes `{ provider, model, status, message }`.
- Rate limit header extraction in `providers.js handleResponse()`: captures `x-ratelimit-remaining-tokens`, `x-ratelimit-remaining-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-limit-requests` from OpenAI-compatible provider responses on success.
- Quota detail parsing from 429 error bodies: regex extraction of `Limit/Used/Requested` numbers and `retryIn` timing from Groq-style error messages. Stored as `quotaDetail` field.
- Test button quota display in settings: after successful test, shows remaining tokens/requests per minute with percentage. Warning color (#f59e0b) when remaining < 10% of limit.
- Failed batch diagnostic logging: `sendDebugLog` (red) + `saveDebugBatch` for failed batches — previously only successful batches were logged, leaving no trace when translation failed.

**Changed**
- `translateBatchWithFailover()` sequential path: failures array now includes `message` field for 429 and 413 entries.
- `processGroqWaterfall()`: new `failures` array tracks per-key failures in switch cases; returned alongside existing fields.
- `fallbackToNonGroq()`: new `failures` array tracks non-cooldown failures; included in return.
- Groq waterfall return in `translateBatchWithFailover`: merges `groqFailures` + `fallbackFailures`.
- Recursive 413 split return: merges `res1.failures` + `res2.failures`.
- `main.js` ERROR handler: extracts `failures` from response and builds detailed HTML error message.

### Shift-Aware MergeFixer + LLM Re-translation — Phase 59.2 (2026-04-24)

**Added**
- Shift pattern detection in `merge-fixer.js`: `detectTailAnomalies()` scans backward for garbage tail lines (short, repeated 4-grams, inter-line word overlap, exact duplicates). `findShiftCandidates()` uses lower threshold (`SHIFT_RATIO_MIN >= 1.8`) gated by tail anomaly detection to catch borderline merges missed by classic `> 2.0` check.
- `buildRealignment()` — realigns shifted output lines by inserting empty slots at merge positions and truncating garbage tail. Returns `{ lines, pendingIndices }` for downstream re-translation.
- `retranslateShiftedLines()` in `translator.js` — sends pending segments as mini-batch to same LLM provider with `_skipMergeFix: true` to prevent recursion. Falls back to original source text on failure.
- Helper functions: `detectInternalRepetition()` (4-gram repetition), `computeWordOverlap()` (word-set Jaccard).
- Constants: `SHIFT_RATIO_MIN=1.8`, `SHIFT_MAX_SCAN=4`, `TAIL_NGRAM_SIZE=4`, `TAIL_OVERLAP_THRESHOLD=0.5`, `MAX_SHIFT_CANDIDATES=6`, `RE_TRANSLATION_MAX_LINES=12`.
- 19 new unit tests: detectTailAnomalies(4), detectInternalRepetition(2), computeWordOverlap(2), findShiftCandidates(3), buildRealignment(4), fix() shift-aware integration(4).

**Changed**
- `MergeFixer.fix()` return type: `string[]` → `{ lines: string[], pendingIndices: number[] }`. Shift path runs first (tail detection gates), classic path unchanged.
- Both `MergeFixer.fix()` call sites in `translator.js` (JSON mode line 555, text parser line 637) updated to handle new return type and trigger re-translation when `pendingIndices.length > 0`.

**Tests**: 65 total (46 previous + 19 new), all passing.

### Google Translate Verification + Best-Fit Merge Count — Phase 59.1 (2026-04-24)

**Added**
- `verifyAndRefineMerge()` — same-language verification step before merge fixing. Compares Google Translate baseline (VI) vs LLM output (VI) to confirm merge is real (`verifyRatio >= 1.3`). Rejects false alarms where LLM was simply verbose.
- Best-fit algorithm for merge count: accumulates Google translations of successive segments, picks j with `|accumulated/llmLen - 1.0|` closest to zero. Can adjust absorbed count UP or DOWN from initial heuristic detection.
- Overlap-safe scan bound (`nextMergePos`) prevents best-fit from claiming segments belonging to adjacent merges.
- 9 new unit tests: `verifyAndRefineMerge` direct tests (confirm, reject, best-fit correct/up/down, fallback, partial) + `fix()` integration tests (false alarm rejection, pipeline adjustment).
- Constants: `VERIFY_THRESHOLD = 1.3`, `MAX_BEST_FIT_DIFF = 0.35`, `MAX_SCAN_EXTRA = 2`.

**Changed**
- `fix()` inner loop: replaced direct `translateBatch(absorbedTexts)` with `verifyAndRefineMerge()` call. Google translations are now batched for current + candidate segments in one call, reused for both verification and anchor extraction. Zero wasted API calls.

**Tests**: 46 total (37 previous + 9 new), all passing.

### MergeFixer Bug Fixes + Unit Tests — Phase 59 (2026-04-24)

**Fixed**
- [CRITICAL] `detectMerges()` false positive: removed forced `absorbed = 1` when no subsequent lines show merge evidence. Verbose but correct translations (e.g., "Yeah" → 3-word Vietnamese) no longer trigger merge detection and subsequent corruption via proportional split.
- [MEDIUM] Short segment false positives: added `MIN_WORDS_FOR_RATIO_CHECK = 4` guard. Segments with fewer than 4 input words skip ratio-based merge detection entirely.
- [MEDIUM] CJK word counting: `wordCount()` now detects CJK text (Japanese, Chinese, Korean) via Unicode ranges and uses character-based counting (chars / 2) instead of whitespace split. Prevents systematic false positives for CJK target languages.
- [LOW] Partial anchor recovery in `fix()`: when some rough translations succeed and others fail, successful anchors are used for precise splitting while failed segments get proportional fallback within their range only.

**Added**
- `tests/unit/merge-fixer.test.js` — 37 unit tests covering `detectMerges()`, `fix()`, `wordCount()`, `proportionalSplit()`, `extractAnchorWords()`, `findAnchorInText()`, false positive regression tests for all 3 bug fixes.
- `_internals` export in `merge-fixer.js` for direct unit testing of internal functions.

**Tests**: 37 new tests, all passing. No regressions in existing test suites.

### JSON Structured Output + Merge Detection & Auto-Fix — Phase 58 (2026-04-22)

**Added**
- `src/background/rough-translator.js` — Google Translate unofficial endpoint wrapper for free rough translations. `translate()` single text, `translateBatch()` concurrent. 5s timeout, graceful null on failure.
- `src/background/merge-fixer.js` — post-processing module to detect and fix LLM line merges. `detectMerges()` scans word-count ratios (>2.0 merged, <0.5 displaced). `fix()` uses Google Translate anchors to find precise split points. Proportional fallback when anchors fail. Processes merges right-to-left to preserve indices.
- `getProviderJsonConfig()` in translator.js — returns provider-specific JSON mode config. Gemini gets `responseSchema` with `minItems`/`maxItems` for constrained decoding. OpenAI-style gets `response_format: { type: "json_object" }`.
- `buildJsonSystemPrompt()` — simplified prompt requesting JSON `{"lines": [...]}` array. No timestamp format rules. Preserves UNFILTERED & FAITHFUL rule.
- `buildJsonUserPrompt()` — zero-indexed `[0] text` format, no timestamps.
- `parseJsonResponse()` — JSON parser with regex fallback extraction, array length validation, original-text padding for missing elements.
- `supportsJsonMode` flag on all 9 providers in `providers-registry.js` (true: google, openai, groq, deepseek, xai, mistral; false: anthropic, openrouter, ollama).
- `gemini-2.5-flash` model added to Google provider (set as default).

**Changed**
- `tryKeyForBatch()` now operates in dual-mode: JSON-first with text-fallback. Detects provider JSON support, builds appropriate prompts, parses JSON array by index instead of timestamp regex. Streaming disabled for JSON mode.
- `callOpenAIStyle()` in providers.js conditionally adds `response_format` to payload.
- `callGemini()` conditionally adds `responseMimeType` + `responseSchema` to `generationConfig`.
- All `tryKeyForBatch` callers (`processGroqWaterfall`, `fallbackToNonGroq`, `translateBatchWithFailover`) now pass `context/src/tgt` in options for JSON prompt building.
- `splitForGroqPayload()` uses JSON prompt sizes for payload estimation when Groq supports JSON mode.
- `manifest.json` — added `https://translate.googleapis.com/*` to host_permissions.
- `maxTokens` estimate increased for JSON mode: `segments.length * 130` (vs `* 100`), cap `16384`.

**Tests**: Manual — load extension, translate YouTube video, verify `[JSON_MODE]` and `[ANCHOR]`/`[FALLBACK]` logs in Service Worker console. Verify previously-shifted subtitles now align correctly.

### Logger TRACE Level + Smart Groq Payload Distribution — Phase 57 (2026-04-22)

**Added**
- `Logger.trace()` — new log level that always prints via `console.log()` regardless of `IS_PRODUCTION`, replacing the hack of using `Logger.error()` for debug checkpoints. Chrome Extensions panel now shows 0 fake errors during normal translation.
- `buildSystemPrompt()` — extracted system prompt template into reusable function for Groq waterfall and standard failover.
- `tryKeyForBatch()` — extracted per-key translation attempt into standalone function returning structured status (`success`, `413`, `429`, `cooldown`, `parse_fail`, etc.).
- `partitionKeysByProvider()` — splits API key array into `{ groqKeys, nonGroqKeys }` preserving health-score ordering.
- `splitForGroqPayload()` — pre-calculates segment chunk boundaries to stay within Groq's 95KB payload limit using binary search.
- `processGroqWaterfall()` — sticky-until-fail waterfall: distributes chunks across Groq keys, advancing cursor only on failure (429/error), maximizing each key's quota.
- `fallbackToNonGroq()` — sends unprocessed chunks to non-Groq providers unsplit (Google/OpenAI handle much larger payloads).
- Per-provider transcript truncation in `generateContextSummary()` — Groq keys receive truncated transcript fitting within payload limit; non-Groq keys receive full transcript.

**Changed**
- 10 checkpoint `Logger.error()` calls in `translator.js` converted to `Logger.trace()` (normal-flow diagnostics).
- 4 failure-with-fallback `Logger.error()` calls converted to `Logger.warn()` (e.g., no API keys, batch failed, 413 split).
- 2 fetch diagnostic `Logger.error()` calls in `providers.js` converted to `Logger.trace()`.
- `translateBatchWithFailover()` now uses Groq-conditional pre-flight routing instead of provider-agnostic binary split. Non-Groq providers no longer trigger unnecessary 95KB payload splitting.
- `tail()` color map updated: TRACE level shown in cyan (`#06b6d4`).

**Tests**: Manual verification required — load unpacked extension, translate a long video, verify Chrome Extensions panel shows 0 errors on success; verify Groq waterfall distributes chunks across keys in Service Worker console.

### Feature: Popup Language Selector — Phase 56 (2026-04-21)

**Added**
- Language selector dropdown in Popup UI — allows users to change target translation language (15 languages) directly without opening Settings.
- Dropdown populated dynamically from `YOUSUB_PROVIDERS.languages` (excluding `auto`).
- Bidirectional sync with Options page via `storage.onChanged` listener.
- Dark glassmorphism styling with custom SVG dropdown arrow, matching existing Popup theme.

**Changed**
- `updateLanguageUI()` now syncs both the Translate button text and the dropdown selection.

### Code Quality Polish — Phase 55 (2026-04-21)

**Added**
- `src/shared/utils.js` — centralized `sanitizeKey()` function, eliminating 3 duplicate copies across `api-manager.js`, `providers.js`, `health.js`.
- Periodic cleanup for `keyCooldowns` Map in translator (every 60s) to prevent unbounded growth.
- Segment validation before translation — filters out entries missing `text` or `startMs`.

**Changed**
- Overlay `showStatus()` now whitelists CSS class type parameter (`info`, `success`, `warning`, `error`), preventing injection of arbitrary class names.
- `manifest.json` updated with `src/shared/utils.js` in `web_accessible_resources`.

### Request Dedup & Port/Stream Cleanup — Phase 54.2 (2026-04-21)

**Added**
- Request deduplication in translator: concurrent `translate()` calls for the same tab+language return the existing in-flight Promise instead of spawning duplicate API requests.
- Active port tracking in service worker via `activePorts` Map with connection timestamps and tab IDs for debugging.
- `failures` array now populated with provider name, model, HTTP status, and retry-after duration for diagnostic display.

**Fixed**
- `SyncEngine.updatePartial()` now validates `startIndex` type and bounds before merging, and stops at array boundary to prevent out-of-bounds writes.

### Retry Logic & Timeout Hardening — Phase 54.1 (2026-04-21)

**Added**
- Automatic retry with exponential backoff (1s, 3s) for transient API failures (timeouts, 5xx errors). 4xx errors (429, 413) continue to use existing cooldown/split mechanisms without retry.
- Secondary 20s safety timeout on XHR fetcher as fallback if `xhr.timeout` (15s) doesn't fire. Aborts XHR and sends error response.

**Changed**
- `RETRY_ATTEMPTS` restored from 0 to 2 (was disabled in Phase 47 anti-deadlock work).
- `JSON.parse()` calls in subtitle parser now produce specific error messages distinguishing parse failures from fetch failures.

### Null Safety & Callback Guards — Phase 53.2 (2026-04-21)

**Fixed**
- Null dereference crash in `main-world-extractor.js` transcript parser when `host` element disappears between DOM check and assignment (race condition on YouTube SPA navigation).
- Double callback invocation in `video-binder.js` prevented with `callbackFired` flag — guards against simultaneous initial-check and MutationObserver both finding the video element.

### Event Listener & Observer Cleanup — Phase 53.1 (2026-04-21)

**Fixed**
- Memory leak: `chrome.storage.onChanged` listeners now stored and removed in `overlay.js` `destroy()`, preventing accumulation across overlay recreations.
- Duplicate `chrome.runtime.onMessage` listener registration in `main.js` guarded with flag.
- `subtitle-extractor.js` now uses one-shot pattern — message listener removed immediately after callback fires.
- `video-binder.js` MutationObserver callback wrapped in try/catch with automatic cleanup on exception.

### Cache Atomicity & DOM Freshness — Phase 52.2 (2026-04-21)

**Changed**
- `Cache.set()` now writes data and metadata in a single atomic `storage.local.set()` call, preventing race conditions between concurrent translation requests.
- `_evictIfNeeded()` operates on the same metadata snapshot used by `Cache.set()` instead of re-reading from storage.

**Fixed**
- Stale overlay attachment after SPA navigation: `Overlay.show()` now verifies `playerElement` is still connected to DOM and is the active player (Shorts reel check) before rendering. Destroys and recreates overlay if stale.

### Service Worker Lifecycle & Message Safety — Phase 52.1 (2026-04-21)

**Added**
- Keepalive heartbeat (PING/PONG every 25s) for streaming port connections to prevent MV3 Service Worker termination during long translations.
- Per-port AbortController in service worker that cancels in-flight API requests when the content script disconnects.
- External abort signal parameter in `translate()` for port-level cancellation cascade.
- Timeout guard (10s) for cache-check `sendMessage` to prevent silent stalls on extension reload.

**Fixed**
- `chatStream()` now properly wires external abort signals, matching the existing pattern in `chat()`. Previously, abort signals from the translator's global timeout were silently ignored during streaming translations.
- All `port.postMessage()` calls in service worker are now wrapped in try/catch to prevent unhandled exceptions after port disconnect.

### Shorts Stability & Video Binding — Phase 50.7 (2026-04-10)

**Added**
- Active Reel Targeting: Enhanced `video-binder.js` to prioritize `ytd-reel-video-renderer[is-active] video` for precise synchronization on YouTube Shorts.
- Visibility Enforcement: Added an `isVisible` check to ensure the extension only binds to the video element currently in the viewport, ignoring hidden/cached reels.

**Changed**
- Synchronization Safety: Hardened `sync-engine.js` to skip processing when a video becomes invisible (e.g., during swiping), preventing "stuck" or "ghost" subtitles.

**Fixed**
- Global Syntax Error: Resolved a fatal `Missing catch or finally` error in `main-world-extractor.js` that blocked initialization on some layouts.
- Stale Timestamp Tracking: Fixed issue where switching Shorts would leave the previous video's subtitles frozen on screen.

### Security Hardening (Trusted Types) & Crash Recovery — Phase 50.6 (2026-04-10)

**Added**
- Global Exception Boundaries: Wrapped `MainWorldExtractor` and `MainWorldFetcher` in high-level `try-catch` blocks to prevent unhandled errors from crashing the main world context.
- Trusted Types Policy Injection: Created `yousub-extractor-policy` and `yousub-fetcher-policy` to ensure DOM manipulation (HTML/Scripts) complies with YouTube's strict security policies.

**Changed**
- Sanitized DOM Updates: Replaced direct `innerHTML` assignments with a `setSafeHTML` helper function across all main-world scripts.
- Multi-Language Support: Added Vietnamese localization support (`"mô tả"`) to the Shorts description menu crawler.

**Fixed**
- Security policy violations (TrustedHTML) that were preventing script injection on modern YouTube layouts.
- Crash-on-error behavior where a single failure in the extraction pipeline would break the entire extension lifecycle until page reload.

### Local LLM Support (Ollama) — Phase 50.3 (2026-04-10)

**Added**
- Ollama Integration: Support for locally hosted Ollama instances via the OpenAI-compatible v1 chat completions API.
- Dynamic Permission Management: Implemented `optional_host_permissions` for `http://localhost/*` and `http://127.0.0.1/*`, allowing users to grant access only when needed.
- Local Model Synchronization: Added a "Refresh Models" feature that dynamically fetches available Ollama models (Llama, Mistral, etc.) via a background proxy to bypass CORS.
- Connection UI: Added a "Connect Ollama" button in the Translation settings for a seamless one-click setup.

**Changed**
- API Header Logic: Updated `providers.js` to omit the `Authorization` header when no API key is provided, ensuring compatibility with local endpoints.

**Fixed**
- Restricted CORS access issues when calling localhost from extension settings pages.

### Streaming Translation (SSE) & Real-time Delivery — Phase 50.2 (2026-04-10)

**Added**
- Port-based Messaging Architecture: Switched to `chrome.runtime.connect` for translation requests to enable long-lived connections and incremental chunk delivery.
- LLM Streaming Support: Implemented `chatStream` in `providers.js` with specialized SSE parsers for OpenAI (delta), Anthropic (content_block_delta), and Gemini (stream JSON).
- Streaming Mode Toggle: Added a new setting in the Options UI to allow users to choose between standard batch delivery and real-time word-by-word streaming.

**Changed**
- Background Translator Orchestration: Updated `translator.js` to accept callbacks for stream chunks, forwarding raw AI output to the frontend as it arrives.
- Content Script Responsiveness: Modified `main.js` to apply partial translation updates to the `SyncEngine` immediately upon chunk reception, significantly reducing perceived latency.

**Fixed**
- UI lag during long-form video translation by eliminating the need to wait for full batch completion (50+ lines) before rendering initial results.
- Message bus bottlenecks by utilizing dedicated Port communication for heavy data streams.

### YouTube Shorts Support & Security Hardening — Phase 50.1 (2026-04-10)

**Added**
- Specialized YouTube Shorts Support: Implementation of "Active Reel" detection and extraction logic. Targeted `ytd-reel-video-renderer[is-active]` to find the correct player on Shorts pages.
- Shorts-specific UI Adaptation: Added `.yousub-shorts` CSS class and logic in `overlay.js` to automatically adjust width and bottom-offset specifically for the vertical Shorts player.

**Changed**
- TrustedHTML Security Enforcement: Switched from inline `innerHTML` assignments to mandatory `TrustedTypes.toSafeHTML()` usage across `overlay.js` and `main.js` to comply with YouTube's strict security policy.
- MainWorldExtractor Robustness: Updated video ID extraction to handle path-based identifiers (`/shorts/VIDEO_ID`) when the `v` URL parameter is absent.
- Module Import Resilience: Converted `Overlay` and `Main` to use explicit ESM imports for `TrustedTypes`, eliminating race conditions and ensuring policy initialization.

**Fixed**
- "TrustedHTML assignment" crash that blocked the overlay from appearing on modern YouTube layouts.
- Subtitle extraction failure on Shorts caused by incorrect selector targeting and missing video ID handling.
- Overlay overlap with Shorts action buttons and metadata by increasing default bottom offset for vertical views.

### Anti-Deadlock & Stability Overhaul — Phases 47–48 (2026-04-09)

**Added**
- Global Abort Protocol: Integrated `AbortController` in `translator.js` to immediately terminate all pending `fetch` requests when the 55s safety timeout is reached, stopping background zombie tasks.
- Payload Pre-flight Check: Added Byte-size estimation logic to automatically split batches *before* submission if they exceed 95KB, preventing 413 (Payload Too Large) errors on Groq.
- Key Cooldown Mechanism: Implemented a 10s per-key lockout after 429 errors to prevent rapid-fire spamming of rate-limited API keys.
- Sequential Recursive Splitting: Modified recursive splitting to execute sequentially rather than in parallel, eliminating request spikes that caused concurrent 429/413 errors.

**Changed**
- Logger I/O Optimization: Completely disabled storage persistence for logs during active translation. Logs are now strictly console-only to eliminate Service Worker I/O deadlocks.
- Context Capping: Fixed `VIDEO CONTEXT` length at 500 characters within the system prompt to ensure payload stability across all AI models.
- Success Flag Propagation: Standardized the `success` return flag across all translation paths (recursive and failover) to ensure the UI correctly displays Vietnamese results.

**Fixed**
- "Original Text Only" display bug caused by missing success indicators in split batches.
- Persistent 413 errors on Groq even with small line counts by stripping context in deep recursive calls.
- Infinite logging loop/spam after translation failure.


### Pipeline Stability & Performance — Phases 42–46 (2026-04-08)

**Added**
- Request Heartbeat: 60-second timeout for background requests in `main.js` to ensure the loading spinner always hides.
- Robust Routing: Central `try/catch` and `async/await` refactor for `service-worker.js` and `api-manager.js`.
- Adaptive Rate Limit Handling: Exponential backoff (respecting `Retry-After`) for 429 errors.
- Context Summary Safeguard: 10-second timeout for video analysis calls to prevent pipeline hangs.
- Granular Diagnostic Logging: Detailed "check-in" logs in Background Console (Analyzing → Summary Ready → Batching).

**Changed**
- Key Manager Robustness: Replaced nested promises with clean `async/await` to prevent silent crashes in `getValidKeys`.
- I/O Performance: Centralized storage access in `APIManager` (O(1) fetch instead of O(N) per key).
- Circuit Breaker Relaxed: Increased threshold to 10 consecutive failures to reduce premature key lockouts.

**Fixed**
- Infinite "Loading" UI state caused by silent background crashes.
- `Extension context invalidated` hang when extension reloads without page refresh.
- Potential `TypeError` in Key Scoring logic when encountering new API keys.
- Key Hash Mismatches: Shared `sanitizeKey` logic across all background modules.

### Security & Stability — Phases 36–41 (2026-04-08)

**Added**
- Trusted Types compliance for YouTube's CSP restrictions (`src/shared/trusted-types.js`)
- Health Summary Protocol for real-time API status in Popup UI
- Smart extraction pre-check to handle pre-opened transcript panels

**Changed**
- Zero-width character sanitization across all key-handling modules
- API key `.trim()` enforcement at input, storage, and execution layers
- Batch size optimized to 400 lines; context sampling capped at 100 segments
- 1-second throttle between batch requests to prevent rate limiting
- Strict translation verification — returns failure if all batches fail
- Explicit `host_permissions` for all LLM provider domains (Manifest V3)
- `stream: false` added to OpenAI-style payloads for provider compatibility

**Fixed**
- Fatal `wait is not defined` crash in translator pipeline
- "Green Dot / Red Text" UI state desync in Popup
- Popup hanging indefinitely on health check responses
- API registry bug where auto-detection accessed properties on a string

### Subtitle Sync & Pipeline Hardening — Phases 35.1–35.19 (2026-04-06 → 2026-04-08)

**Added**
- Timestamp-based translation tracking (`[HH:MM:SS]`) replacing numeric IDs
- Translation propagation for merged segments (sticky fill)
- Incremental subtitle display — batches render as they arrive
- Cache transparency — UI distinguishes cache hits from live translations
- Detailed API failure notifications with provider/model breakdown
- Strict error enforcement — pipeline halts on config/API errors
- Production logging flag with automatic build-time override (`IS_PRODUCTION`)
- Broadcast cache invalidation across all open YouTube tabs
- Live API health updates with pulse-red animation for failures
- Custom confirmation modal (glassmorphism) replacing native `confirm()`

**Changed**
- ESM migration — 9+ files converted to standard `import/export`
- Manifest simplified to single entry point + `web_accessible_resources`
- Architecture moved from global `window.YouSub` to explicit module imports
- Incremental merge logic replacing all-or-nothing subtitle updates
- Rigid `[#ID]` identifier tagging with alignment recovery on missing IDs
- Global absolute IDs (video-wide `[#501]`) eliminating per-batch numbering resets

## [0.2.1] — 2026-04-06

### Translation Engine Optimization — Phases 32–35 (2026-04-06)

**Added**
- Incremental subtitle display with batch-by-batch streaming
- Gemini safety filter bypass (`BLOCK_NONE` for all harm categories)
- Interactive error toasts with direct "Open Settings" link
- `YOUSUB_OPEN_SETTINGS` message handler for in-page settings access

**Changed**
- `max_tokens` reduced to 20 for API key validation (was 32,768)
- Provider `chat()` accepts optional `maxTokens` parameter
- Translator supports batch-completion callbacks for streaming UI

## [0.2.0] — 2026-04-06

### Popup UI & Cache Management — Phase 31 (2026-04-06)

**Added**
- "Clear Page Cache" button in Popup for current video
- `Cache.removeByVideoId` for per-video cache purge
- Multi-line API health display with online model names

### Subtitle Appearance & Translation Quality — Phases 23–30 (2026-04-05 → 2026-04-06)

**Added**
- Full-transcript context summary (`generateContextSummary`) for translation batches
- Numbered envelope strategy (`N| Original`) for line count preservation
- Smart regex parser for robust extraction from AI responses
- Dynamic control bar offset for subtitle positioning
- Overlay loading spinner during extraction/translation
- Persistent translation toggle in Popup with visual states
- Signature-based cache with video ID verification

**Changed**
- Adaptive batch sizing with context optimization
- Sparse backfill strategy for partial LLM outputs
- `max_tokens` standardized across providers (uncapped for translation, minimal for testing)
- CSS variables for subtitle positioning with smooth transition animations

### Features & Visual Polish — Phases 14–23 (2026-04-03 → 2026-04-04)

**Added**
- Dual subtitle display (original + translated simultaneously)
- Full appearance customization (font size, color, opacity, position)
- Real-time subtitle preview in Settings
- Premium "Slate & Rose" UI with glassmorphism effects
- Automated packaging via `scripts/package.js`
- Cross-browser support (Chrome, Firefox, Edge) with `webextension-polyfill`
- Test suite — 31 unit tests at 94% coverage (Jest + JSDOM)
- Performance optimization — O(1) subtitle lookup, DOM caching, throttled updates
- Translation caching with LRU eviction (100 videos) and 7-day TTL
- Hybrid extraction engine (XHR primary, DOM scraping fallback)
- YouTube Shorts support and live stream detection
- Error handling with toast notifications and API health indicators
- Structured debug logging (JSON Lines) with export functionality

**Changed**
- Overlay upgraded to vertical Flexbox for multi-line support
- Provider health tracking with circuit breaker states and visual badges
- Cleanup logic refined for SPA navigation (zero memory leaks)

### Foundation & Core Infrastructure — Phases 1–13 (2026-04-03)

**Added**
- Manifest V3 Chrome extension foundation
- SPA-aware YouTube page detection and video player binding
- Subtitle track discovery via MAIN world script injection
- Subtitle fetching and parsing (JSON3 + XML formats)
- Translation pipeline with background service worker proxy
- Multi-provider LLM engine (OpenAI, Gemini, Anthropic, Groq, DeepSeek, xAI, Mistral, OpenRouter)
- API key management UI with CRUD, testing, validation, and failover
- Provider & model registry (`src/shared/providers-registry.js`)
- Full Settings page with tabbed navigation (Translation, Appearance, About)
- Popup UI for quick actions and status display
- Centralized JSON logger (`src/shared/logger.js`)
- Design decisions documentation (`YOUSUB_DESIGN_DECISIONS.md`)
