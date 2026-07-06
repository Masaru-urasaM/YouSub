import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for src/content/main-world-translator.js — the MAIN-world IIFE that
 * runs the on-device Chrome `Translator` for MergeFixer's rough back-translation.
 *
 * The file is a bare IIFE (no exports) that, on load, registers a single window
 * 'message' listener and drives the top-level `Translator` global. To exercise it
 * in jsdom WITHOUT leaking listeners across tests we:
 *   - re-import a fresh copy per test via jest.resetModules(), and
 *   - mock window.addEventListener to CAPTURE the handler (it is never actually
 *     attached, so there is zero listener accumulation between tests).
 * `Translator` is referenced bare, so it resolves to the global — we stub
 * `global.Translator` (jsdom: global === window) and delete it in afterEach so a
 * leaked stub can't silently change a sibling test.
 *
 * Contract under test: the response is ALWAYS
 *   { type:'YOUSUB_ROUGH_TRANSLATE_RESPONSE', requestId, translations }
 * with translations.length === texts.length and each item string | null. The
 * on-device model is used opportunistically — only when availability==='available'
 * (never triggering an in-path model download) and never for src==='auto'.
 */

const REQ = 'YOUSUB_ROUGH_TRANSLATE_REQUEST';
const RES = 'YOUSUB_ROUGH_TRANSLATE_RESPONSE';

// Load a fresh IIFE and return the 'message' handler it registers (or undefined
// if the double-injection guard short-circuited before registration).
async function loadIIFE() {
  let captured;
  jest.resetModules();
  const spy = jest.spyOn(window, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'message') captured = handler;
  });
  await import('../../src/content/main-world-translator.js');
  spy.mockRestore();
  return captured;
}

// Build a same-window message event object (the handler reads .source and .data).
function reqEvent({ requestId = 'r1', texts = [], src = 'en', tgt = 'vi' }, source = window) {
  return { source, data: { type: REQ, requestId, texts, src, tgt } };
}

// Configurable on-device Translator stub. `translate` may resolve/reject per text.
function stubTranslator({ availability = 'available', translate, createRejects = false } = {}) {
  const translateSpy = translate || jest.fn(async (t) => 'T:' + t);
  const createSpy = jest.fn(async () => {
    if (createRejects) throw new Error('create failed');
    return { translate: translateSpy };
  });
  const availabilitySpy = jest.fn(async () => availability);
  global.Translator = { availability: availabilitySpy, create: createSpy };
  return { availabilitySpy, createSpy, translateSpy };
}

// One macro-task boundary drains the handler's pending microtask chain
// (availability -> create -> allSettled(translate) -> map -> respond).
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function invoke(handler, event) {
  handler(event);
  await settle();
}

function responses(postSpy) {
  return postSpy.mock.calls.map((c) => c[0]).filter((m) => m && m.type === RES);
}

let postSpy;

beforeEach(() => {
  delete window.__yousubRoughTranslatorReady;
  postSpy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete global.Translator;
  delete window.__yousubRoughTranslatorReady;
});

describe('main-world-translator IIFE — gating', () => {
  test('src === "auto" responds all-null WITHOUT touching the Translator API', async () => {
    const { availabilitySpy, createSpy } = stubTranslator();
    const handler = await loadIIFE();

    await invoke(handler, reqEvent({ requestId: 'a', texts: ['x', 'y'], src: 'auto', tgt: 'vi' }));

    const res = responses(postSpy);
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual({ type: RES, requestId: 'a', translations: [null, null] });
    expect(availabilitySpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('missing src or tgt responds all-null without calling the API', async () => {
    const { availabilitySpy } = stubTranslator();
    const handler = await loadIIFE();

    await invoke(handler, reqEvent({ requestId: 'b', texts: ['x'], src: '', tgt: 'vi' }));
    await invoke(handler, reqEvent({ requestId: 'c', texts: ['x'], src: 'en', tgt: '' }));

    const res = responses(postSpy);
    expect(res.map((r) => r.translations)).toEqual([[null], [null]]);
    expect(availabilitySpy).not.toHaveBeenCalled();
  });

  test('availability !== "available" responds all-null and never calls create (no in-path download)', async () => {
    const { availabilitySpy, createSpy } = stubTranslator({ availability: 'downloadable' });
    const handler = await loadIIFE();

    await invoke(handler, reqEvent({ requestId: 'd', texts: ['a', 'b'], src: 'en', tgt: 'vi' }));

    const res = responses(postSpy);
    expect(res[0].translations).toEqual([null, null]);
    expect(availabilitySpy).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('no Translator global at all responds all-null (length preserved)', async () => {
    // No stubTranslator() → `typeof Translator === 'undefined'` branch.
    delete global.Translator;
    const handler = await loadIIFE();

    await invoke(
      handler,
      reqEvent({ requestId: 'e', texts: ['a', 'b', 'c'], src: 'en', tgt: 'vi' })
    );

    const res = responses(postSpy);
    expect(res[0].translations).toEqual([null, null, null]);
  });
});

describe('main-world-translator IIFE — translation & null-mapping', () => {
  test('happy path returns translations in order and caches create() once per pair', async () => {
    const { createSpy } = stubTranslator({ translate: jest.fn(async (t) => 'T:' + t) });
    const handler = await loadIIFE();

    await invoke(handler, reqEvent({ requestId: 'h1', texts: ['a', 'b'], src: 'en', tgt: 'vi' }));
    await invoke(handler, reqEvent({ requestId: 'h2', texts: ['c'], src: 'en', tgt: 'vi' }));

    const res = responses(postSpy);
    expect(res[0].translations).toEqual(['T:a', 'T:b']);
    expect(res[1].translations).toEqual(['T:c']);
    // The create() PROMISE is cached per `${src}->${tgt}` → one create for two requests.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  test('a rejected per-item translate() becomes null while length === texts.length', async () => {
    const translate = jest.fn(async (t) => {
      if (t === 'bad') throw new Error('cannot translate');
      return 'T:' + t;
    });
    stubTranslator({ translate });
    const handler = await loadIIFE();

    await invoke(
      handler,
      reqEvent({ requestId: 'm', texts: ['a', 'bad', 'c'], src: 'en', tgt: 'vi' })
    );

    const res = responses(postSpy);
    expect(res[0].translations).toEqual(['T:a', null, 'T:c']);
  });

  test('empty / whitespace texts map to null without calling translate', async () => {
    const translate = jest.fn(async (t) => 'T:' + t);
    stubTranslator({ translate });
    const handler = await loadIIFE();

    await invoke(
      handler,
      reqEvent({ requestId: 'w', texts: ['', '   ', 'x'], src: 'en', tgt: 'vi' })
    );

    const res = responses(postSpy);
    expect(res[0].translations).toEqual([null, null, 'T:x']);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith('x');
  });

  test('a rejected create() responds all-null (and clears the cache for a later retry)', async () => {
    stubTranslator({ createRejects: true });
    const handler = await loadIIFE();

    await invoke(handler, reqEvent({ requestId: 'cr', texts: ['a', 'b'], src: 'en', tgt: 'vi' }));

    const res = responses(postSpy);
    expect(res[0].translations).toEqual([null, null]);
  });
});

describe('main-world-translator IIFE — message hygiene', () => {
  test('ignores messages whose source is not this window (no response posted)', async () => {
    stubTranslator();
    const handler = await loadIIFE();

    await invoke(
      handler,
      reqEvent({ requestId: 'x', texts: ['a'], src: 'en', tgt: 'vi' }, /* source */ {})
    );

    expect(responses(postSpy)).toHaveLength(0);
  });

  test('ignores messages of the wrong type (no response posted)', async () => {
    stubTranslator();
    const handler = await loadIIFE();

    await invoke(handler, { source: window, data: { type: 'SOMETHING_ELSE', texts: ['a'] } });

    expect(responses(postSpy)).toHaveLength(0);
  });

  test('double injection registers the message listener only once', async () => {
    stubTranslator();
    const first = await loadIIFE(); // sets window.__yousubRoughTranslatorReady = true
    const second = await loadIIFE(); // guard short-circuits before addEventListener

    expect(typeof first).toBe('function');
    expect(second).toBeUndefined();
  });
});
