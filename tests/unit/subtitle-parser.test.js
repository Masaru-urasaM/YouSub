import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { SubtitleParser } from '../../src/content/subtitle-parser.js';

/**
 * SubtitleParser is a clean ESM module: importing it runs the compatibility
 * shim (window.YouSub.SubtitleParser) as a side-effect and exposes the parser
 * directly. parseJson3/parseXml are pure functions that only rely on jsdom's
 * built-in DOMParser, so no module mocking is required.
 *
 * (Phase 68: replaced the old eval(scriptContent) loader, which threw
 * "Cannot use import statement outside a module" on this ESM file.)
 */
describe('SubtitleParser Module', () => {
  test('should parse JSON3 correctly', () => {
    const mockData = {
      events: [
        { tStartMs: 100, dDurationMs: 500, segs: [{ utf8: 'Hello' }] },
        { tStartMs: 700, dDurationMs: 300, segs: [{ utf8: 'World' }] },
      ],
    };

    const result = SubtitleParser.parseJson3(mockData);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ startMs: 100, endMs: 600, text: 'Hello' });
    expect(result[1]).toEqual({ startMs: 700, endMs: 1000, text: 'World' });
  });

  test('should handle JSON3 with multiple segments', () => {
    const mockData = {
      events: [
        {
          tStartMs: 0,
          dDurationMs: 1000,
          segs: [{ utf8: 'Hello ' }, { utf8: 'there!' }],
        },
      ],
    };

    const result = SubtitleParser.parseJson3(mockData);
    expect(result[0].text).toBe('Hello there!');
  });

  test('should parse XML correctly', () => {
    const xmlText = `
      <timedtext>
        <body>
          <text start="1.5" dur="2.5">XML Hello</text>
          <text start="5.0" dur="1.0">XML World</text>
        </body>
      </timedtext>
    `;

    const result = SubtitleParser.parseXml(xmlText);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ startMs: 1500, endMs: 4000, text: 'XML Hello' });
    expect(result[1]).toEqual({ startMs: 5000, endMs: 6000, text: 'XML World' });
  });

  test('should decode HTML entities in XML', () => {
    const xmlText = `
      <timedtext>
        <body>
          <text start="0" dur="1">&lt;b&gt;Encoded &amp; Text&lt;/b&gt;</text>
        </body>
      </timedtext>
    `;

    const result = SubtitleParser.parseXml(xmlText);
    // decodeHtml() parses the decoded markup as HTML and returns textContent,
    // so inline formatting tags (<b>) are stripped while entities are decoded.
    expect(result[0].text).toBe('Encoded & Text');
  });

  test('should sort tracks by start time', () => {
    const mockData = {
      events: [
        { tStartMs: 500, dDurationMs: 100, segs: [{ utf8: 'Late' }] },
        { tStartMs: 100, dDurationMs: 100, segs: [{ utf8: 'Early' }] },
      ],
    };

    const result = SubtitleParser.parseJson3(mockData);
    expect(result[0].text).toBe('Early');
    expect(result[1].text).toBe('Late');
  });

  test('should return empty array on invalid input', () => {
    expect(SubtitleParser.parseJson3(null)).toEqual([]);
    expect(SubtitleParser.parseXml('invalid xml')).toEqual([]);
  });

  test('parseXml skips empty text or zero duration entries and recovers if DOMParser throws', () => {
    const xmlText = `
      <timedtext><body>
        <text start="1.0" dur="0">Zero dur</text>
        <text start="2.0" dur="1.5">   </text>
        <text start="3.0" dur="2.0">Line\nOne</text>
      </body></timedtext>`;
    expect(SubtitleParser.parseXml(xmlText)).toEqual([
      { startMs: 3000, endMs: 5000, text: 'Line One' },
    ]);

    const origDOMParser = global.DOMParser;
    global.DOMParser = jest.fn(() => {
      throw new Error('DOMParser broken');
    });
    expect(SubtitleParser.parseXml('<timedtext></timedtext>')).toEqual([]);
    global.DOMParser = origDOMParser;
  });

  describe('SubtitleParser.fetch() pipeline & fallbacks', () => {
    let postSpy;

    beforeEach(() => {
      jest.clearAllMocks();
      chrome.runtime.lastError = null;
    });

    afterEach(() => {
      if (postSpy) {
        postSpy.mockRestore();
        postSpy = null;
      }
      jest.useRealTimers();
    });

    test('resolves via main-world JSON3 postMessage without injecting DOM <script> tags', async () => {
      postSpy = jest.spyOn(window, 'postMessage').mockImplementation((data) => {
        if (data && data.type === 'YOUSUB_FETCH_REQUEST') {
          window.dispatchEvent(
            new MessageEvent('message', {
              source: window,
              data: {
                type: 'YOUSUB_FETCH_RESPONSE',
                requestId: data.requestId,
                success: true,
                text: JSON.stringify({
                  events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }],
                }),
              },
            })
          );
        }
      });

      const entries = await SubtitleParser.fetch('https://youtube.com/api/timedtext?v=1');
      expect(document.querySelector('script[src*="main-world-fetcher.js"]')).toBeNull();
      expect(chrome.runtime.getURL).not.toHaveBeenCalled();
      expect(entries).toEqual([{ startMs: 0, endMs: 1000, text: 'Hi' }]);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('registers message listener only once across multiple fetch calls', async () => {
      jest.resetModules();
      const addSpy = jest.spyOn(window, 'addEventListener');
      const { SubtitleParser: FreshParser } = await import('../../src/content/subtitle-parser.js');
      postSpy = jest.spyOn(window, 'postMessage').mockImplementation((data) => {
        if (data && data.type === 'YOUSUB_FETCH_REQUEST') {
          window.dispatchEvent(
            new MessageEvent('message', {
              source: window,
              data: {
                type: 'YOUSUB_FETCH_RESPONSE',
                requestId: data.requestId,
                success: true,
                text: JSON.stringify({
                  events: [{ tStartMs: 0, dDurationMs: 500, segs: [{ utf8: 'Ok' }] }],
                }),
              },
            })
          );
        }
      });

      expect(await FreshParser.fetch('https://youtube.com/api/timedtext?v=a')).toEqual([
        { startMs: 0, endMs: 500, text: 'Ok' },
      ]);
      expect(await FreshParser.fetch('https://youtube.com/api/timedtext?v=b')).toEqual([
        { startMs: 0, endMs: 500, text: 'Ok' },
      ]);
      expect(addSpy.mock.calls.filter((c) => c[0] === 'message')).toHaveLength(1);
      addSpy.mockRestore();
    });

    test('falls back from JSON3 failure to main-world XML', async () => {
      postSpy = jest.spyOn(window, 'postMessage').mockImplementation((data) => {
        if (!data || data.type !== 'YOUSUB_FETCH_REQUEST') return;
        const isJson3 = data.url.includes('&fmt=json3');
        window.dispatchEvent(
          new MessageEvent('message', {
            source: window,
            data: isJson3
              ? {
                  type: 'YOUSUB_FETCH_RESPONSE',
                  requestId: data.requestId,
                  success: true,
                  text: 'not-json',
                }
              : {
                  type: 'YOUSUB_FETCH_RESPONSE',
                  requestId: data.requestId,
                  success: true,
                  text: '<timedtext><body><text start="1" dur="2">From XML</text></body></timedtext>',
                },
          })
        );
      });

      const entries = await SubtitleParser.fetch('https://youtube.com/api/timedtext?v=2');
      expect(entries).toEqual([{ startMs: 1000, endMs: 3000, text: 'From XML' }]);
    });

    test('falls back to background YOUSUB_FETCH_TEXT when main-world JSON3 & XML fail', async () => {
      postSpy = jest.spyOn(window, 'postMessage').mockImplementation((data) => {
        if (!data || data.type !== 'YOUSUB_FETCH_REQUEST') return;
        window.dispatchEvent(
          new MessageEvent('message', {
            source: window,
            data: {
              type: 'YOUSUB_FETCH_RESPONSE',
              requestId: data.requestId,
              success: false,
              error: 'blocked',
            },
          })
        );
      });

      chrome.runtime.sendMessage.mockImplementation((_msg, cb) => {
        cb({
          success: true,
          text: JSON.stringify({
            events: [{ tStartMs: 500, dDurationMs: 500, segs: [{ utf8: 'From BG' }] }],
          }),
        });
      });

      const entries = await SubtitleParser.fetch('https://youtube.com/api/timedtext?v=3');
      expect(entries).toEqual([{ startMs: 500, endMs: 1000, text: 'From BG' }]);
    });

    test('returns [] when main-world times out and background returns lastError or invalid JSON', async () => {
      jest.useFakeTimers();
      postSpy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});
      chrome.runtime.lastError = { message: 'bg disconnected' };
      chrome.runtime.sendMessage.mockImplementation((_msg, cb) => cb(null));

      const promise = SubtitleParser.fetch('https://youtube.com/api/timedtext?v=4');
      // Two 10s main-world timeouts (JSON3 + XML) + 50ms post delays
      await jest.advanceTimersByTimeAsync(21000);
      const entries = await promise;
      expect(entries).toEqual([]);

      // Also exercise background invalid JSON catch branch
      chrome.runtime.lastError = null;
      chrome.runtime.sendMessage.mockImplementation((_msg, cb) =>
        cb({ success: true, text: '{bad-json' })
      );
      const p2 = SubtitleParser.fetch('https://youtube.com/api/timedtext?v=5');
      await jest.advanceTimersByTimeAsync(21000);
      expect(await p2).toEqual([]);
    });
  });

  describe('SRT and WebVTT parsing (Phase 78)', () => {
    test('parseTimestampMs handles SRT comma, VTT short MM:SS, and rejects invalid times', () => {
      expect(SubtitleParser.parseTimestampMs('00:01:02,5')).toBe(62500);
      expect(SubtitleParser.parseTimestampMs('01:23.456')).toBe(83456);
      expect(SubtitleParser.parseTimestampMs('01:00:00.000')).toBe(3600000);
      expect(SubtitleParser.parseTimestampMs('00:65:00,000')).toBeNaN();
      expect(SubtitleParser.parseTimestampMs('invalid')).toBeNaN();
    });

    test('parseSrt parses BOM, CRLF, multi-line cues, tags, while preserving math expressions', () => {
      const srt =
        '\uFEFF1\r\n' +
        '00:00:01,000 --> 00:00:03,500\r\n' +
        '<i>Hello</i> &amp; welcome\r\n' +
        '{\\an8}Next line\r\n\r\n' +
        '2\r\n' +
        '00:00:04,000 --> 00:00:06,000 align:start\r\n' +
        '2 < 5 and 9 > 3\r\n';

      const entries = SubtitleParser.parseSrt(srt);
      expect(entries).toEqual([
        { startMs: 1000, endMs: 3500, text: 'Hello & welcome Next line' },
        { startMs: 4000, endMs: 6000, text: '2 < 5 and 9 > 3' },
      ]);
    });

    test('parseVtt ignores headers, NOTE/STYLE blocks, voice tags, and parses cues', () => {
      const vtt =
        'WEBVTT - Demo\n\n' +
        'NOTE This is a comment\n\n' +
        'STYLE\n::cue { color: white; }\n\n' +
        'intro\n' +
        '00:02.000 --> 00:05.500 position:50%\n' +
        '<v Alice><00:02.500>Hi there!</v>\n\n' +
        '00:06.000 --> 00:08.000\n' +
        'Second cue\n';

      const entries = SubtitleParser.parseVtt(vtt);
      expect(entries).toEqual([
        { startMs: 2000, endMs: 5500, text: 'Hi there!' },
        { startMs: 6000, endMs: 8000, text: 'Second cue' },
      ]);
    });

    test('parseSubtitleFile auto-detects .vtt and .srt formats cleanly', () => {
      const srtSample = '1\n00:00:00,500 --> 00:00:02,000\nFrom SRT\n';
      const vttSample = 'WEBVTT\n\n00:01.000 --> 00:03.000\nFrom VTT\n';

      expect(SubtitleParser.parseSubtitleFile(srtSample, 'movie.srt')).toEqual([
        { startMs: 500, endMs: 2000, text: 'From SRT' },
      ]);
      expect(SubtitleParser.parseSubtitleFile(vttSample, 'unknown.txt')).toEqual([
        { startMs: 1000, endMs: 3000, text: 'From VTT' },
      ]);
      expect(SubtitleParser.parseSubtitleFile('', 'empty.srt')).toEqual([]);
    });
  });
});
