import { describe, test, expect } from '@jest/globals';
import {
  normalizeBaseLang,
  isLikelyMusicVideo,
  evaluateSmartAutoEnable,
  parseGlossaryConfig,
  buildTranslationGuidanceBlock,
  computeStyleCacheVariant,
} from '../../src/shared/video-context.js';

describe('video-context.js Smart Auto-Enable & Context/Glossary helpers (Phases 89-90)', () => {
  test('normalizeBaseLang preserves zh-tw distinct from zh and strips regional tags', () => {
    expect(normalizeBaseLang('en-US')).toBe('en');
    expect(normalizeBaseLang('a.ja')).toBe('ja');
    expect(normalizeBaseLang('zh-TW')).toBe('zh-tw');
    expect(normalizeBaseLang('zh-Hans')).toBe('zh');
    expect(normalizeBaseLang('auto')).toBe('');
  });

  test('isLikelyMusicVideo identifies Music category and MV/Lyric titles', () => {
    expect(isLikelyMusicVideo({ category: 'Music', title: 'Anything' })).toBe(true);
    expect(
      isLikelyMusicVideo({ category: '', title: 'Artist - Song (Official Music Video)' })
    ).toBe(true);
    expect(isLikelyMusicVideo({ category: '', title: 'Vocal [MV]' })).toBe(true);
    expect(isLikelyMusicVideo({ category: 'Education', title: 'CS50 Lecture 1' })).toBe(false);
    expect(isLikelyMusicVideo({ category: '', title: 'TypeScript Tutorial' })).toBe(false);
  });

  test('evaluateSmartAutoEnable enforces safe manual default, foreign-lang trigger, music skip, no-keys guard, and manual-stop override', () => {
    const base = {
      videoId: 'v123',
      targetLang: 'vi',
      defaultCaptionLang: 'en',
      captionLanguages: ['en'],
      category: 'Science & Technology',
      title: 'Deep Dive Into Compilers',
      hasApiKeys: true,
      skipMusicVideos: true,
    };

    // Safe default: Manual does not auto-start
    expect(evaluateSmartAutoEnable({ ...base, activationMode: 'manual' })).toEqual({
      shouldStart: false,
      reason: 'MANUAL_MODE',
    });

    // No active API keys -> avoids spamming No API Key toast
    expect(
      evaluateSmartAutoEnable({ ...base, activationMode: 'smart_auto', hasApiKeys: false })
    ).toEqual({
      shouldStart: false,
      reason: 'NO_API_KEYS',
    });

    // Foreign language starts automatically
    expect(evaluateSmartAutoEnable({ ...base, activationMode: 'smart_auto' })).toEqual({
      shouldStart: true,
      reason: 'FOREIGN_LANGUAGE',
      detectedLang: 'en',
    });

    // Native language matches targetLang -> skipped
    expect(
      evaluateSmartAutoEnable({
        ...base,
        activationMode: 'smart_auto',
        defaultCaptionLang: 'vi-VN',
      })
    ).toEqual({
      shouldStart: false,
      reason: 'SAME_LANGUAGE',
      detectedLang: 'vi',
    });

    // Music video skipped unless opt-out disabled
    expect(
      evaluateSmartAutoEnable({
        ...base,
        activationMode: 'smart_auto',
        category: 'Music',
      })
    ).toEqual({
      shouldStart: false,
      reason: 'MUSIC_SKIPPED',
    });
    expect(
      evaluateSmartAutoEnable({
        ...base,
        activationMode: 'smart_auto',
        category: 'Music',
        skipMusicVideos: false,
      }).shouldStart
    ).toBe(true);

    // Manually stopped video stays stopped for current session
    const stopped = new Set(['v123']);
    expect(
      evaluateSmartAutoEnable({
        ...base,
        activationMode: 'smart_auto',
        manuallyStoppedVideos: stopped,
      })
    ).toEqual({
      shouldStart: false,
      reason: 'MANUAL_STOP',
    });

    // Uncaptioned video in smart_auto skips auto-spending Gemini video tokens
    expect(
      evaluateSmartAutoEnable({
        ...base,
        activationMode: 'smart_auto',
        defaultCaptionLang: '',
        captionLanguages: [],
      })
    ).toEqual({
      shouldStart: false,
      reason: 'NO_CAPTIONS',
    });

    // Always auto ignores caption language mismatch checks (unless music/stopped)
    expect(
      evaluateSmartAutoEnable({
        ...base,
        activationMode: 'always_auto',
        defaultCaptionLang: '',
        captionLanguages: [],
      })
    ).toEqual({
      shouldStart: true,
      reason: 'ALWAYS_AUTO',
    });
  });

  test('parseGlossaryConfig & buildTranslationGuidanceBlock format bounded metadata, style presets, and glossary rules', () => {
    const parsed = parseGlossaryConfig({
      keepTermsText: 'YouSub, TypeScript, Innertube',
      glossaryPairsText: 'transformer => bộ biến đổi\ntoken: thẻ từ',
      pronounRule: 'Use bạn / tôi',
    });
    expect(parsed.keepTerms).toEqual(['YouSub', 'TypeScript', 'Innertube']);
    expect(parsed.pairs).toEqual([
      { source: 'transformer', target: 'bộ biến đổi' },
      { source: 'token', target: 'thẻ từ' },
    ]);

    const guidance = buildTranslationGuidanceBlock({
      styleId: 'technical',
      glossary: {
        keepTermsText: 'TypeScript',
        glossaryPairsText: 'closure -> bao đóng',
        pronounRule: 'Neutral formal',
      },
      videoTitle: 'Understanding Closures',
      channelName: 'JS Weekly',
    });
    expect(guidance).toContain('Title: "Understanding Closures"');
    expect(guidance).toContain('Channel: "JS Weekly"');
    expect(guidance).toContain('Technical / IT');
    expect(guidance).toContain('KEEP UNTRANSLATED: TypeScript');
    expect(guidance).toContain('closure => bao đóng');
    expect(guidance).toContain('Neutral formal');

    const customGuidance = buildTranslationGuidanceBlock({
      styleId: 'custom',
      customPrompt: 'Translate like a seasoned noir detective.',
    });
    expect(customGuidance).toContain(
      'STYLE INSTRUCTION: Translate like a seasoned noir detective.'
    );
  });

  test('computeStyleCacheVariant returns empty string only for default natural preset without glossary', () => {
    expect(computeStyleCacheVariant({ styleId: 'natural', customPrompt: '', glossary: {} })).toBe(
      ''
    );
    expect(
      computeStyleCacheVariant({
        styleId: 'natural',
        customPrompt: 'ignored when not custom',
        glossary: {},
      })
    ).toBe('');

    const techVariant = computeStyleCacheVariant({ styleId: 'technical' });
    expect(techVariant).toMatch(/^technical_/);
    expect(techVariant).not.toBe(
      computeStyleCacheVariant({
        styleId: 'technical',
        glossary: { keepTermsText: 'YouSub' },
      })
    );
  });
});
