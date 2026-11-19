import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

let xhrInstances = [];
let mockXhrOpenSpy = null;

class MockResumeXHR {
  constructor() {
    this.headers = {};
    this.status = 200;
    this.responseText = '{}';
    xhrInstances.push(this);
  }
  open(method, url) {
    this.method = method;
    this.url = url;
    if (mockXhrOpenSpy) mockXhrOpenSpy(method, url);
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

async function loadMainWorldResume({ fetchSpy, beaconSpy } = {}) {
  let messageHandler = null;
  jest.resetModules();
  delete window.__yousubMainResumeReady;
  delete window.__yousubMainResumeHelpers;

  if (fetchSpy) global.window.fetch = fetchSpy;
  if (beaconSpy) {
    Object.defineProperty(navigator, 'sendBeacon', {
      value: beaconSpy,
      writable: true,
      configurable: true,
    });
  }

  const spy = jest.spyOn(window, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'message') messageHandler = fn;
  });
  await import('../../src/content/main-world-resume.js');
  spy.mockRestore();

  return {
    handler: messageHandler,
    helpers: window.__yousubMainResumeHelpers,
  };
}

describe('main-world-resume MAIN-world guard & bridge (Phase 83)', () => {
  const origXHR = global.XMLHttpRequest;
  const origFetch = global.window.fetch;
  const origSendBeacon = navigator.sendBeacon;
  let postSpy;

  beforeEach(() => {
    xhrInstances = [];
    mockXhrOpenSpy = jest.fn();
    global.XMLHttpRequest = MockResumeXHR;
    document.body.innerHTML = '';
    delete window.ytInitialPlayerResponse;
    delete window.ytcfg;
    postSpy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});
  });

  afterEach(() => {
    if (window.__yousubMainResumeHelpers?._restoreHooks) {
      window.__yousubMainResumeHelpers._restoreHooks();
    }
    jest.restoreAllMocks();
    delete window.__yousubMainResumeReady;
    delete window.__yousubMainResumeHelpers;
    global.XMLHttpRequest = origXHR;
    global.window.fetch = origFetch;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: origSendBeacon,
      writable: true,
      configurable: true,
    });
    delete window.ytInitialPlayerResponse;
    delete window.ytcfg;
  });

  describe('rewriteWatchtimeUrl pure helper', () => {
    test('leaves non-watchtime URLs untouched', async () => {
      const { helpers } = await loadMainWorldResume();
      const url = 'https://www.youtube.com/youtubei/v1/player?cmt=1.0';
      expect(
        helpers.rewriteWatchtimeUrl(url, {
          videoId: 'v1',
          protectedMinTimeSec: 3600,
          guardUntilMs: Date.now() + 10000,
        })
      ).toBe(url);
    });

    test('rewrites premature 0:00..5s cmt/st/et pings during active guard window', async () => {
      const { helpers } = await loadMainWorldResume();
      const onRewrite = jest.fn();
      const raw = 'https://s.youtube.com/api/stats/watchtime?docid=vid1&cmt=1.2&st=0.0&et=1.2';
      const rewritten = helpers.rewriteWatchtimeUrl(raw, {
        videoId: 'vid1',
        protectedMinTimeSec: 3600,
        guardUntilMs: 20000,
        nowMs: 5000,
        onRewrite,
      });

      const u = new URL(rewritten);
      expect(u.searchParams.get('cmt')).toBe('3600.0');
      expect(u.searchParams.get('st')).toBe('3600.0');
      expect(u.searchParams.get('et')).toBe('3600.0');
      expect(onRewrite).toHaveBeenCalledWith(
        'GUARD_REWRITE',
        expect.objectContaining({ videoId: 'vid1', originalCmt: 1.2, rewrittenCmt: '3600.0' })
      );
    });

    test('passes watchtime untouched after guard window expires or when docid mismatches', async () => {
      const { helpers } = await loadMainWorldResume();
      const raw = 'https://s.youtube.com/api/stats/watchtime?docid=vid1&cmt=1.5&st=0&et=1.5';

      // Guard expired
      expect(
        helpers.rewriteWatchtimeUrl(raw, {
          videoId: 'vid1',
          protectedMinTimeSec: 3600,
          guardUntilMs: 10000,
          nowMs: 12000,
        })
      ).toBe(raw);

      // Mismatched docid
      expect(
        helpers.rewriteWatchtimeUrl(raw, {
          videoId: 'otherVid',
          protectedMinTimeSec: 3600,
          guardUntilMs: 20000,
          nowMs: 5000,
        })
      ).toBe(raw);
    });

    test('clamps >= 95% completion pings on long videos (>= 600s) including CSV st/et intervals', async () => {
      const { helpers } = await loadMainWorldResume();
      const raw =
        'https://s.youtube.com/api/stats/watchtime?docid=long1&cmt=34500&st=100,34200&et=120,34500';
      const rewritten = helpers.rewriteWatchtimeUrl(raw, {
        videoId: 'long1',
        durationSec: 36000,
        preventCompletionReset: true,
      });

      const u = new URL(rewritten);
      expect(u.searchParams.get('cmt')).toBe('32400'); // 90% of 36000
      expect(u.searchParams.get('st')).toBe('100,32400');
      expect(u.searchParams.get('et')).toBe('120,32400');

      // Short <600s videos are NOT clamped
      const shortRaw = 'https://s.youtube.com/api/stats/watchtime?docid=s1&cmt=295';
      expect(
        helpers.rewriteWatchtimeUrl(shortRaw, {
          videoId: 's1',
          durationSec: 300,
          preventCompletionReset: true,
        })
      ).toBe(shortRaw);
    });
  });

  describe('buildActiveWatchtimePushUrl', () => {
    test('rewrites s.youtube.com to youtubeOrigin (m.youtube.com), sets cmt/st/et/len/state/final, and preserves cpn', async () => {
      const { helpers } = await loadMainWorldResume();
      const url = helpers.buildActiveWatchtimePushUrl(
        'https://s.youtube.com/api/stats/watchtime?ns=yt&el=detailpage&docid=audiobook1&ei=xyz',
        {
          videoId: 'audiobook1',
          currentTimeSec: 18420.4,
          durationSec: 36000,
          state: 'paused',
          cpn: 'CPN1234567890123',
          youtubeOrigin: 'https://m.youtube.com',
        }
      );

      const u = new URL(url);
      expect(u.origin).toBe('https://m.youtube.com');
      expect(u.searchParams.get('cmt')).toBe('18420.4');
      expect(u.searchParams.get('st')).toBe('18420.4');
      expect(u.searchParams.get('et')).toBe('18420.4');
      expect(u.searchParams.get('len')).toBe('36000');
      expect(u.searchParams.get('state')).toBe('paused');
      expect(u.searchParams.get('final')).toBe('1');
      expect(u.searchParams.get('cpn')).toBe('CPN1234567890123');
      expect(u.searchParams.get('ei')).toBe('xyz');
    });

    test('clamps active push when sleeping past 95% of a long video', async () => {
      const { helpers } = await loadMainWorldResume();
      const url = helpers.buildActiveWatchtimePushUrl(
        'https://s.youtube.com/api/stats/watchtime?docid=long2',
        {
          videoId: 'long2',
          currentTimeSec: 35000,
          durationSec: 36000,
          preventCompletionReset: true,
        }
      );
      const u = new URL(url);
      expect(u.searchParams.get('cmt')).toBe('32400.0');
    });
  });

  describe('postMessage bridge & network interception hooks', () => {
    test('YOUSUB_RESUME_PROBE_PLAYER reads active playerResponse and replies with YOUSUB_RESUME_PLAYER_DATA', async () => {
      const player = document.createElement('div');
      player.id = 'movie_player';
      player.getPlayerResponse = () => ({
        videoDetails: {
          videoId: 'vidProbe1',
          lengthSeconds: '14400',
          title: 'Epic Story',
          isLive: false,
        },
        playerConfig: { playbackStartConfig: { startSeconds: 5120 } },
        playbackTracking: {
          videostatsWatchtimeUrl: {
            baseUrl: 'https://s.youtube.com/api/stats/watchtime?docid=vidProbe1&ns=yt',
          },
        },
      });
      document.body.appendChild(player);

      const { handler } = await loadMainWorldResume();
      handler({
        source: window,
        data: { type: 'YOUSUB_RESUME_PROBE_PLAYER', videoId: 'vidProbe1', requestId: 'p1' },
      });
      await flushMicrotasks();

      const replies = postSpy.mock.calls
        .map((c) => c[0])
        .filter((m) => m && m.type === 'YOUSUB_RESUME_PLAYER_DATA');
      expect(replies).toEqual([
        {
          type: 'YOUSUB_RESUME_PLAYER_DATA',
          requestId: 'p1',
          videoId: 'vidProbe1',
          accountStartSec: 5120,
          watchtimeBaseUrl: 'https://s.youtube.com/api/stats/watchtime?docid=vidProbe1&ns=yt',
          durationSec: 14400,
          isLive: false,
          title: 'Epic Story',
        },
      ]);
    });

    test('YOUSUB_RESUME_PROBE_PLAYER falls back to Innertube /youtubei/v1/player when SPA playerResponse is stale', async () => {
      window.ytInitialPlayerResponse = { videoDetails: { videoId: 'oldVid' } };
      window.ytcfg = { get: (k) => (k === 'INNERTUBE_API_KEY' ? 'k123' : '2.2026') };

      const { handler } = await loadMainWorldResume();
      handler({
        source: window,
        data: { type: 'YOUSUB_RESUME_PROBE_PLAYER', videoId: 'spaNew1', requestId: 'p2' },
      });
      await flushMicrotasks();

      expect(xhrInstances).toHaveLength(1);
      expect(xhrInstances[0].url).toContain('/youtubei/v1/player?key=k123');
      xhrInstances[0].status = 200;
      xhrInstances[0].responseText = JSON.stringify({
        videoDetails: { videoId: 'spaNew1', lengthSeconds: '7200', title: 'SPA Audio' },
        playerConfig: { playbackStartConfig: { startSeconds: 1800 } },
        playbackTracking: {
          videostatsWatchtimeUrl: {
            baseUrl: 'https://s.youtube.com/api/stats/watchtime?docid=spaNew1',
          },
        },
      });
      xhrInstances[0].onload();
      await flushMicrotasks();

      const replies = postSpy.mock.calls
        .map((c) => c[0])
        .filter((m) => m && m.type === 'YOUSUB_RESUME_PLAYER_DATA');
      expect(replies).toHaveLength(1);
      expect(replies[0].accountStartSec).toBe(1800);
      expect(replies[0].durationSec).toBe(7200);
    });

    test('intercepts fetch, XHR, and sendBeacon watchtime pings under active guard and pushes with captured cpn', async () => {
      const fetchSpy = jest.fn(() => Promise.resolve({ ok: true, status: 204 }));
      const beaconSpy = jest.fn(() => true);

      const player = document.createElement('div');
      player.id = 'movie_player';
      player.getPlayerResponse = () => ({
        videoDetails: { videoId: 'hookVid1', lengthSeconds: '10000' },
        playbackTracking: {
          videostatsWatchtimeUrl: {
            baseUrl: 'https://s.youtube.com/api/stats/watchtime?docid=hookVid1',
          },
        },
      });
      document.body.appendChild(player);

      const { handler } = await loadMainWorldResume({ fetchSpy, beaconSpy });
      handler({
        source: window,
        data: { type: 'YOUSUB_RESUME_PROBE_PLAYER', videoId: 'hookVid1', requestId: 'p3' },
      });
      await flushMicrotasks();

      handler({
        source: window,
        data: {
          type: 'YOUSUB_RESUME_SET_GUARD',
          videoId: 'hookVid1',
          protectedMinTimeSec: 2400,
          guardDurationMs: 15000,
          durationSec: 10000,
          preventCompletionReset: true,
        },
      });

      // 1. Outgoing fetch at cmt=1.0 -> rewritten to 2400.0 & captures cpn!
      await window.fetch(
        'https://s.youtube.com/api/stats/watchtime?docid=hookVid1&cmt=1.0&st=0&et=1.0&cpn=LIVE_CPN_99'
      );
      expect(fetchSpy.mock.calls[0][0]).toContain('cmt=2400.0');

      // 2. Outgoing XHR.open -> rewritten
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://s.youtube.com/api/stats/watchtime?docid=hookVid1&cmt=2.0');
      expect(mockXhrOpenSpy.mock.calls[0][1]).toContain('cmt=2400.0');

      // 3. Outgoing sendBeacon -> rewritten
      navigator.sendBeacon('https://s.youtube.com/api/stats/watchtime?docid=hookVid1&cmt=3.0');
      expect(beaconSpy.mock.calls[0][0]).toContain('cmt=2400.0');

      // 4. Active YOUSUB_RESUME_PUSH_WATCHTIME uses captured LIVE_CPN_99 & unhooked fetch
      handler({
        source: window,
        data: {
          type: 'YOUSUB_RESUME_PUSH_WATCHTIME',
          videoId: 'hookVid1',
          currentTimeSec: 3000,
          durationSec: 10000,
          state: 'paused',
        },
      });
      await flushMicrotasks();

      const lastFetchCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      expect(lastFetchCall[0]).toContain('cpn=LIVE_CPN_99');
      expect(lastFetchCall[0]).toContain('cmt=3000.0');
      expect(lastFetchCall[0]).toContain('state=paused');
      expect(lastFetchCall[1]).toMatchObject({ credentials: 'include', keepalive: true });
    });

    test('guards against duplicate listener registration on re-import', async () => {
      await loadMainWorldResume();
      expect(window.__yousubMainResumeReady).toBe(true);
      const addSpy = jest.spyOn(window, 'addEventListener');
      jest.resetModules();
      await import('../../src/content/main-world-resume.js');
      expect(addSpy).not.toHaveBeenCalled();
    });
  });
});
