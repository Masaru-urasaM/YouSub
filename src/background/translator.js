/**
 * translator.js — YouSub Translation API Client
 *
 * Uses Lingva Translate (free, no API key) for the MVP.
 * Design Decision 2: Lingva API for initial MVP.
 *
 * Strategy:
 *  1. Chunk texts to stay within URL length limits (~1500 chars per chunk)
 *  2. Join each chunk with a unique delimiter, make one API call per chunk
 *  3. Split result back; on mismatch fall back to per-entry translation
 *  4. On any error, return the original text (never fail silently)
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Public Lingva instance. Can be overridden for self-hosted instances. */
const LINGVA_INSTANCE = 'https://lingva.ml';

/** Delimiter unlikely to appear in subtitle text naturally. */
const DELIMITER = '\n###YOUSUB###\n';

/** Max characters per chunk to stay safely within URL length limits. */
const MAX_CHUNK_CHARS = 1500;

/** Per-request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Make a single Lingva API call.
 * @param {string} text - Text to translate (may be multi-line/delimiter joined).
 * @param {string} sourceLang - ISO 639-1 code or 'auto'.
 * @param {string} targetLang - ISO 639-1 code.
 * @returns {Promise<string>} Translated text.
 */
async function callLingva(text, sourceLang, targetLang) {
  const encoded = encodeURIComponent(text);
  const url = `${LINGVA_INSTANCE}/api/v1/${sourceLang}/${targetLang}/${encoded}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Lingva HTTP ${response.status} for lang pair ${sourceLang}→${targetLang}`);
  }

  const data = await response.json();

  if (!data || typeof data.translation !== 'string') {
    throw new Error('Lingva returned no translation field in response');
  }

  return data.translation;
}

/**
 * Split an array of texts into chunks where joined length <= MAX_CHUNK_CHARS.
 * @param {string[]} texts
 * @returns {string[][]} Array of chunks.
 */
function chunkTexts(texts) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const text of texts) {
    const addLen = text.length + DELIMITER.length;

    if (currentLen + addLen > MAX_CHUNK_CHARS && current.length > 0) {
      // Current chunk is full — start a new one
      chunks.push(current);
      current = [text];
      currentLen = text.length;
    } else {
      current.push(text);
      currentLen += addLen;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Translate a chunk as one joined request.
 * Returns translated array, or null if the split count mismatches.
 * @param {string[]} texts
 * @param {string} sourceLang
 * @param {string} targetLang
 * @returns {Promise<string[]|null>}
 */
async function translateChunk(texts, sourceLang, targetLang) {
  const joined = texts.join(DELIMITER);
  const translatedJoined = await callLingva(joined, sourceLang, targetLang);
  const parts = translatedJoined.split(DELIMITER);

  if (parts.length !== texts.length) {
    console.warn(
      `[YouSub] Translator: Chunk split mismatch — expected ${texts.length}, got ${parts.length}`
    );
    return null; // Signal caller to fall back
  }

  return parts.map((t) => t.trim());
}

/**
 * Translate texts one-by-one (fallback strategy).
 * On individual failure, returns the original text to preserve readability.
 * @param {string[]} texts
 * @param {string} sourceLang
 * @param {string} targetLang
 * @returns {Promise<string[]>}
 */
async function translateIndividually(texts, sourceLang, targetLang) {
  const results = [];
  for (let i = 0; i < texts.length; i++) {
    try {
      const translated = await callLingva(texts[i], sourceLang, targetLang);
      results.push(translated);
    } catch (err) {
      console.warn(
        `[YouSub] Translator: Individual failed at [${i}]: ${err.message} — keeping original`
      );
      results.push(texts[i]); // Graceful degradation: show original
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate an array of subtitle strings.
 *
 * @param {string[]} texts - Array of strings to translate.
 * @param {string} sourceLang - ISO 639-1 code or 'auto' for auto-detect.
 * @param {string} targetLang - ISO 639-1 code (e.g. 'vi', 'ja', 'en').
 * @returns {Promise<string[]>} Translated strings, same length as input.
 */
export async function translate(texts, sourceLang, targetLang) {
  if (!texts || texts.length === 0) return [];

  const src = sourceLang || 'auto';
  const tgt = targetLang || 'vi';

  console.log(
    `[YouSub] Translator: Translating ${texts.length} entries [${src} → ${tgt}]`
  );
  const startTime = Date.now();

  try {
    const chunks = chunkTexts(texts);
    console.log(`[YouSub] Translator: Split into ${chunks.length} chunk(s)`);

    const allResults = [];

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      try {
        const result = await translateChunk(chunk, src, tgt);

        if (result !== null) {
          allResults.push(...result);
        } else {
          // Bulk split mismatch — fall back to individual for this chunk only
          console.warn(
            `[YouSub] Translator: Chunk ${ci + 1}/${chunks.length} mismatch — translating individually`
          );
          const fallback = await translateIndividually(chunk, src, tgt);
          allResults.push(...fallback);
        }
      } catch (chunkErr) {
        console.warn(
          `[YouSub] Translator: Chunk ${ci + 1}/${chunks.length} failed: ${chunkErr.message} — translating individually`
        );
        const fallback = await translateIndividually(chunk, src, tgt);
        allResults.push(...fallback);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[YouSub] Translator: Done. ${allResults.length} translations in ${elapsed}ms`
    );
    return allResults;

  } catch (fatalErr) {
    // Should rarely happen — means chunkTexts itself failed, etc.
    console.error('[YouSub] Translator: Fatal error:', fatalErr.message);
    console.warn('[YouSub] Translator: Full individual fallback...');
    return translateIndividually(texts, src, tgt);
  }
}
