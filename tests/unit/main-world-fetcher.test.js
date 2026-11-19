import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for src/content/main-world-fetcher.js (TODO T11).
 * Captures the IIFE's window 'message' listener to avoid listener accumulation across tests.
 */

let lastXhr = null;
class MockXHR {
  constructor() {
    this.headers = {};
    this.aborted = false;
    this.withCredentials = false;
    this.timeout = 0;
    this.status = 0;
    this.statusText = '';
    this.responseText = '';
    lastXhr = this;
  }
  open(method, url, async) {
    this.method = method;
    this.url = url;
    this.async = async;
  }
  setRequestHeader(k, v) {
    this.headers[k] = v;
  }
  send() {}
  abort() {
    this.aborted = true;
  }
}

async function loadFetcher() {
  let captured;
  jest.resetModules();
  const spy = jest.spyOn(window, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'message') captured = fn;
  });
  await import('../../src/content/main-world-fetcher.js');
  spy.mockRestore();
  return captured;
}

describe('main-world-fetcher IIFE (T11)', () => {
  const origXHR = global.XMLHttpRequest;
  let postSpy;

  beforeEach(() => {
    lastXhr = null;
    delete window.__yousubMainFetcherReady;
    global.XMLHttpRequest = MockXHR;
    postSpy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete window.__yousubMainFetcherReady;
    global.XMLHttpRequest = origXHR;
  });

  function postedResponses() {
    return postSpy.mock.calls
      .map((c) => c[0])
      .filter((m) => m && m.type === 'YOUSUB_FETCH_RESPONSE');
  }

  test('ignores unrelated or foreign-source messages', async () => {
    const handler = await loadFetcher();
    handler({
      source: {},
      data: { type: 'YOUSUB_FETCH_REQUEST', requestId: '1', url: 'https://x' },
    });
    handler({ source: window, data: { type: 'OTHER' } });
    expect(lastXhr).toBeNull();
    expect(postedResponses()).toHaveLength(0);
  });

  test('fetches URL via XHR with YouTube headers and posts success on HTTP 200', async () => {
    const handler = await loadFetcher();
    handler({
      source: window,
      data: {
        type: 'YOUSUB_FETCH_REQUEST',
        requestId: 'req-1',
        url: 'https://youtube.com/api/timedtext?v=1',
      },
    });

    expect(lastXhr.method).toBe('GET');
    expect(lastXhr.withCredentials).toBe(true);
    expect(lastXhr.headers['X-YouTube-Client-Name']).toBe('1');

    lastXhr.status = 200;
    lastXhr.responseText = '{"events":[]}';
    lastXhr.onload();
    // Duplicate onload must be ignored by responded guard
    lastXhr.onload();

    expect(postedResponses()).toEqual([
      {
        type: 'YOUSUB_FETCH_RESPONSE',
        requestId: 'req-1',
        success: true,
        text: '{"events":[]}',
      },
    ]);
  });

  test('posts failure on non-2xx status, network error, timeout, and 20s safety timeout', async () => {
    jest.useFakeTimers();
    const handler = await loadFetcher();

    // Non-2xx
    handler({
      source: window,
      data: { type: 'YOUSUB_FETCH_REQUEST', requestId: 'r-404', url: 'https://youtube.com/a' },
    });
    lastXhr.status = 404;
    lastXhr.statusText = 'Not Found';
    lastXhr.onload();
    jest.advanceTimersByTime(21000); // safety timer must no-op after onload

    // Network error
    handler({
      source: window,
      data: { type: 'YOUSUB_FETCH_REQUEST', requestId: 'r-net', url: 'https://youtube.com/b' },
    });
    lastXhr.onerror();

    // XHR ontimeout
    handler({
      source: window,
      data: { type: 'YOUSUB_FETCH_REQUEST', requestId: 'r-to', url: 'https://youtube.com/c' },
    });
    lastXhr.ontimeout();

    // Safety timeout 20s
    handler({
      source: window,
      data: { type: 'YOUSUB_FETCH_REQUEST', requestId: 'r-safe', url: 'https://youtube.com/d' },
    });
    jest.advanceTimersByTime(20000);
    expect(lastXhr.aborted).toBe(true);

    expect(postedResponses()).toEqual([
      {
        type: 'YOUSUB_FETCH_RESPONSE',
        requestId: 'r-404',
        success: false,
        error: 'HTTP 404 Not Found',
      },
      { type: 'YOUSUB_FETCH_RESPONSE', requestId: 'r-net', success: false, error: 'Network error' },
      {
        type: 'YOUSUB_FETCH_RESPONSE',
        requestId: 'r-to',
        success: false,
        error: 'Request timed out',
      },
      {
        type: 'YOUSUB_FETCH_RESPONSE',
        requestId: 'r-safe',
        success: false,
        error: 'Safety timeout (20s)',
      },
    ]);
  });

  test('guards against duplicate listener registration on repeated execution', async () => {
    await loadFetcher();
    expect(window.__yousubMainFetcherReady).toBe(true);
    const spy = jest.spyOn(window, 'addEventListener');
    jest.resetModules();
    await import('../../src/content/main-world-fetcher.js');
    expect(spy).not.toHaveBeenCalled();
  });
});
