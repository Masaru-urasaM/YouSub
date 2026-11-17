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

    test('injects main-world-fetcher once and resolves via main-world JSON3', async () => {
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

      const promise = SubtitleParser.fetch('https://youtube.com/api/timedtext?v=1');
      const script = document.querySelector('script[src*="main-world-fetcher.js"]');
      expect(script).not.toBeNull();
      script.onload();
      expect(document.querySelector('script[src*="main-world-fetcher.js"]')).toBeNull();

      const entries = await promise;
      expect(entries).toEqual([{ startMs: 0, endMs: 1000, text: 'Hi' }]);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
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
});
