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
    const vi = YOUSUB_PROVIDERS.languages.find(l => l.code === 'vi');
    expect(vi.name).toBe('Vietnamese');
  });
});
