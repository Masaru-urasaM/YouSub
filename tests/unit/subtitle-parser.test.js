import { describe, test, expect } from '@jest/globals';
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
});
