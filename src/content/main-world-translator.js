/**
 * main-world-translator.js — Runs in the MAIN world (YouTube page context)
 *
 * Uses Chrome's built-in on-device Translator API (the stable top-level
 * `Translator` global, Chrome 138+), which is available only in a document /
 * main-world context — NOT in the extension service worker. This script is the
 * page-side worker for MergeFixer's rough back-translation: it receives a batch
 * of source lines, translates each on-device, and returns them for word-count
 * verification of suspected line-merges. It performs NO network request.
 *
 * Unlike main-world-fetcher.js this script registers NO Trusted Types policy —
 * it has no HTML/script-URL sink (it only reads text and posts messages back).
 *
 * Protocol:
 *   in : { type:'YOUSUB_ROUGH_TRANSLATE_REQUEST', requestId, texts[], src, tgt }
 *   out: { type:'YOUSUB_ROUGH_TRANSLATE_RESPONSE', requestId, translations[] }
 *        translations.length === texts.length ALWAYS (each item: string | null).
 */
(function () {
  'use strict';

  try {
    // Guard against double-injection (the content bridge injects on demand).
    if (window.__yousubRoughTranslatorReady) return;
    window.__yousubRoughTranslatorReady = true;

    var _isProd = window.YouSub && window.YouSub.Constants && window.YouSub.Constants.IS_PRODUCTION;
    function _devLog() {
      if (!_isProd) console.log.apply(console, arguments);
    }

    // key `${src}->${tgt}` → Promise<translator instance> (cache the create()
    // promise, not just the resolved instance, for concurrency safety).
    var _instances = {};

    function _pairKey(src, tgt) {
      return src + '->' + tgt;
    }

    function _getTranslator(src, tgt) {
      var key = _pairKey(src, tgt);
      if (!_instances[key]) {
        _instances[key] = Translator.create({ sourceLanguage: src, targetLanguage: tgt });
      }
      return _instances[key];
    }

    function _allNull(texts) {
      return texts.map(function () {
        return null;
      });
    }

    async function _translateAll(texts, src, tgt) {
      // No Translator API on this page → all null.
      if (typeof Translator === 'undefined') return _allNull(texts);

      var status;
      try {
        status = await Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
      } catch {
        status = 'unavailable';
      }
      // Only translate when the model is already resident (opportunistic).
      // Never trigger/await a model download in-path — that can require user
      // activation and would stall merge-fixing.
      if (status !== 'available') return _allNull(texts);

      var translator;
      try {
        translator = await _getTranslator(src, tgt);
      } catch {
        delete _instances[_pairKey(src, tgt)]; // allow a retry later
        return _allNull(texts);
      }

      var settled = await Promise.allSettled(
        texts.map(function (t) {
          if (!t || !t.trim()) return Promise.resolve(null);
          return translator.translate(t);
        })
      );
      return settled.map(function (r) {
        return r.status === 'fulfilled' && r.value ? r.value : null;
      });
    }

    window.addEventListener('message', function (event) {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'YOUSUB_ROUGH_TRANSLATE_REQUEST') return;

      var requestId = event.data.requestId;
      var texts = Array.isArray(event.data.texts) ? event.data.texts : [];
      var src = event.data.src;
      var tgt = event.data.tgt;

      function respond(translations) {
        window.postMessage(
          {
            type: 'YOUSUB_ROUGH_TRANSLATE_RESPONSE',
            requestId: requestId,
            translations: translations,
          },
          '*'
        );
      }

      // 'auto' is not a valid on-device source language → all null.
      if (!src || src === 'auto' || !tgt) {
        respond(_allNull(texts));
        return;
      }

      _translateAll(texts, src, tgt)
        .then(respond)
        .catch(function () {
          respond(_allNull(texts));
        });
    });

    _devLog('[YouSub] MainWorldTranslator: Ready (on-device Translator).');
  } catch (e) {
    console.error('[YouSub] MainWorldTranslator Critical Crash:', e);
  }
})();
