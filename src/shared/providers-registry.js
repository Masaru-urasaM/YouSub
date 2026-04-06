/**
 * src/shared/providers-registry.js
 * Definitions for supported LLM providers and models.
 * Exported as a pure ES Module.
 */

export const YOUSUB_PROVIDERS = {
  providers: [
    {
      id: 'google',
      name: 'Google Gemini',
      apiStyle: 'gemini',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
      keyPatterns: ['AIza'],
      models: [
        { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
        { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite' },
        { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
        { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' }
      ],
      defaultModel: 'gemini-2.0-flash'
    },
    {
      id: 'openai',
      name: 'OpenAI',
      apiStyle: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      keyPatterns: ['sk-'],
      models: [
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
        { id: 'gpt-4o', name: 'GPT-4o' }
      ],
      defaultModel: 'gpt-4o-mini'
    },
    {
      id: 'anthropic',
      name: 'Anthropic Claude',
      apiStyle: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      keyPatterns: ['sk-ant-'],
      models: [
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' }
      ],
      defaultModel: 'claude-3-5-haiku-20241022'
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      apiStyle: 'openai',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      keyPatterns: ['sk-'],
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)' }
      ],
      defaultModel: 'deepseek-chat'
    },
    {
      id: 'groq',
      name: 'Groq',
      apiStyle: 'openai',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      keyPatterns: ['gsk_'],
      models: [
        { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
        { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' }
      ],
      defaultModel: 'llama-3.3-70b-versatile'
    },
    {
      id: 'xai',
      name: 'xAI',
      apiStyle: 'openai',
      endpoint: 'https://api.x.ai/v1/chat/completions',
      keyPatterns: ['xai-'],
      models: [
        { id: 'grok-2-latest', name: 'Grok 2 Latest' }
      ],
      defaultModel: 'grok-2-latest'
    },
    {
      id: 'mistral',
      name: 'Mistral',
      apiStyle: 'openai',
      endpoint: 'https://api.mistral.ai/v1/chat/completions',
      keyPatterns: [],
      models: [
        { id: 'mistral-small-latest', name: 'Mistral Small' },
        { id: 'mistral-large-latest', name: 'Mistral Large' }
      ],
      defaultModel: 'mistral-small-latest'
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      apiStyle: 'openai',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      keyPatterns: ['sk-or-v1-'],
      models: [
        { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B (Free)' }
      ],
      defaultModel: 'meta-llama/llama-3.3-70b-instruct'
    }
  ],

  // Utility to get a provider by ID
  getProvider(id) {
    return this.providers.find(p => p.id === id) || null;
  },

  // Utility to get models for a given provider ID
  getModelsForProvider(id) {
    const provider = this.getProvider(id);
    return provider ? provider.models : [];
  },

  // Utility to guess the provider from the API key prefix
  detectProviderFromKey(apiKey) {
    if (!apiKey) return null;
    
    // Check specific/unique patterns first
    if (apiKey.startsWith('gsk_')) return 'groq';
    if (apiKey.startsWith('sk-ant-')) return 'anthropic';
    if (apiKey.startsWith('sk-or-v1-')) return 'openrouter';
    if (apiKey.startsWith('xai-')) return 'xai';
    if (apiKey.startsWith('AIza')) return 'google';
    
    // Ambiguous pattern
    if (apiKey.startsWith('sk-')) {
      return 'openai'; // Could also be DeepSeek or others. OpenAI is default guess.
    }
    
    return null;
  },

  // Language list for translation dropdowns
  languages: [
    { code: 'auto', name: 'Auto-detect' },
    { code: 'vi', name: 'Vietnamese' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: 'Japanese' },
    { code: 'ko', name: 'Korean' },
    { code: 'zh', name: 'Chinese (Simplified)' },
    { code: 'zh-TW', name: 'Chinese (Traditional)' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'ru', name: 'Russian' },
    { code: 'ar', name: 'Arabic' },
    { code: 'hi', name: 'Hindi' },
    { code: 'th', name: 'Thai' },
    { code: 'id', name: 'Indonesian' }
  ]
};
