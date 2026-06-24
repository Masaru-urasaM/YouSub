import { Logger } from '../shared/logger.js';

const GT_TIMEOUT_MS = 5000;
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

async function _translateWithGoogle(text, src, tgt) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(src)}&tl=${encodeURIComponent(tgt)}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(GT_TIMEOUT_MS) });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.[0]?.[0]?.[0] || null;
  } catch (err) {
    Logger.debug('RoughTranslator', `Google Translate failed: ${err.message}`);
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

    const googleResult = await _translateWithGoogle(text, src, tgt);
    if (googleResult) return googleResult;

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
  _translateWithGoogle,
};
