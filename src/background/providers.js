import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { Logger } from '../shared/logger.js';
import { HealthManager } from './health.js';

/**
 * Helper to remove non-printable and zero-width characters
 */
const sanitizeKey = (key) => {
  if (!key) return '';
  // Remove non-printable, zero-width, and other common garbage characters
  return key.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
};

/**
 * Handle API interactions dynamically based on provider apiStyle.
 */
export const Providers = {
  /**
   * Run a quick test request to verify API Key validity
   */
  async testApiKey(providerId, modelId, apiKey) {
    const prompt = "Respond with only: OK";
    const startTime = performance.now();
    const safeKey = sanitizeKey(apiKey);

    try {
      // Phase 39: Enhanced diagnostic logging
      const keyLength = safeKey.length;
      const prefix = safeKey.substring(0, 4);
      const suffix = safeKey.slice(-4);
      const maskedFormat = `${prefix}...${suffix}`;

      Logger.info('Providers', `Testing key [${providerId}] - Length: ${keyLength}, Format: ${maskedFormat}`);

      const res = await this.chat(providerId, modelId, safeKey, prompt, { temperature: 0, maxTokens: 1000, timeoutMs: 30000 });
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
        
        keys.forEach(k => {
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

      return res;
    } catch (e) {
      Logger.error('Providers', `Test failed for ${providerId}`, { error: e.message });
      await HealthManager.report(providerId, apiKey, false);
      return { success: false, message: e.message };
    }
  },

  /**
   * Generic chat/prompt method
   * @returns {Promise<{success: boolean, message: string, model: string, text: string}>}
   */
  async chat(providerId, modelId, apiKey, prompt, options = {}) {
    // Phase 40: Deep sanitization
    const safeKey = sanitizeKey(apiKey);
    let internalProviderId = providerId;
    let internalModelId = modelId;

    // Masked log for diagnostic (shows only last 4 chars)
    Logger.debug('Providers', `Request using key ending in ...${safeKey.slice(-4)}`);

    // Auto-detect provider if needed
    if (providerId === 'auto') {
      const detectedId = YOUSUB_PROVIDERS.detectProviderFromKey(apiKey);
      if (detectedId) {
        internalProviderId = detectedId;
        const providerInfo = YOUSUB_PROVIDERS.getProvider(detectedId);
        internalModelId = modelId === 'auto' ? (providerInfo?.defaultModel || 'unknown') : modelId;
      } else {
        return { success: false, message: 'Could not auto-detect provider from key prefix.', model: 'auto' };
      }
    } else {
      const providerInfo = YOUSUB_PROVIDERS.getProvider(providerId);
      if (providerInfo && modelId === 'auto') {
        internalModelId = providerInfo.defaultModel;
      }
    }

    const providerObj = YOUSUB_PROVIDERS.getProvider(internalProviderId);
    if (!providerObj) {
      return { success: false, message: `Provider ${internalProviderId} not supported.`, model: internalModelId };
    }

    const endpoint = providerObj.endpoint;
    const style = providerObj.apiStyle;
    const timeoutMsg = options.timeoutMsg || 'Request timed out (30s)';
    const timeoutMs = options.timeoutMs || 15000;

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

      Logger.error('Providers', `[FETCH_START] ${internalProviderId} (${internalModelId}) - Timeout: ${timeoutMs}ms`);

      let response;
      if (style === 'openai') {
        response = await this.callOpenAIStyle(endpoint, safeKey, internalModelId, prompt, options, controller.signal);
      } else if (style === 'gemini') {
        response = await this.callGemini(endpoint, safeKey, internalModelId, prompt, options, controller.signal);
      } else if (style === 'anthropic') {
        response = await this.callAnthropic(endpoint, safeKey, internalModelId, prompt, options, controller.signal);
      } else {
        clearTimeout(timeoutId);
        return { success: false, message: `Unknown API style: ${style}`, model: internalModelId };
      }

      clearTimeout(timeoutId);
      Logger.error('Providers', `[FETCH_END] ${internalProviderId} answered with status ${response.status}`);
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
    const payload = {
      model: model,
      messages: [
        { role: 'system', content: options.systemPrompt || "You are a helpful assistant." },
        { role: 'user', content: prompt }
      ],
      max_tokens: options.maxTokens || 32768,
      temperature: options.temperature ?? 0.3,
      stream: false // Phase 39: Explicitly disable streaming for better compatibility
    };

    console.log(`%c[YouSub-Trace] Requesting ${model} at ${endpoint}`, 'color: #3b82f6; font-weight: bold;', {
      headers: {
        'Authorization': `Bearer ${apiKey.substring(0, 4)}... (Len: ${apiKey.length})`,
        'Content-Type': 'application/json'
      },
      payload
    });

    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal
    });
  },

  async callGemini(endpointPattern, apiKey, model, prompt, options, signal) {
    const endpoint = endpointPattern.replace('{model}', model) + `?key=${apiKey}`;
    const systemInstruction = options.systemPrompt ? { parts: [{ text: options.systemPrompt }] } : undefined;
    const payload = {
      systemInstruction: systemInstruction,
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: options.maxTokens || 65000,
        temperature: options.temperature ?? 0.3
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    console.log(`%c[YouSub-API] Gemini Request (${model}):`, 'color: #10b981; font-weight: bold;', {
      endpoint: endpointPattern.replace('{model}', model),
      payload
    });

    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });
  },

  async callAnthropic(endpoint, apiKey, model, prompt, options, signal) {
    const payload = {
      model: model,
      system: options.systemPrompt || "",
      max_tokens: options.maxTokens || 32768,
      temperature: options.temperature ?? 0.3,
      messages: [{ role: 'user', content: prompt }]
    };

    console.log(`%c[YouSub-API] Anthropic Request (${model}):`, 'color: #f59e0b; font-weight: bold;', {
      endpoint,
      payload
    });

    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(payload),
      signal
    });
  },

  async handleResponse(response, modelId, style) {
    if (response.ok) {
      try {
        const data = await response.json();
        console.log(`%c[YouSub-API] Response XML/JSON Received (Success):`, 'color: #a855f7; font-weight: bold;', data);
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
          return { success: true, message: 'Success', model: modelId, text: text.trim(), usage: usage };
        } else {
          let errorMsg = 'Empty response text from provider';
          if (style === 'gemini' && data.candidates?.[0]?.finishReason) {
            errorMsg += ` (FinishReason: ${data.candidates[0].finishReason})`;
          }
          return { success: false, message: errorMsg, model: modelId, usage: usage };
        }
      } catch (e) {
        return { success: false, message: 'Parse error', model: modelId };
      }
    }

    let errorMessage = 'Unknown error';
    switch (response.status) {
      case 401: errorMessage = 'Invalid API key'; break;
      case 403: errorMessage = 'API key permissions/credits'; break;
      case 404: errorMessage = 'Model not found'; break;
      case 429: errorMessage = 'Rate limit exceeded'; break;
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
    try {
      const rawBody = await response.text();
      console.log(`%c[YouSub-Trace] Raw Error Body:`, 'color: #ef4444; font-weight: bold;', rawBody);

      const data = JSON.parse(rawBody);
      const detail = data.error?.message || data.error || '';
      if (detail) errorMessage += `: ${detail}`;
    } catch (e) {
      console.warn('[YouSub-Trace] Could not parse error body as JSON');
    }

    return { success: false, message: errorMessage, model: modelId, statusCode: response.status, retryAfterMs };
  }
};
