import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { Logger } from '../shared/logger.js';

/**
 * Handle API interactions dynamically based on provider apiStyle.
 */
export const Providers = {
  /**
   * Run a quick test request to verify API Key validity
   */
  async testApiKey(providerId, modelId, apiKey) {
    const prompt = "Respond with only: OK";
    return this.chat(providerId, modelId, apiKey, prompt, { max_tokens: 10, temperature: 0 });
  },

  /**
   * Generic chat/prompt method
   * @returns {Promise<{success: boolean, message: string, model: string, text: string}>}
   */
  async chat(providerId, modelId, apiKey, prompt, options = {}) {
    let internalProviderId = providerId;
    let internalModelId = modelId;

    // Auto-detect provider if needed
    if (providerId === 'auto') {
      const detected = YOUSUB_PROVIDERS.detectProviderFromKey(apiKey);
      if (detected) {
        internalProviderId = detected.id;
        internalModelId = modelId === 'auto' ? detected.defaultModel : modelId;
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
    const timeoutMsg = options.timeoutMsg || 'Request timed out (20s)';
    const timeoutMs = options.timeoutMs || 20000;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      if (style === 'openai') {
        response = await this.callOpenAIStyle(endpoint, apiKey, internalModelId, prompt, options, controller.signal);
      } else if (style === 'gemini') {
        response = await this.callGemini(endpoint, apiKey, internalModelId, prompt, options, controller.signal);
      } else if (style === 'anthropic') {
        response = await this.callAnthropic(endpoint, apiKey, internalModelId, prompt, options, controller.signal);
      } else {
        clearTimeout(timeoutId);
        return { success: false, message: `Unknown API style: ${style}`, model: internalModelId };
      }

      clearTimeout(timeoutId);
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
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: options.systemPrompt || "You are a helpful assistant." },
          { role: 'user', content: prompt }
        ],
        ...(options.max_tokens ? { max_tokens: options.max_tokens } : {}),
        temperature: options.temperature ?? 0.3
      }),
      signal
    });
  },

  async callGemini(endpointPattern, apiKey, model, prompt, options, signal) {
    const endpoint = endpointPattern.replace('{model}', model) + `?key=${apiKey}`;
    const systemInstruction = options.systemPrompt ? { parts: [{ text: options.systemPrompt }] } : undefined;
    
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: systemInstruction,
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          ...(options.max_tokens ? { maxOutputTokens: options.max_tokens } : {}),
          temperature: options.temperature ?? 0.3
        }
      }),
      signal
    });
  },

  async callAnthropic(endpoint, apiKey, model, prompt, options, signal) {
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: model,
        system: options.systemPrompt || "",
        max_tokens: options.max_tokens || 4096, // Anthropic requires this
        temperature: options.temperature ?? 0.3,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal
    });
  },

  async handleResponse(response, modelId, style) {
    if (response.ok) {
      try {
        const data = await response.json();
        let text = '';
        
        // Extract text based on style
        if (style === 'openai') {
          text = data.choices?.[0]?.message?.content || '';
        } else if (style === 'gemini') {
          text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else if (style === 'anthropic') {
          text = data.content?.[0]?.text || '';
        }

        return { success: true, message: 'Success', model: modelId, text: text.trim() };
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

    // Try to get detail
    try {
      const data = await response.json();
      const detail = data.error?.message || data.error || '';
      if (detail) errorMessage += `: ${detail}`;
    } catch(e) {}

    return { success: false, message: errorMessage, model: modelId };
  }
};
