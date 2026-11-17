import { describe, test, expect } from '@jest/globals';
import { YOUSUB_PROVIDERS } from '../../src/shared/providers-registry.js';

describe('Providers Registry Module', () => {
  test('should return correct provider by ID', () => {
    const google = YOUSUB_PROVIDERS.getProvider('google');
    expect(google).not.toBeNull();
    expect(google.name).toBe('Google Gemini');
    expect(google.apiStyle).toBe('gemini');

    const unknown = YOUSUB_PROVIDERS.getProvider('nonexistent');
    expect(unknown).toBeNull();
  });

  test('should return models for a given provider', () => {
    const models = YOUSUB_PROVIDERS.getModelsForProvider('openai');
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toContain('gpt');
  });

  test('should detect provider from API key correctly', () => {
    expect(YOUSUB_PROVIDERS.detectProviderFromKey('AIzaTestKey')).toBe('google');
    expect(YOUSUB_PROVIDERS.detectProviderFromKey('sk-ant-test')).toBe('anthropic');
    expect(YOUSUB_PROVIDERS.detectProviderFromKey('gsk_test')).toBe('groq');
    expect(YOUSUB_PROVIDERS.detectProviderFromKey('sk-or-v1-test')).toBe('openrouter');
    expect(YOUSUB_PROVIDERS.detectProviderFromKey('xai-test')).toBe('xai');
    expect(YOUSUB_PROVIDERS.detectProviderFromKey('sk-generic')).toBe('openai');
    expect(YOUSUB_PROVIDERS.detectProviderFromKey('invalid')).toBeNull();
    expect(YOUSUB_PROVIDERS.detectProviderFromKey('')).toBeNull();
  });

  test('should have a valid language list', () => {
    expect(YOUSUB_PROVIDERS.languages.length).toBeGreaterThan(10);
    const vi = YOUSUB_PROVIDERS.languages.find((l) => l.code === 'vi');
    expect(vi.name).toBe('Vietnamese');
  });

  test('should expose live Groq models and migrate deprecated Groq model IDs', () => {
    const groq = YOUSUB_PROVIDERS.getProvider('groq');
    expect(groq.defaultModel).toBe('openai/gpt-oss-120b');
    expect(groq.models.map((m) => m.id)).toEqual([
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3.8-27b',
    ]);

    expect(YOUSUB_PROVIDERS.resolveModel('groq', 'auto')).toBe('openai/gpt-oss-120b');
    expect(YOUSUB_PROVIDERS.resolveModel('groq', 'llama-3.3-70b-versatile')).toBe(
      'openai/gpt-oss-120b'
    );
    expect(YOUSUB_PROVIDERS.resolveModel('groq', 'qwen/qwen3-32b')).toBe('qwen/qwen3.8-27b');
    expect(YOUSUB_PROVIDERS.resolveModel('groq', 'custom-user-model')).toBe('custom-user-model');
    expect(YOUSUB_PROVIDERS.resolveModel('unknown-provider', 'x')).toBe('x');
  });
});
