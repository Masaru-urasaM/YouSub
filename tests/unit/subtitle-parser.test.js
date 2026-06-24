import { describe, test, expect, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('SubtitleParser Module', () => {
  let YS;
  const scriptPath = path.resolve(__dirname, '../../src/content/subtitle-parser.js');
  const scriptContent = fs.readFileSync(scriptPath, 'utf8');

  beforeEach(() => {
    window.YouSub = {};
    YS = window.YouSub;
    // JSDOM provides DOMParser by default
    eval(scriptContent);
  });

  test('should parse JSON3 correctly', () => {
    const mockData = {
      events: [
        { tStartMs: 100, dDurationMs: 500, segs: [{ utf8: 'Hello' }] },
        { tStartMs: 700, dDurationMs: 300, segs: [{ utf8: 'World' }] },
      ],
    };

    const result = YS.SubtitleParser.parseJson3(mockData);
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

    const result = YS.SubtitleParser.parseJson3(mockData);
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

    const result = YS.SubtitleParser.parseXml(xmlText);
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

    const result = YS.SubtitleParser.parseXml(xmlText);
    // document.createElement('textarea').innerHTML = '&lt;b&gt;' -> '<b>'
    expect(result[0].text).toBe('<b>Encoded & Text</b>');
  });

  test('should sort tracks by start time', () => {
    const mockData = {
      events: [
        { tStartMs: 500, dDurationMs: 100, segs: [{ utf8: 'Late' }] },
        { tStartMs: 100, dDurationMs: 100, segs: [{ utf8: 'Early' }] },
      ],
    };

    const result = YS.SubtitleParser.parseJson3(mockData);
    expect(result[0].text).toBe('Early');
    expect(result[1].text).toBe('Late');
  });

  test('should return empty array on invalid input', () => {
    expect(YS.SubtitleParser.parseJson3(null)).toEqual([]);
    expect(YS.SubtitleParser.parseXml('invalid xml')).toEqual([]);
  });
});
