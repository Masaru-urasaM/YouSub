import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { Logger } from '../shared/logger.js';
import { HealthManager } from './health.js';
import { sanitizeKey } from '../shared/utils.js';

/**
 * Handle API interactions dynamically based on provider apiStyle.
 */
export const Providers = {
  /**
   * Run a quick test request to verify API Key validity
   */
  async testApiKey(providerId, modelId, apiKey) {
    const prompt = 'Respond with only: OK';
    const startTime = performance.now();
    const safeKey = sanitizeKey(apiKey);

    try {
      // Phase 39: Enhanced diagnostic logging
      const keyLength = safeKey.length;
      const prefix = safeKey.substring(0, 4);
      const suffix = safeKey.slice(-4);
      const maskedFormat = `${prefix}...${suffix}`;

      Logger.info(
        'Providers',
        `Testing key [${providerId}] - Length: ${keyLength}, Format: ${maskedFormat}`
      );

      const res = await this.chat(providerId, modelId, safeKey, prompt, {
        temperature: 0,
        maxTokens: 1000,
        timeoutMs: 30000,
      });
      const duration = performance.now() - startTime;

      // Auto-thaw: reset full stats on success, report failure normally
      if (res.success) {
        await HealthManager.resetStats(providerId, apiKey);
      } else {
        await HealthManager.report(providerId, apiKey, false, duration);
      }

      // Phase 41: Sync yousub_api_keys storage to clear stale failure messages
      if (res.success) {
        const items = await browser.storage.local.get(['yousub_api_keys']);
        const keys = items.yousub_api_keys || [];
        let modified = false;

        keys.forEach((k) => {
          // If this is the key we just tested (using sanitized comparison)
          if (sanitizeKey(k.apiKey) === safeKey) {
            k.status = 'ok';
            k.statusMessage = `Tested ${new Date().toISOString().split('T')[0]}`;
            modified = true;
          }
        });

        if (modified) {
          await browser.storage.local.set({ yousub_api_keys: keys });
        }
      }

      if (res.success) {
        const resolvedProvider =
          providerId === 'auto'
            ? YOUSUB_PROVIDERS.detectProviderFromKey(safeKey) || providerId
            : providerId;
        try {
          const quota = await this.fetchQuota(resolvedProvider, safeKey);
          if (quota) res.quota = quota;
        } catch (qe) {
          Logger.warn('Providers', `Quota fetch failed for ${resolvedProvider}`, {
            error: qe.message,
          });
        }
      }

      return res;
    } catch (e) {
      Logger.error('Providers', `Test failed for ${providerId}`, { error: e.message });
      await HealthManager.report(providerId, apiKey, false);
      return { success: false, message: e.message };
    }
  },

  async fetchQuota(providerId, apiKey) {
    const provider = YOUSUB_PROVIDERS.getProvider(providerId);
    if (!provider?.quotaEndpoint) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(provider.quotaEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) return null;
      const data = await res.json();

      if (providerId === 'openrouter') {
        const d = data.data || data;
        return {
          credits: {
            used: d.usage ?? null,
            remaining: d.limit != null && d.usage != null ? d.limit - d.usage : null,
            limit: d.limit ?? null,
          },
          currency: 'USD',
          raw: data,
        };
      }

      if (providerId === 'deepseek') {
        const info = data.balance_infos?.[0];
        if (!info) return null;
        return {
          credits: {
            used: null,
            remaining: isNaN(parseFloat(info.total_balance))
              ? null
              : parseFloat(info.total_balance),
            limit: null,
          },
          currency: info.currency || 'CNY',
          raw: data,
        };
      }

      return null;
    } catch (e) {
      clearTimeout(timer);
      Logger.warn('Providers', `fetchQuota error for ${providerId}`, { error: e.message });
      return null;
    }
  },

  /**
   * Resolve provider metadata and migrate 'auto' or deprecated built-in model IDs.
   */
  resolveTarget(providerId, modelId, apiKey, { streamMode = false } = {}) {
    let internalProviderId = providerId;
    if (providerId === 'auto') {
      const detectedId = YOUSUB_PROVIDERS.detectProviderFromKey(apiKey);
      if (!detectedId) {
        return {
          error: {
            success: false,
            message: streamMode
              ? 'Provider not supported'
              : 'Could not auto-detect provider from key prefix.',
            ...(streamMode ? {} : { model: 'auto' }),
          },
        };
      }
      internalProviderId = detectedId;
    }

    const providerObj = YOUSUB_PROVIDERS.getProvider(internalProviderId);
    if (!providerObj) {
      return {
        error: {
          success: false,
          message: streamMode
            ? 'Provider not supported'
            : `Provider ${internalProviderId} not supported.`,
          ...(streamMode ? {} : { model: modelId }),
        },
      };
    }

    const internalModelId = YOUSUB_PROVIDERS.resolveModel(internalProviderId, modelId);
    return { internalProviderId, internalModelId, providerObj };
  },

  /**
   * Streaming version of chat
   * @param {function(string)} onChunk - Callback for each text chunk
   */
  async chatStream(providerId, modelId, apiKey, prompt, options = {}, onChunk) {
    const safeKey = sanitizeKey(apiKey);
    const resolved = this.resolveTarget(providerId, modelId, apiKey, { streamMode: true });
    if (resolved.error) return resolved.error;
    const { internalProviderId, internalModelId, providerObj } = resolved;

    const style = providerObj.apiStyle;
    const endpoint = providerObj.endpoint;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 30000);

    // Phase 52.1: Wire external abort signal to internal controller
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    try {
      let response;
      const streamOptions = { ...options, stream: true, providerId: internalProviderId };

      if (style === 'openai') {
        response = await this.callOpenAIStyle(
          endpoint,
          safeKey,
          internalModelId,
          prompt,
          streamOptions,
          controller.signal
        );
      } else if (style === 'anthropic') {
        response = await this.callAnthropic(
          endpoint,
          safeKey,
          internalModelId,
          prompt,
          streamOptions,
          controller.signal
        );
      } else if (style === 'gemini') {
        response = await this.callGemini(
          endpoint,
          safeKey,
          internalModelId,
          prompt,
          streamOptions,
          controller.signal
        );
      }

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errBody = await response.text();
        return { success: false, message: `HTTP ${response.status}: ${errBody}` };
      }

      return await this.handleStreamResponse(response, style, onChunk);
    } catch (err) {
      clearTimeout(timeoutId);
      return { success: false, message: err.name === 'AbortError' ? 'Timeout' : err.message };
    }
  },

  async handleStreamResponse(response, style, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep partial line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          let chunkText = '';
          if (style === 'openai' && trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.substring(6));
              chunkText = json.choices?.[0]?.delta?.content || '';
            } catch {}
          } else if (style === 'anthropic' && trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.substring(6));
              if (json.type === 'content_block_delta') {
                chunkText = json.delta?.text || '';
              }
            } catch {}
          } else if (style === 'gemini') {
            // Gemini stream is often a series of JSON objects in one chunk or SSE-like
            // If it's a standard fetch stream of JSON array parts:
            try {
              const json = JSON.parse(trimmed);
              chunkText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
            } catch {
              // Handle case where Gemini might prepend 'data: ' in some proxy setups
              if (trimmed.startsWith('data: ')) {
                try {
                  const json = JSON.parse(trimmed.substring(6));
                  chunkText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
                } catch {}
              }
            }
          }

          if (chunkText) {
            fullText += chunkText;
            if (onChunk) onChunk(chunkText);
          }
        }
      }
      return { success: true, text: fullText };
    } catch (err) {
      return { success: false, message: `Stream error: ${err.message}`, text: fullText };
    }
  },

  /**
   * Generic chat/prompt method
   * @returns {Promise<{success: boolean, message: string, model: string, text: string}>}
   */
  async chat(providerId, modelId, apiKey, prompt, options = {}) {
    // Phase 40: Deep sanitization
    const safeKey = sanitizeKey(apiKey);

    // Masked log for diagnostic (shows only last 4 chars)
    Logger.debug('Providers', `Request using key ending in ...${safeKey.slice(-4)}`);

    const resolved = this.resolveTarget(providerId, modelId, apiKey, { streamMode: false });
    if (resolved.error) return resolved.error;
    const { internalProviderId, internalModelId, providerObj } = resolved;

    const endpoint = providerObj.endpoint;
    const style = providerObj.apiStyle;
    const timeoutMs = options.timeoutMs || 15000;
    // Derive the default timeout message from the actual timeoutMs so it always
    // matches the real abort window (DEFERRED D3: the old literal read "30s" while
    // the default is 15s). A caller-supplied timeoutMsg still takes precedence.
    const timeoutMsg = options.timeoutMsg || `Request timed out (${Math.round(timeoutMs / 1000)}s)`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      // Phase 47: Wire external abort signal (from global 55s timeout) to this controller
      if (options.signal) {
        if (options.signal.aborted) {
          controller.abort();
        } else {
          options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
      }

      Logger.trace(
        'Providers',
        `[FETCH_START] ${internalProviderId} (${internalModelId}) - Timeout: ${timeoutMs}ms`
      );

      const styleOptions = { ...options, providerId: internalProviderId };
      let response;
      if (style === 'openai') {
        response = await this.callOpenAIStyle(
          endpoint,
          safeKey,
          internalModelId,
          prompt,
          styleOptions,
          controller.signal
        );
      } else if (style === 'gemini') {
        response = await this.callGemini(
          endpoint,
          safeKey,
          internalModelId,
          prompt,
          styleOptions,
          controller.signal
        );
      } else if (style === 'anthropic') {
        response = await this.callAnthropic(
          endpoint,
          safeKey,
          internalModelId,
          prompt,
          styleOptions,
          controller.signal
        );
      } else {
        clearTimeout(timeoutId);
        return { success: false, message: `Unknown API style: ${style}`, model: internalModelId };
      }

      clearTimeout(timeoutId);
      Logger.trace(
        'Providers',
        `[FETCH_END] ${internalProviderId} answered with status ${response.status}`
      );
      return this.handleResponse(response, internalModelId, style);
    } catch (err) {
      Logger.error('Providers', `Request failed for ${internalProviderId}`, { error: err.message });
      if (err.name === 'AbortError') {
        return { success: false, message: timeoutMsg, model: internalModelId };
      }
      return { success: false, message: `Network error: ${err.message}`, model: internalModelId };
    }
  },

  async callOpenAIStyle(endpoint, apiKey, model, prompt, options, signal) {
    const isGroq = options.providerId === 'groq' || endpoint.includes('api.groq.com');
    let maxTokens = options.maxTokens || 32768;
    if (isGroq && model === 'qwen/qwen3.8-27b') {
      // Groq enforces a 1000 OTPM ceiling on qwen/qwen3.8-27b; cap max_tokens to avoid 429
      maxTokens = Math.min(maxTokens, 900);
    }

    const payload = {
      model: model,
      messages: [
        { role: 'system', content: options.systemPrompt || 'You are a helpful assistant.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: options.temperature ?? 0.3,
      stream: !!options.stream, // Enable streaming if requested
    };

    if (isGroq && typeof model === 'string' && model.includes('gpt-oss')) {
      // Keep reasoning tokens compact so json_object outputs do not truncate
      payload.reasoning_effort = options.reasoningEffort || 'low';
    }

    if (options.responseFormat) {
      payload.response_format = options.responseFormat;
    }

    Logger.trace('Providers', `Requesting ${model} at ${endpoint}`, {
      keyLen: apiKey.length,
      payloadKeys: Object.keys(payload),
    });

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    return fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  },

  async callGemini(endpointPattern, apiKey, model, prompt, options, signal) {
    const action = options.stream ? 'streamGenerateContent' : 'generateContent';
    const endpoint =
      endpointPattern.replace('{model}', model).replace('generateContent', action) +
      `?key=${apiKey}`;
    const systemInstruction = options.systemPrompt
      ? { parts: [{ text: options.systemPrompt }] }
      : undefined;
    const payload = {
      systemInstruction: systemInstruction,
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: options.maxTokens || 65000,
        temperature: options.temperature ?? 0.3,
        ...(options.responseFormat
          ? {
              responseMimeType: 'application/json',
              responseSchema: options.responseSchema,
            }
          : {}),
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    };

    Logger.trace('Providers', `Gemini Request (${model}, stream=${!!options.stream})`);

    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  },

  async callAnthropic(endpoint, apiKey, model, prompt, options, signal) {
    const payload = {
      model: model,
      system: options.systemPrompt || '',
      max_tokens: options.maxTokens || 32768,
      temperature: options.temperature ?? 0.3,
      messages: [{ role: 'user', content: prompt }],
      stream: !!options.stream,
    };

    Logger.trace('Providers', `Anthropic Request (${model}, stream=${!!options.stream})`);

    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(payload),
      signal,
    });
  },

  async handleResponse(response, modelId, style) {
    if (response.ok) {
      try {
        const data = await response.json();
        Logger.trace('Providers', 'Response received (Success)');
        let text = '';
        let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

        // Extract text and usage based on style
        if (style === 'openai') {
          text = data.choices?.[0]?.message?.content || '';
          if (data.usage) {
            usage.promptTokens = data.usage.prompt_tokens || 0;
            usage.completionTokens = data.usage.completion_tokens || 0;
            usage.totalTokens = data.usage.total_tokens || 0;
          }
        } else if (style === 'gemini') {
          text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (data.usageMetadata) {
            usage.promptTokens = data.usageMetadata.promptTokenCount || 0;
            usage.completionTokens = data.usageMetadata.candidatesTokenCount || 0;
            usage.totalTokens = data.usageMetadata.totalTokenCount || 0;
          }
        } else if (style === 'anthropic') {
          text = data.content?.[0]?.text || '';
          if (data.usage) {
            usage.promptTokens = data.usage.input_tokens || 0;
            usage.completionTokens = data.usage.output_tokens || 0;
            usage.totalTokens = usage.promptTokens + usage.completionTokens;
          }
        }

        if (text) {
          const rateLimit = {};
          for (const [header, field] of [
            ['x-ratelimit-remaining-tokens', 'remainingTokens'],
            ['x-ratelimit-remaining-requests', 'remainingRequests'],
            ['x-ratelimit-limit-tokens', 'limitTokens'],
            ['x-ratelimit-limit-requests', 'limitRequests'],
          ]) {
            const v = response.headers.get(header);
            if (v !== null) rateLimit[field] = parseInt(v, 10) || 0;
          }

          if (style === 'anthropic') {
            for (const [header, field] of [
              ['anthropic-ratelimit-tokens-remaining', 'remainingTokens'],
              ['anthropic-ratelimit-tokens-limit', 'limitTokens'],
              ['anthropic-ratelimit-requests-remaining', 'remainingRequests'],
              ['anthropic-ratelimit-requests-limit', 'limitRequests'],
              ['anthropic-ratelimit-input-tokens-remaining', 'inputTokensRemaining'],
              ['anthropic-ratelimit-input-tokens-limit', 'inputTokensLimit'],
              ['anthropic-ratelimit-output-tokens-remaining', 'outputTokensRemaining'],
              ['anthropic-ratelimit-output-tokens-limit', 'outputTokensLimit'],
            ]) {
              const v = response.headers.get(header);
              if (v !== null && rateLimit[field] === undefined) {
                rateLimit[field] = parseInt(v, 10) || 0;
              }
            }
          }
          return {
            success: true,
            message: 'Success',
            model: modelId,
            text: text.trim(),
            usage,
            rateLimit,
          };
        } else {
          let errorMsg = 'Empty response text from provider';
          if (style === 'gemini' && data.candidates?.[0]?.finishReason) {
            errorMsg += ` (FinishReason: ${data.candidates[0].finishReason})`;
          }
          return { success: false, message: errorMsg, model: modelId, usage: usage };
        }
      } catch {
        return { success: false, message: 'Parse error', model: modelId };
      }
    }

    let errorMessage = 'Unknown error';
    switch (response.status) {
      case 401:
        errorMessage = 'Invalid API key';
        break;
      case 403:
        errorMessage = 'API key permissions/credits';
        break;
      case 404:
        errorMessage = 'Model not found';
        break;
      case 429:
        errorMessage = 'Rate limit exceeded';
        break;
      default:
        errorMessage = response.status >= 500 ? 'Server error' : `HTTP ${response.status}`;
    }

    // Extract Retry-After header for rate limit responses
    let retryAfterMs = 0;
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        retryAfterMs = !isNaN(parsed) ? parsed * 1000 : 0;
      }
    }

    // Try to get detail
    let quotaDetail = null;
    try {
      const rawBody = await response.text();
      Logger.trace('Providers', 'Raw Error Body', { body: rawBody.substring(0, 200) });

      const data = JSON.parse(rawBody);
      const detail = data.error?.message || data.error || '';
      if (detail) errorMessage += `: ${detail}`;

      if (response.status === 429 && typeof detail === 'string') {
        const m = detail.match(/Limit\s+(\d+),\s*Used\s+(\d+),\s*Requested\s+(\d+)/);
        if (m) quotaDetail = { limit: +m[1], used: +m[2], requested: +m[3] };
        const r = detail.match(/try again in\s+([^\s.]+(?:\.\d+s?)?)/i);
        if (r) {
          if (!quotaDetail) quotaDetail = {};
          quotaDetail.retryIn = r[1];
        }
      }
    } catch {
      Logger.warn('Providers', 'Could not parse error body as JSON');
    }

    return {
      success: false,
      message: errorMessage,
      model: modelId,
      statusCode: response.status,
      retryAfterMs,
      quotaDetail,
    };
  },
};
