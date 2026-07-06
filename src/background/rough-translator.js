// RoughTranslator — best-effort "rough" translation used ONLY internally by MergeFixer
// (in the background service worker) to verify suspected line-merges. It uses Chrome's
// on-device Translator API and NEVER performs a network request: there is deliberately no
// third-party fallback, so no subtitle text leaves the device (privacy).
//
// IMPORTANT (verified 2026-06-30): Chrome documents the Translator API as unavailable in
// Web/Service Workers, and this module only probes the legacy `self.translation` /
// `self.ai.translator` shapes (the stable API since Chrome 138 is the top-level `Translator`
// global). In the MV3 service-worker context the on-device path therefore does not run
// today — translate() returns null and MergeFixer falls back to its offline heuristic (see
// Decision 15 / Decision 1). The on-device scaffolding is retained for a possible future
// move of rough-translation into a document/content-script context, where the API works.
import { Logger } from '../shared/logger.js';

const CHROME_TRANSLATOR_TIMEOUT_MS = 3000;

const _pairAvailability = new Map();
const _translatorInstances = new Map();

async function _checkChromeTranslatorAvailability(src, tgt) {
  const key = `${src}->${tgt}`;
  if (_pairAvailability.has(key)) return _pairAvailability.get(key);

  let available = false;
  try {
    if (self.translation?.canTranslate) {
      const status = await self.translation.canTranslate({
        sourceLanguage: src,
        targetLanguage: tgt,
      });
      available = status === 'readily' || status === 'after-download';
    } else if (self.ai?.translator?.capabilities) {
      const caps = await self.ai.translator.capabilities();
      const status = caps.languagePairAvailable(src, tgt);
      available = status === 'readily' || status === 'after-download';
    }
  } catch {
    // API not available in this context
  }

  _pairAvailability.set(key, available);
  if (available) Logger.debug('RoughTranslator', `Chrome Translator available for ${key}`);
  return available;
}

async function _translateWithChrome(text, src, tgt) {
  const key = `${src}->${tgt}`;
  try {
    let translator = _translatorInstances.get(key);
    if (!translator) {
      if (self.translation?.createTranslator) {
        translator = await self.translation.createTranslator({
          sourceLanguage: src,
          targetLanguage: tgt,
        });
      } else if (self.ai?.translator?.create) {
        translator = await self.ai.translator.create({ sourceLanguage: src, targetLanguage: tgt });
      }
      if (!translator) return null;
      _translatorInstances.set(key, translator);
    }
    const result = await Promise.race([
      translator.translate(text),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), CHROME_TRANSLATOR_TIMEOUT_MS)
      ),
    ]);
    return result || null;
  } catch (err) {
    Logger.debug('RoughTranslator', `Chrome Translator failed: ${err.message}`);
    return null;
  }
}

export const RoughTranslator = {
  async translate(text, src, tgt) {
    if (!text || !text.trim()) return null;

    const chromeAvailable = await _checkChromeTranslatorAvailability(src, tgt);
    if (chromeAvailable) {
      const result = await _translateWithChrome(text, src, tgt);
      if (result) return result;
    }

    return null;
  },

  async translateBatch(texts, src, tgt) {
    const results = await Promise.allSettled(texts.map((t) => this.translate(t, src, tgt)));
    return results.map((r) => (r.status === 'fulfilled' ? r.value : null));
  },
};

export const _internals = {
  _pairAvailability,
  _translatorInstances,
  _checkChromeTranslatorAvailability,
  _translateWithChrome,
};
