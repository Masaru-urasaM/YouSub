# YouSub — Open Issues

---

## Issue 1 — Foreign Script Contamination in Vietnamese Translations

**Date**: 2026-05-07
**Status**: DONE (2026-05-07)
**Severity**: Medium
**Affected Provider**: Groq (Llama 3.3 70B) — observed; potentially any multilingual LLM

### Problem

Groq/Llama occasionally injects Chinese characters (CJK Unified Ideographs) into Vietnamese translation output. Examples from production debug logs:

- `"lệnh封锁"` — "封锁" (Chinese for "blockade") mixed into Vietnamese
- `"Ồ天啊"` — "天啊" (Chinese for "oh my god") mixed into Vietnamese  
- `"展示 cho mọi người"` — "展示" (Chinese for "show") mixed into Vietnamese
- `"đó基本 là lựa chọn"` — "基本" (Chinese for "basically") mixed into Vietnamese

This is a known multilingual LLM issue — Vietnamese and Chinese share linguistic features, causing character bleed. Other foreign scripts (Japanese Kanji/Kana, Korean Hangul, Cyrillic, Arabic, etc.) could also appear depending on the model and input content.

### Root Cause

Multilingual LLMs sometimes activate wrong language tokens when translating between languages that share Unicode neighborhoods or linguistic features. Vietnamese uses Latin script with diacritics — any non-Latin script in the output is contamination.

### Desired Solution

Detect lines containing "foreign" (non-expected) script characters in the translation output. The detection should not be limited to Chinese — it should catch ANY script that does not belong in the target language output:

- For Vietnamese (Latin-based): detect CJK (Chinese/Japanese Kanji), Hangul (Korean), Cyrillic, Arabic, Thai, Devanagari, etc.
- General approach: define expected Unicode ranges per target language, flag lines containing characters outside those ranges

Lines flagged as contaminated should be treated the same as **merge-detected lines** in the existing MergeFixer pipeline:
1. Collect contaminated lines into a re-translation batch
2. Re-translate them using the same or a different provider
3. Replace the contaminated output with the clean re-translation

### Expected Result

- Lines with foreign script contamination are automatically detected after each batch
- Contaminated lines are re-translated (same flow as merge-fix re-translation)
- User sees clean Vietnamese output without Chinese/Japanese/Korean characters
- No manual intervention needed

### Implementation Notes

- Detection should happen in `merge-fixer.js` alongside existing merge/shift detection
- Re-translation uses the existing `retranslateShiftedLines()` infrastructure
- Unicode range check is lightweight (no API calls for detection)
- Target language determines which scripts are "expected" vs "foreign"

### References

- Debug log: Entry 4 (Groq, lines 21, 28-32), Entry 7 (lines 2-3), Entry 8 (lines 4, 30)
- Existing merge detection: `src/background/merge-fixer.js`
- Re-translation: `src/background/translator.js` — `retranslateShiftedLines()`
