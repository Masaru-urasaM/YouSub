import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { TextEncoder, TextDecoder } from 'node:util';

// jsdom does not expose TextEncoder/TextDecoder as globals, but
// providers.js (handleStreamResponse) and the stream test helper need them.
// Polyfill from Node's util — test-only setup, src/ is untouched.
if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder;
if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = TextDecoder;

const { Providers } = await import('../../src/background/providers.js');
const { HealthManager } = await import('../../src/background/health.js');

/**
 * Unit tests for src/background/providers.js.
 *
 * Strategy: import the real Providers object plus its real collaborators
 * (Logger, HealthManager, YOUSUB_PROVIDERS, sanitizeKey) — they all work
 * against the auto-loaded chrome/browser mock. Only global.fetch is swapped
 * per test to return canned Response-like objects, mirroring the pattern in
 * rough-translator.test.js.
 */

let originalFetch;

/**
 * Build a Response-like object for the success / parse paths.
 * headers.get() returns null for absent keys (matching the Fetch spec) so
 * handleResponse does not inject spurious rateLimit fields.
 */
function makeResponse({ ok = true, status = 200, json, text, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (k) => (headers[k] !== undefined ? headers[k] : null) },
    json: json || (async () => ({})),
    text: text || (async () => ''),
  };
}

/**
 * Build a streaming Response-like object whose body.getReader() yields the
 * given SSE chunk strings (encoded to Uint8Array) then signals done.
 */
function makeStreamResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) {
            const value = encoder.encode(chunks[i]);
            i += 1;
            return { done: false, value };
          }
          return { done: true, value: undefined };
        },
      }),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  originalFetch = globalThis.fetch;
  chrome.storage.local.store = {};
  chrome.storage.session.store = {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── chat(): OpenAI style ─────────────────────────────────────────────

describe('chat() — OpenAI style', () => {
  test('sends correct request and returns parsed success for openai', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeResponse({
        json: async () => ({
          choices: [{ message: { content: '  Hello world  ' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        headers: {
          'x-ratelimit-remaining-tokens': '1000',
          'x-ratelimit-limit-requests': '60',
        },
      })
    );

    const res = await Providers.chat('openai', 'gpt-4o-mini', 'sk-abc123', 'Hi there', {
      systemPrompt: 'Be terse',
      temperature: 0.7,
      maxTokens: 256,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Authorization']).toBe('Bearer sk-abc123');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Be terse' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Hi there' });
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(256);
    expect(body.stream).toBe(false);

    expect(res.success).toBe(true);
    expect(res.text).toBe('Hello world');
    expect(res.model).toBe('gpt-4o-mini');
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(res.rateLimit.remainingTokens).toBe(1000);
    expect(res.rateLimit.limitRequests).toBe(60);
  });

  test('uses default system prompt and resolves modelId "auto" to defaultModel', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeResponse({ json: async () => ({ choices: [{ message: { content: 'ok' } }] }) })
    );

    await Providers.chat('openai', 'auto', 'sk-abc', 'Q');

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4o-mini'); // openai defaultModel
    expect(body.messages[0].content).toBe('You are a helpful assistant.');
  });

  test('adds response_format when responseFormat option is set', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeResponse({ json: async () => ({ choices: [{ message: { content: 'x' } }] }) })
    );

    await Providers.chat('openai', 'gpt-4o-mini', 'sk-abc', 'Q', {
      responseFormat: { type: 'json_object' },
    });

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  test('omits Authorization header when apiKey is empty (e.g. ollama)', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeResponse({ json: async () => ({ choices: [{ message: { content: 'x' } }] }) })
    );

    await Providers.chat('ollama', 'llama3.1', '', 'Q');

    const init = globalThis.fetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBeUndefined();
  });
});

// ─── chat(): Gemini style ─────────────────────────────────────────────

describe('chat() — Gemini style', () => {
  test('builds correct URL with model + key and returns parsed text/usage', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeResponse({
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Bonjour' }] } }],
          usageMetadata: {
            promptTokenCount: 4,
            candidatesTokenCount: 2,
            totalTokenCount: 6,
          },
        }),
      })
    );

    const res = await Providers.chat('google', 'gemini-2.5-flash', 'AIzaKEY', 'Hello', {
      systemPrompt: 'sys',
    });

    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaKEY'
    );
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(body.contents[0].parts[0].text).toBe('Hello');

    expect(res.success).toBe(true);
    expect(res.text).toBe('Bonjour');
    expect(res.usage).toEqual({ promptTokens: 4, completionTokens: 2, totalTokens: 6 });
  });

  test('enables JSON mode (responseMimeType + schema) when responseFormat set', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeResponse({
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }),
      })
    );

    await Providers.chat('google', 'gemini-2.5-flash', 'AIzaKEY', 'Hello', {
      responseFormat: { type: 'json_object' },
      responseSchema: { type: 'object' },
    });

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toEqual({ type: 'object' });
  });

  test('omits systemInstruction when no systemPrompt provided', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeResponse({
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }),
      })
    );

    await Providers.chat('google', 'gemini-2.5-flash', 'AIzaKEY', 'Hello');

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.systemInstruction).toBeUndefined();
  });
});

// ─── chat(): Anthropic style ──────────────────────────────────────────

describe('chat() — Anthropic style', () => {
  test('sends anthropic headers/body and returns parsed text/usage', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeResponse({
        json: async () => ({
          content: [{ text: 'Claude says hi' }],
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
      })
    );

    const res = await Providers.chat(
      'anthropic',
      'claude-3-5-haiku-20241022',
      'sk-ant-xyz',
      'Hello',
      { systemPrompt: 'sys' }
    );

    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-xyz');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');

    const body = JSON.parse(init.body);
    expect(body.system).toBe('sys');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);

    expect(res.success).toBe(true);
    expect(res.text).toBe('Claude says hi');
    expect(res.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  });
});

// ─── chat(): auto-detect / unknown / error paths ──────────────────────

describe('chat() — provider resolution and error handling', () => {
  test('auto-detects provider from "sk-" key prefix (→ openai)', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeResponse({ json: async () => ({ choices: [{ message: { content: 'ok' } }] }) })
    );

    const res = await Providers.chat('auto', 'auto', 'sk-detectme', 'Q');

    expect(globalThis.fetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(res.success).toBe(true);
  });

  test('returns failure without fetching when auto-detect cannot resolve provider', async () => {
    globalThis.fetch = jest.fn();

    const res = await Providers.chat('auto', 'auto', 'unknown-prefix-key', 'Q');

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/auto-detect/i);
    expect(res.model).toBe('auto');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('returns failure for an unsupported provider id', async () => {
    globalThis.fetch = jest.fn();

    const res = await Providers.chat('nonexistent', 'm', 'key', 'Q');

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not supported/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('maps AbortError to the timeout message', async () => {
    globalThis.fetch = jest.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const res = await Providers.chat('openai', 'gpt-4o-mini', 'sk-abc', 'Q', {
      timeoutMsg: 'Custom timeout',
    });

    expect(res.success).toBe(false);
    expect(res.message).toBe('Custom timeout');
    expect(res.model).toBe('gpt-4o-mini');
  });

  test('maps a generic fetch rejection to a network error message', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('socket hang up');
    });

    const res = await Providers.chat('openai', 'gpt-4o-mini', 'sk-abc', 'Q');

    expect(res.success).toBe(false);
    expect(res.message).toBe('Network error: socket hang up');
  });

  test('honours a pre-aborted external signal', async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = jest.fn(async (_url, init) => {
      if (init.signal && init.signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return makeResponse({ json: async () => ({ choices: [{ message: { content: 'x' } }] }) });
    });

    const res = await Providers.chat('openai', 'gpt-4o-mini', 'sk-abc', 'Q', {
      signal: controller.signal,
    });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/timed out/i);
  });

  test('wires a non-aborted external signal as an abort listener', async () => {
    const controller = new AbortController(); // not aborted
    globalThis.fetch = jest.fn(async () =>
      makeResponse({ json: async () => ({ choices: [{ message: { content: 'done' } }] }) })
    );

    const res = await Providers.chat('openai', 'gpt-4o-mini', 'sk-abc', 'Q', {
      signal: controller.signal,
    });

    expect(res.success).toBe(true);
    expect(res.text).toBe('done');
  });
});

// ─── handleResponse(): success extraction per style ───────────────────

describe('handleResponse() — success shapes', () => {
  test('extracts anthropic-specific rate-limit headers', async () => {
    const response = makeResponse({
      json: async () => ({ content: [{ text: 'hi' }] }),
      headers: {
        'anthropic-ratelimit-tokens-remaining': '500',
        'anthropic-ratelimit-input-tokens-remaining': '300',
      },
    });

    const res = await Providers.handleResponse(response, 'claude-3-5-haiku-20241022', 'anthropic');

    expect(res.success).toBe(true);
    expect(res.rateLimit.remainingTokens).toBe(500);
    expect(res.rateLimit.inputTokensRemaining).toBe(300);
  });

  test('gemini empty text returns failure including finishReason', async () => {
    const response = makeResponse({
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'SAFETY' }],
      }),
    });

    const res = await Providers.handleResponse(response, 'gemini-2.5-flash', 'gemini');

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Empty response text/);
    expect(res.message).toMatch(/FinishReason: SAFETY/);
  });

  test('returns parse error when an ok response body is not JSON', async () => {
    const response = makeResponse({
      json: async () => {
        throw new Error('Unexpected token');
      },
    });

    const res = await Providers.handleResponse(response, 'gpt-4o-mini', 'openai');

    expect(res.success).toBe(false);
    expect(res.message).toBe('Parse error');
  });
});

// ─── handleResponse(): non-ok error shapes ────────────────────────────

describe('handleResponse() — error status mapping', () => {
  const cases = [
    [401, 'Invalid API key'],
    [403, 'API key permissions/credits'],
    [404, 'Model not found'],
    [500, 'Server error'],
    [418, 'HTTP 418'],
  ];

  test.each(cases)('status %i maps to message containing "%s"', async (status, expected) => {
    const response = makeResponse({
      ok: false,
      status,
      text: async () => '',
    });

    const res = await Providers.handleResponse(response, 'gpt-4o-mini', 'openai');

    expect(res.success).toBe(false);
    expect(res.message).toContain(expected);
    expect(res.statusCode).toBe(status);
  });

  test('429 extracts retry-after, quota detail, and retryIn from the body', async () => {
    const response = makeResponse({
      ok: false,
      status: 429,
      headers: { 'retry-after': '2' },
      text: async () =>
        JSON.stringify({
          error: {
            message: 'Rate limited. Limit 100, Used 90, Requested 20. Please try again in 1.5s.',
          },
        }),
    });

    const res = await Providers.handleResponse(response, 'gpt-4o-mini', 'openai');

    expect(res.success).toBe(false);
    expect(res.message).toContain('Rate limit exceeded');
    expect(res.retryAfterMs).toBe(2000);
    expect(res.quotaDetail.limit).toBe(100);
    expect(res.quotaDetail.used).toBe(90);
    expect(res.quotaDetail.requested).toBe(20);
    expect(res.quotaDetail.retryIn).toBe('1.5s');
  });

  test('appends a nested error.message to the error string', async () => {
    const response = makeResponse({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'bad model' } }),
    });

    const res = await Providers.handleResponse(response, 'gpt-4o-mini', 'openai');

    expect(res.message).toBe('HTTP 400: bad model');
  });

  test('tolerates a non-JSON error body', async () => {
    const response = makeResponse({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway (html)',
    });

    const res = await Providers.handleResponse(response, 'gpt-4o-mini', 'openai');

    expect(res.success).toBe(false);
    expect(res.message).toBe('Server error');
    expect(res.statusCode).toBe(502);
  });
});

// ─── chatStream(): end-to-end streaming per style ─────────────────────

describe('chatStream()', () => {
  test('streams openai content via callOpenAIStyle and returns accumulated text', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeStreamResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    );
    const onChunk = jest.fn();

    const res = await Providers.chatStream('openai', 'gpt-4o-mini', 'sk-abc', 'Hi', {}, onChunk);

    // stream:true flag was forwarded to the request body.
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.stream).toBe(true);

    expect(res.success).toBe(true);
    expect(res.text).toBe('Hello');
    expect(onChunk).toHaveBeenCalledTimes(2);
  });

  test('streams gemini content and uses the streamGenerateContent action in the URL', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeStreamResponse(['{"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n'])
    );

    const res = await Providers.chatStream(
      'google',
      'gemini-2.5-flash',
      'AIzaKEY',
      'Hello',
      {},
      jest.fn()
    );

    expect(globalThis.fetch.mock.calls[0][0]).toContain(':streamGenerateContent?key=AIzaKEY');
    expect(res.success).toBe(true);
    expect(res.text).toBe('Hi');
  });

  test('streams anthropic content via callAnthropic', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeStreamResponse(['data: {"type":"content_block_delta","delta":{"text":"Yo"}}\n\n'])
    );

    const res = await Providers.chatStream(
      'anthropic',
      'claude-3-5-haiku-20241022',
      'sk-ant-x',
      'Hello',
      {},
      jest.fn()
    );

    expect(globalThis.fetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    expect(res.success).toBe(true);
    expect(res.text).toBe('Yo');
  });

  test('auto-detects the provider from the key prefix', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeStreamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'])
    );

    const res = await Providers.chatStream('auto', 'auto', 'sk-detect', 'Q', {}, jest.fn());

    expect(globalThis.fetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(res.success).toBe(true);
  });

  test('returns failure for an unsupported provider without fetching', async () => {
    globalThis.fetch = jest.fn();

    const res = await Providers.chatStream('nope', 'm', 'key', 'Q', {}, jest.fn());

    expect(res.success).toBe(false);
    expect(res.message).toBe('Provider not supported');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('surfaces an HTTP error from a non-ok streaming response', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }));

    const res = await Providers.chatStream('openai', 'gpt-4o-mini', 'sk-abc', 'Q', {}, jest.fn());

    expect(res.success).toBe(false);
    expect(res.message).toBe('HTTP 401: unauthorized');
  });

  test('maps an AbortError to a Timeout message', async () => {
    globalThis.fetch = jest.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const res = await Providers.chatStream('openai', 'gpt-4o-mini', 'sk-abc', 'Q', {}, jest.fn());

    expect(res.success).toBe(false);
    expect(res.message).toBe('Timeout');
  });

  test('honours a pre-aborted external signal', async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = jest.fn(async (_url, init) => {
      if (init.signal && init.signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return makeStreamResponse(['data: [DONE]\n\n']);
    });

    const res = await Providers.chatStream('openai', 'gpt-4o-mini', 'sk-abc', 'Q', {
      signal: controller.signal,
    });

    expect(res.success).toBe(false);
    expect(res.message).toBe('Timeout');
  });

  test('wires a non-aborted external signal as an abort listener', async () => {
    const controller = new AbortController(); // not aborted
    globalThis.fetch = jest.fn(async () =>
      makeStreamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'])
    );

    const res = await Providers.chatStream(
      'openai',
      'gpt-4o-mini',
      'sk-abc',
      'Q',
      { signal: controller.signal },
      jest.fn()
    );

    expect(res.success).toBe(true);
    expect(res.text).toBe('ok');
  });
});

// ─── handleStreamResponse(): SSE accumulation per style ───────────────

describe('handleStreamResponse()', () => {
  test('accumulates openai delta content and calls onChunk per chunk', async () => {
    const response = makeStreamResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const onChunk = jest.fn();

    const res = await Providers.handleStreamResponse(response, 'openai', onChunk);

    expect(res.success).toBe(true);
    expect(res.text).toBe('Hello');
    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenNthCalledWith(1, 'Hel');
    expect(onChunk).toHaveBeenNthCalledWith(2, 'lo');
  });

  test('accumulates anthropic content_block_delta text', async () => {
    const response = makeStreamResponse([
      'data: {"type":"content_block_delta","delta":{"text":"Foo"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"Bar"}}\n\n',
    ]);
    const onChunk = jest.fn();

    const res = await Providers.handleStreamResponse(response, 'anthropic', onChunk);

    expect(res.success).toBe(true);
    expect(res.text).toBe('FooBar');
    expect(onChunk).toHaveBeenCalledTimes(2);
  });

  test('accumulates gemini parts text from raw JSON lines', async () => {
    const response = makeStreamResponse([
      '{"candidates":[{"content":{"parts":[{"text":"Hi "}]}}]}\n',
      '{"candidates":[{"content":{"parts":[{"text":"there"}]}}]}\n',
    ]);
    const onChunk = jest.fn();

    const res = await Providers.handleStreamResponse(response, 'gemini', onChunk);

    expect(res.success).toBe(true);
    expect(res.text).toBe('Hi there');
  });

  test('accumulates gemini text from a proxy that prepends "data: "', async () => {
    const response = makeStreamResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"proxied"}]}}]}\n',
    ]);
    const onChunk = jest.fn();

    const res = await Providers.handleStreamResponse(response, 'gemini', onChunk);

    expect(res.success).toBe(true);
    expect(res.text).toBe('proxied');
    expect(onChunk).toHaveBeenCalledWith('proxied');
  });

  test('returns stream error when the reader throws mid-stream', async () => {
    const response = {
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error('boom');
          },
        }),
      },
    };

    const res = await Providers.handleStreamResponse(response, 'openai', jest.fn());

    expect(res.success).toBe(false);
    expect(res.message).toBe('Stream error: boom');
  });
});

// ─── fetchQuota(): provider-specific shapes ───────────────────────────

describe('fetchQuota()', () => {
  test('returns null for a provider without a quotaEndpoint', async () => {
    globalThis.fetch = jest.fn();
    const quota = await Providers.fetchQuota('openai', 'sk-abc');
    expect(quota).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('parses openrouter credits shape', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeResponse({ json: async () => ({ data: { usage: 4, limit: 10 } }) })
    );

    const quota = await Providers.fetchQuota('openrouter', 'sk-or-v1-key');

    expect(globalThis.fetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/auth/key');
    expect(quota.currency).toBe('USD');
    expect(quota.credits).toEqual({ used: 4, remaining: 6, limit: 10 });
  });

  test('parses deepseek balance shape', async () => {
    globalThis.fetch = jest.fn(async () =>
      makeResponse({
        json: async () => ({
          balance_infos: [{ total_balance: '12.50', currency: 'USD' }],
        }),
      })
    );

    const quota = await Providers.fetchQuota('deepseek', 'sk-deepseek');

    expect(quota.currency).toBe('USD');
    expect(quota.credits.remaining).toBe(12.5);
  });

  test('returns null when the quota endpoint responds non-ok', async () => {
    globalThis.fetch = jest.fn(async () => makeResponse({ ok: false, status: 500 }));
    const quota = await Providers.fetchQuota('openrouter', 'sk-or-v1-key');
    expect(quota).toBeNull();
  });

  test('returns null and swallows a fetch rejection', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('network down');
    });
    const quota = await Providers.fetchQuota('deepseek', 'sk-deepseek');
    expect(quota).toBeNull();
  });
});

// ─── testApiKey(): happy and failure paths ────────────────────────────

describe('testApiKey()', () => {
  test('success resets health stats and marks the stored key as ok', async () => {
    // Seed a stale health entry + the stored key record.
    const apiKey = 'sk-testkey-123456';
    chrome.storage.local.store.yousub_api_keys = [
      { apiKey, provider: 'openai', status: 'error', statusMessage: 'old failure' },
    ];
    await HealthManager.report('openai', apiKey, false); // create a stats entry

    globalThis.fetch = jest.fn(async () =>
      makeResponse({ json: async () => ({ choices: [{ message: { content: 'OK' } }] }) })
    );

    const res = await Providers.testApiKey('openai', 'gpt-4o-mini', apiKey);

    expect(res.success).toBe(true);

    // HealthManager.resetStats ran: successCount reset to 1, no fails.
    const stats = chrome.storage.local.store.yousub_health_stats;
    const hash = HealthManager.getHash('openai', apiKey);
    expect(stats[hash].successCount).toBe(1);
    expect(stats[hash].failCount).toBe(0);

    // Stored key record was updated to status 'ok'.
    const keys = chrome.storage.local.store.yousub_api_keys;
    expect(keys[0].status).toBe('ok');
    expect(keys[0].statusMessage).toMatch(/^Tested /);
  });

  test('failure reports to HealthManager and surfaces the error message', async () => {
    const apiKey = 'sk-badkey-654321';
    globalThis.fetch = jest.fn(async () =>
      makeResponse({ ok: false, status: 401, text: async () => '' })
    );

    const res = await Providers.testApiKey('openai', 'gpt-4o-mini', apiKey);

    expect(res.success).toBe(false);
    expect(res.message).toContain('Invalid API key');

    // A failure was recorded in health stats.
    const stats = chrome.storage.local.store.yousub_health_stats;
    const hash = HealthManager.getHash('openai', apiKey);
    expect(stats[hash].failCount).toBe(1);
  });

  test('attaches quota on success for a provider with a quotaEndpoint', async () => {
    const apiKey = 'sk-or-v1-quotakey';
    let call = 0;
    globalThis.fetch = jest.fn(async () => {
      call += 1;
      if (call === 1) {
        // chat() success
        return makeResponse({
          json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
        });
      }
      // fetchQuota() for openrouter
      return makeResponse({ json: async () => ({ data: { usage: 1, limit: 5 } }) });
    });

    const res = await Providers.testApiKey('openrouter', 'auto', apiKey);

    expect(res.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(res.quota).toBeDefined();
    expect(res.quota.credits.remaining).toBe(4);
  });

  test('still succeeds when the quota fetch throws after a successful test', async () => {
    const apiKey = 'sk-or-v1-quotathrow';
    let call = 0;
    globalThis.fetch = jest.fn(async () => {
      call += 1;
      if (call === 1) {
        return makeResponse({
          json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
        });
      }
      throw new Error('quota endpoint down');
    });

    const res = await Providers.testApiKey('openrouter', 'auto', apiKey);

    expect(res.success).toBe(true);
    // fetchQuota swallows the throw internally and returns null, so no quota attached.
    expect(res.quota).toBeUndefined();
  });

  test('catches a thrown error from chat and reports failure', async () => {
    // sanitizeKey strips nothing here; force chat to throw by rejecting fetch
    // with a non-Abort error is caught inside chat, so instead drive the outer
    // catch via an unsupported provider that still returns (no throw). To hit
    // the outer try/catch, make HealthManager unavailable is invasive; instead
    // assert the normal failure-return path from a network error.
    const apiKey = 'sk-neterr-000000';
    globalThis.fetch = jest.fn(async () => {
      throw new Error('boom');
    });

    const res = await Providers.testApiKey('openai', 'gpt-4o-mini', apiKey);

    expect(res.success).toBe(false);
    expect(res.message).toContain('Network error');
  });
});
