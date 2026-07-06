/**
 * rough-translate-bridge.js — Content-script bridge to the MAIN-world on-device
 * Translator (main-world-translator.js).
 *
 * The background service worker cannot run Chrome's Translator API (it is
 * unavailable in workers), so MergeFixer's rough back-translation is delegated
 * to the page main world. This module injects the main-world translator on
 * demand and exposes translateBatch(), which MIRRORS the contract of
 * RoughTranslator.translateBatch: it resolves to Array<string|null> of length
 * === texts.length and NEVER rejects.
 */
import { devLog } from '../shared/constants.js';

let injected = false;
const pendingRequests = {}; // requestId → { resolve }
let idCounter = 0;

// Kept BELOW the service-worker delegate's timeout (~3000ms) so the bridge
// always returns a (possibly all-null) response before the SW gives up.
const REQUEST_TIMEOUT_MS = 2500;

function handleResponse(event) {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== 'YOUSUB_ROUGH_TRANSLATE_RESPONSE') return;

  const pending = pendingRequests[event.data.requestId];
  if (!pending) return;
  delete pendingRequests[event.data.requestId];
  pending.resolve(event.data.translations);
}

function ensureInjected() {
  if (injected) return;
  injected = true;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/content/main-world-translator.js');
  script.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  window.addEventListener('message', handleResponse);
  devLog('[YouSub] RoughTranslateBridge: Main-world translator injected.');
}

export const RoughTranslateBridge = {
  /**
   * Translate a batch of source lines via the on-device Translator in the page
   * main world. NEVER rejects; always resolves to Array<string|null> of length
   * === texts.length (null per item on any failure / unavailability).
   */
  translateBatch(texts, src, tgt) {
    const list = Array.isArray(texts) ? texts : [];
    if (list.length === 0) return Promise.resolve([]);

    ensureInjected();

    return new Promise((resolve) => {
      const requestId = 'yousub_rt_' + ++idCounter;
      const allNull = () => list.map(() => null);

      const timer = setTimeout(() => {
        if (pendingRequests[requestId]) {
          delete pendingRequests[requestId];
          resolve(allNull());
        }
      }, REQUEST_TIMEOUT_MS);

      pendingRequests[requestId] = {
        resolve: (translations) => {
          clearTimeout(timer);
          resolve(
            Array.isArray(translations) && translations.length === list.length
              ? translations
              : allNull()
          );
        },
      };

      // Defer the post so the main-world listener is registered first (mirrors
      // subtitle-parser.js's fetch bridge).
      setTimeout(() => {
        window.postMessage(
          { type: 'YOUSUB_ROUGH_TRANSLATE_REQUEST', requestId, texts: list, src, tgt },
          '*'
        );
      }, 50);
    });
  },
};

// Compatibility for legacy global access (mirrors other content modules).
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.RoughTranslateBridge = RoughTranslateBridge;
}
