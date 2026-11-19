/**
 * Shared pure helpers for Smart Auto-Enable decisions (Phase 89),
 * Translation Style Presets, Custom Glossary rules, and Video Context formatting (Phase 90).
 */

export const TRANSLATION_STYLE_PRESETS = Object.freeze([
  {
    id: 'natural',
    name: 'Natural / Conversational',
    instruction:
      'Use natural, conversational everyday phrasing appropriate to the speakers rather than stiff word-for-word phrasing.',
  },
  {
    id: 'technical',
    name: 'Technical / IT',
    instruction:
      'Use precise engineering and software terminology. Keep established technical terms, APIs, commands, and identifiers intact.',
  },
  {
    id: 'academic',
    name: 'Academic / Lecture',
    instruction:
      'Use clear, accurate academic and instructional language suitable for university lectures and documentaries.',
  },
  {
    id: 'anime',
    name: 'Anime / Slang',
    instruction:
      'Preserve expressive casual tone, slang, idioms, and character voice vividly without flattening personality.',
  },
  {
    id: 'custom',
    name: 'Custom Prompt',
    instruction: '',
  },
]);

const MUSIC_TITLE_REGEX =
  /\b(official\s*(music\s*)?video|music\s*video|lyric\s*video|official\s*audio|live\s*performance|instrumental|karaoke)\b|【\s*mv\s*】|\(\s*mv\s*\)|\[\s*mv\s*\]|\bm\/v\b/i;

/**
 * Normalize language tags while keeping zh-TW distinct from zh / zh-CN.
 * @param {string} code
 * @returns {string}
 */
export function normalizeBaseLang(code) {
  if (!code || typeof code !== 'string') return '';
  const clean = code.trim().toLowerCase().replace(/^a\./, '');
  if (!clean || clean === 'auto') return '';
  if (clean === 'zh-tw' || clean === 'zh-hant' || clean === 'zh-hk') return 'zh-tw';
  if (clean.startsWith('zh')) return 'zh';
  return clean.split(/[-_]/)[0];
}

/**
 * Detect whether a YouTube video appears to be music/song content.
 * @param {{ category?: string, title?: string }} [meta]
 * @returns {boolean}
 */
export function isLikelyMusicVideo({ category = '', title = '' } = {}) {
  const cat = String(category || '')
    .trim()
    .toLowerCase();
  if (cat === 'music' || cat === 'âm nhạc' || cat === '音楽') return true;
  if (!cat && title && MUSIC_TITLE_REGEX.test(String(title))) return true;
  return false;
}

/**
 * Determine whether Smart/Always Auto-Enable should trigger translation on page entry.
 * Keeps `manual` safe by default and guards against BYOK token surprises on native/music/stopped videos.
 * @param {object} opts
 * @returns {{ shouldStart: boolean, reason: string, detectedLang?: string }}
 */
export function evaluateSmartAutoEnable({
  activationMode = 'manual',
  skipMusicVideos = true,
  targetLang = 'vi',
  defaultCaptionLang = '',
  captionLanguages = [],
  category = '',
  title = '',
  videoId = '',
  manuallyStoppedVideos = null,
  hasApiKeys = false,
} = {}) {
  if (!videoId) return { shouldStart: false, reason: 'NO_VIDEO' };
  if (manuallyStoppedVideos && typeof manuallyStoppedVideos.has === 'function') {
    if (manuallyStoppedVideos.has(videoId)) {
      return { shouldStart: false, reason: 'MANUAL_STOP' };
    }
  }
  if (!hasApiKeys) return { shouldStart: false, reason: 'NO_API_KEYS' };
  if (activationMode !== 'smart_auto' && activationMode !== 'always_auto') {
    return { shouldStart: false, reason: 'MANUAL_MODE' };
  }
  if (skipMusicVideos !== false && isLikelyMusicVideo({ category, title })) {
    return { shouldStart: false, reason: 'MUSIC_SKIPPED' };
  }
  if (activationMode === 'always_auto') {
    return { shouldStart: true, reason: 'ALWAYS_AUTO' };
  }

  const normalizedTarget = normalizeBaseLang(targetLang) || 'vi';
  const normalizedCandidates = (Array.isArray(captionLanguages) ? captionLanguages : [])
    .map(normalizeBaseLang)
    .filter(Boolean);
  const detectedLang = normalizeBaseLang(defaultCaptionLang) || normalizedCandidates[0] || '';

  if (!detectedLang) {
    return { shouldStart: false, reason: 'NO_CAPTIONS' };
  }
  if (detectedLang === normalizedTarget) {
    return { shouldStart: false, reason: 'SAME_LANGUAGE', detectedLang };
  }
  return { shouldStart: true, reason: 'FOREIGN_LANGUAGE', detectedLang };
}

/**
 * Build structured glossary & keep-terms constraints from raw user text rules.
 * Supports lines like `LLM`, `transformer -> bộ biến đổi`, or `source => target`.
 * @param {{ keepTermsText?: string, glossaryPairsText?: string, pronounRule?: string }} [rawGlossary]
 * @returns {{ keepTerms: string[], pairs: Array<{ source: string, target: string }>, pronounRule: string }}
 */
export function parseGlossaryConfig(rawGlossary = {}) {
  if (!rawGlossary || typeof rawGlossary !== 'object') {
    return { keepTerms: [], pairs: [], pronounRule: '' };
  }
  const keepTerms = String(rawGlossary.keepTermsText || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40)
    .map((s) => s.slice(0, 60));

  const pairs = String(rawGlossary.glossaryPairsText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.+?)\s*(?:=>|->|=|:)\s*(.+)$/);
      if (!m) return null;
      return {
        source: m[1].trim().slice(0, 60),
        target: m[2].trim().slice(0, 60),
      };
    })
    .filter((p) => p && p.source && p.target)
    .slice(0, 40);

  const pronounRule = String(rawGlossary.pronounRule || '')
    .trim()
    .slice(0, 160);

  return { keepTerms, pairs, pronounRule };
}

/**
 * Format bounded style + glossary + video/channel metadata guidance for translator prompts.
 * @param {object} [opts]
 * @returns {string}
 */
export function buildTranslationGuidanceBlock({
  styleId = 'natural',
  customPrompt = '',
  glossary = {},
  videoTitle = '',
  channelName = '',
} = {}) {
  const parts = [];
  const cleanTitle = String(videoTitle || '')
    .trim()
    .slice(0, 140);
  const cleanChannel = String(channelName || '')
    .trim()
    .slice(0, 80);
  if (cleanTitle || cleanChannel) {
    const metaPieces = [];
    if (cleanTitle) metaPieces.push(`Title: "${cleanTitle}"`);
    if (cleanChannel) metaPieces.push(`Channel: "${cleanChannel}"`);
    parts.push(`VIDEO METADATA: ${metaPieces.join(' | ')}`);
  }

  const preset =
    TRANSLATION_STYLE_PRESETS.find((p) => p.id === styleId) || TRANSLATION_STYLE_PRESETS[0];
  if (styleId === 'custom' && customPrompt && String(customPrompt).trim()) {
    parts.push(`STYLE INSTRUCTION: ${String(customPrompt).trim().slice(0, 400)}`);
  } else if (preset && preset.instruction && preset.id !== 'natural') {
    parts.push(`STYLE PRESET (${preset.name}): ${preset.instruction}`);
  } else if (styleId === 'natural' && preset.instruction) {
    parts.push(`STYLE PRESET (${preset.name}): ${preset.instruction}`);
  }

  const parsed = parseGlossaryConfig(glossary);
  if (parsed.keepTerms.length > 0) {
    parts.push(`KEEP UNTRANSLATED: ${parsed.keepTerms.join(', ')}`);
  }
  if (parsed.pairs.length > 0) {
    const mapStr = parsed.pairs.map((p) => `${p.source} => ${p.target}`).join('; ');
    parts.push(`GLOSSARY TERMS: ${mapStr}`);
  }
  if (parsed.pronounRule) {
    parts.push(`PRONOUN / ADDRESSING RULE: ${parsed.pronounRule}`);
  }

  return parts.join('\n');
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Derive a compact cache variant suffix when style preset != 'natural' or custom rules exist.
 * Returns '' for default settings so existing translation cache keys stay 100% compatible.
 * @param {object} [opts]
 * @returns {string}
 */
export function computeStyleCacheVariant({
  styleId = 'natural',
  customPrompt = '',
  glossary = {},
} = {}) {
  const safeStyle = String(styleId || 'natural').trim() || 'natural';
  const cleanPrompt = safeStyle === 'custom' ? String(customPrompt || '').trim() : '';
  const parsed = parseGlossaryConfig(glossary);
  const hasGlossary =
    parsed.keepTerms.length > 0 || parsed.pairs.length > 0 || Boolean(parsed.pronounRule);

  if (safeStyle === 'natural' && !cleanPrompt && !hasGlossary) {
    return '';
  }

  const sig = JSON.stringify({
    s: safeStyle,
    p: cleanPrompt,
    k: parsed.keepTerms,
    g: parsed.pairs,
    r: parsed.pronounRule,
  });
  return `${safeStyle}_${fnv1a32(sig)}`;
}
