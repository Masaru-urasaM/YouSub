/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://m.youtube.com/watch?v=mobSilent1"}
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

let xhrInstances = [];
class MockMobileXHR {
  constructor() {
    this.headers = {};
    this.status = 200;
    this.responseText = '{}';
    xhrInstances.push(this);
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k, v) {
    this.headers[k] = v;
  }
  send(body) {
    this.sentBody = body;
  }
  abort() {}
}

const flushMicrotasks = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

async function loadMobileExtractor() {
  let captured;
  jest.resetModules();
  delete window.__yousubMainExtractorReady;
  const spy = jest.spyOn(window, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'message') captured = fn;
  });
  await import('../../src/content/main-world-extractor.js');
  spy.mockRestore();
  return captured;
}

describe('Mobile YouTube (m.youtube.com) compatibility (Phase 81)', () => {
  const origXHR = global.XMLHttpRequest;
  let postSpy;

  beforeEach(() => {
    xhrInstances = [];
    delete window.__yousubMainExtractorReady;
    global.XMLHttpRequest = MockMobileXHR;
    document.body.innerHTML = '';
    delete window.ytInitialPlayerResponse;
    delete window.ytcfg;
    postSpy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete window.__yousubMainExtractorReady;
    global.XMLHttpRequest = origXHR;
    delete window.ytInitialPlayerResponse;
    delete window.ytcfg;
  });

  test('postInnertubeJson uses https://m.youtube.com same-origin URLs and reads #player-container-id metadata', async () => {
    expect(window.location.origin).toBe('https://m.youtube.com');

    const mobilePlayer = document.createElement('div');
    mobilePlayer.id = 'player-container-id';
    mobilePlayer.getPlayerResponse = () => ({
      videoDetails: { videoId: 'mobSilent1' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: 'en', baseUrl: 'https://m.youtube.com/api/timedtext' }],
        },
      },
    });
    document.body.appendChild(mobilePlayer);

    const handler = await loadMobileExtractor();
    handler({
      source: window,
      data: { type: 'YOUSUB_EXTRACT_CAPTIONS', requestId: 'req-mob-1' },
    });
    await flushMicrotasks();

    expect(xhrInstances.length).toBeGreaterThanOrEqual(1);
    expect(xhrInstances[0].url.startsWith('https://m.youtube.com/youtubei/v1/get_panel')).toBe(
      true
    );

    xhrInstances[0].status = 200;
    xhrInstances[0].responseText = JSON.stringify({
      content: {
        items: [{ transcriptSegmentViewModel: { timestamp: '0:03', simpleText: 'Mobile line' } }],
      },
    });
    xhrInstances[0].onload();
    await flushMicrotasks();

    const results = postSpy.mock.calls
      .map((c) => c[0])
      .filter((m) => m && m.type === 'YOUSUB_CAPTION_TRACKS');
    expect(results).toHaveLength(1);
    expect(results[0].requestId).toBe('req-mob-1');
    expect(results[0].parsedEntries).toEqual([{ startMs: 3000, endMs: 8000, text: 'Mobile line' }]);
  });
});
