import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPTIONS_HTML = fs.readFileSync(
  path.resolve(__dirname, '../../src/options/options.html'),
  'utf8'
);

const flushAsync = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

const mockLogger = {
  export: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

jest.unstable_mockModule('../../src/shared/logger.js', () => ({
  Logger: mockLogger,
}));

async function mountOptions(storageSeed = {}) {
  jest.resetModules();
  chrome.storage.local.store = { ...storageSeed };
  chrome.storage.onChanged._listeners.length = 0;

  const parsed = new DOMParser().parseFromString(OPTIONS_HTML, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;

  let readyCb;
  const spy = jest.spyOn(document, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'DOMContentLoaded') readyCb = fn;
  });
  await import('../../src/options/options.js');
  spy.mockRestore();

  readyCb();
  await flushAsync(8);
}

describe('options UI (options.js + tab-appearance.js + tab-translation.js) (T10)', () => {
  const origAlert = window.alert;
  const origConfirm = window.confirm;

  beforeEach(() => {
    jest.clearAllMocks();
    window.alert = jest.fn();
    window.confirm = jest.fn(() => true);
    chrome.permissions.contains.mockResolvedValue(false);
    chrome.permissions.request.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
    window.alert = origAlert;
    window.confirm = origConfirm;
  });

  test('options.js wires version strings, keyboard tab switching, and log export', async () => {
    jest.useFakeTimers();
    await mountOptions();

    const pkgVer = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
    ).version;
    expect(document.getElementById('version-badge').textContent).toBe(`v${pkgVer}`);
    expect(document.getElementById('about-version').textContent).toBe(`Version ${pkgVer}`);

    const tabs = [...document.querySelectorAll('.tab-btn')];
    tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('tab-appearance').classList.contains('active')).toBe(true);

    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');

    // Export logs: null, count, error
    mockLogger.export.mockResolvedValueOnce(null);
    document.getElementById('export-logs-btn').click();
    await flushAsync();
    expect(document.getElementById('save-status').textContent).toBe('No logs to export.');

    mockLogger.export.mockResolvedValueOnce(15);
    document.getElementById('export-logs-btn').click();
    await flushAsync();
    expect(document.getElementById('save-status').textContent).toBe('Exported 15 log entries.');
    jest.advanceTimersByTime(4000);
    expect(document.getElementById('save-status').textContent).toBe(
      'All changes saved automatically.'
    );

    mockLogger.export.mockRejectedValueOnce(new Error('disk'));
    document.getElementById('export-logs-btn').click();
    await flushAsync();
    expect(document.getElementById('save-status').textContent).toBe('Failed to export logs.');
  });

  test('tab-appearance.js loads defaults, updates live preview, and debounced-saves settings', async () => {
    jest.useFakeTimers();
    await mountOptions();

    const fontSize = document.getElementById('font-size');
    const fontColor = document.getElementById('font-color');
    const bgOpacity = document.getElementById('bg-opacity');
    const posBottom = document.getElementById('pos-bottom');
    const showStagePill = document.getElementById('show-stage-pill');
    const showDesktopFab = document.getElementById('show-desktop-fab');
    const preview = document.getElementById('subtitle-preview');

    expect(fontSize.value).toBe('1.5');
    expect(showStagePill.checked).toBe(true);
    expect(showDesktopFab.checked).toBe(false);

    fontSize.value = '2.2';
    fontSize.dispatchEvent(new Event('input', { bubbles: true }));
    fontColor.value = '#00ff00';
    fontColor.dispatchEvent(new Event('input', { bubbles: true }));
    bgOpacity.value = '0.8';
    bgOpacity.dispatchEvent(new Event('input', { bubbles: true }));
    posBottom.value = '100';
    posBottom.dispatchEvent(new Event('input', { bubbles: true }));
    showStagePill.checked = false;
    showStagePill.dispatchEvent(new Event('change', { bubbles: true }));
    showDesktopFab.checked = true;
    showDesktopFab.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.getElementById('font-size-val').textContent).toBe('2.2');
    expect(document.getElementById('font-color-hex').textContent).toBe('#00FF00');
    expect(document.getElementById('bg-opacity-val').textContent).toBe('80%');
    expect(document.getElementById('pos-bottom-val').textContent).toBe('100px');
    expect(preview.style.fontSize).toBe('2.2em');

    jest.advanceTimersByTime(500);
    await flushAsync();
    expect(chrome.storage.local.store.yousub_appearance).toEqual({
      fontSize: 2.2,
      fontColor: '#00ff00',
      bgOpacity: 0.8,
      posBottom: 100,
      showStagePill: false,
      showDesktopFab: true,
    });
  });

  test('tab-translation.js manages API keys, auto-detect, test responses with quota, and backup limits', async () => {
    jest.useFakeTimers();
    await mountOptions({ targetLang: 'en' });

    const alertEl = document.getElementById('no-keys-alert');
    expect(alertEl.classList.contains('hidden')).toBe(false);

    // Primary row: paste OpenAI key -> auto-detects provider
    const row = document.querySelector('.api-key-row[data-index="0"]');
    const apiInput = row.querySelector('.api-key-input');
    const providerSelect = row.querySelector('.provider-select');
    const modelInput = row.querySelector('.model-select');
    const testBtn = row.querySelector('.test-key-btn');
    const visBtn = row.querySelector('.toggle-visibility-btn');

    // Empty key test
    testBtn.click();
    expect(row.querySelector('.status-text').textContent).toBe('Failed: Empty API Key');

    // Paste key -> auto-detect openai
    apiInput.value = 'sk-proj-testkey123456';
    apiInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(providerSelect.value).toBe('openai');
    expect(alertEl.classList.contains('hidden')).toBe(true);

    // Toggle visibility
    visBtn.click();
    expect(apiInput.type).toBe('text');
    visBtn.click();
    expect(apiInput.type).toBe('password');

    // Type custom model + test success with quota + rateLimit
    modelInput.value = 'my-custom-model';
    modelInput.dispatchEvent(new Event('input', { bubbles: true }));
    chrome.runtime.sendMessage.mockResolvedValueOnce({
      success: true,
      usage: { totalTokens: 42 },
      rateLimit: {
        limitTokens: 10000,
        remainingTokens: 5000,
        limitRequests: 100,
        remainingRequests: 90,
      },
      quota: { currency: 'USD', credits: { used: 1.5, limit: 10 } },
    });
    testBtn.click();
    await flushAsync();
    expect(row.querySelector('.status-text').textContent).toContain('OK');
    expect(row.querySelector('.quota-detail').textContent).toContain('Credits: $1.50/$10.00');

    jest.advanceTimersByTime(500);
    await flushAsync();
    expect(chrome.storage.local.store.yousub_custom_models.openai).toContain('my-custom-model');

    // Delete custom model via confirm modal
    row.querySelector('.delete-custom-model-btn').click();
    document.getElementById('modal-confirm-btn').click();
    await flushAsync();
    expect(modelInput.value).toBe('auto');

    // Disable / enable row
    row.querySelector('.toggle-disable-row-btn').click();
    expect(row.style.opacity).toBe('0.5');
    row.querySelector('.toggle-disable-row-btn').click();
    expect(row.style.opacity).toBe('1');

    // Add backups up to 4 max (hides + Add Backup Key)
    const addBtn = document.getElementById('add-backup-btn');
    addBtn.click();
    addBtn.click();
    addBtn.click();
    expect(document.querySelectorAll('.api-key-row')).toHaveLength(4);
    expect(addBtn.classList.contains('hidden')).toBe(true);

    // Delete backup key #1
    document.querySelector('.api-key-row[data-index="1"] .delete-row-btn').click();
    document.getElementById('modal-confirm-btn').click();
    expect(document.querySelectorAll('.api-key-row')).toHaveLength(3);
  });

  test('tab-translation.js handles Ollama permissions/models, health stats reset, clear cache, and delete all', async () => {
    jest.useFakeTimers();
    await mountOptions({
      yousub_api_keys: [
        {
          provider: 'ollama',
          model: 'auto',
          apiKey: 'oll',
          status: 'failed',
          statusMessage: 'timeout',
        },
      ],
      yousub_health_stats: {
        ollama_oll: { successCount: 8, failCount: 2, avgTime: 120, circuitBreakerUntil: 0 },
      },
    });

    const row = document.querySelector('.api-key-row[data-index="0"]');
    expect(row.querySelector('.health-indicator').classList.contains('hidden')).toBe(false);
    expect(row.querySelector('.health-stats').textContent).toContain('Success: 80%');

    // Connect Ollama & fetch models
    row.querySelector('.connect-ollama-btn').click();
    await flushAsync();
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['http://localhost/*'] });

    chrome.runtime.sendMessage.mockResolvedValueOnce({
      success: true,
      models: [{ name: 'llama3.2' }],
    });
    row.querySelector('.fetch-ollama-models-btn').click();
    await flushAsync();
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('1 local models'));

    // Reset health stats
    row.querySelector('.reset-row-btn').click();
    await flushAsync();
    expect(chrome.storage.local.store.yousub_health_stats.ollama_oll).toBeUndefined();

    // Clear translation cache
    chrome.runtime.sendMessage.mockResolvedValueOnce({ success: true, count: 7 });
    document.getElementById('clear-cache-btn').click();
    document.getElementById('modal-confirm-btn').click();
    await flushAsync();
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('7 entries'));

    // Real-time storage.onChanged health update
    chrome.storage.local.store.yousub_api_keys = [
      { provider: 'openai', model: 'm1', apiKey: 'sk-123456', status: 'ok' },
    ];
    chrome.storage.local.store.yousub_health_stats = {
      openai_123456: { successCount: 95, failCount: 5, avgTime: 100, circuitBreakerUntil: 0 },
    };
    const onChanged = chrome.storage.onChanged._listeners[0];
    onChanged(
      { yousub_health_stats: { newValue: chrome.storage.local.store.yousub_health_stats } },
      'local'
    );
    await flushAsync();
    expect(
      document
        .querySelector('.api-key-row[data-index="0"] .health-indicator')
        .classList.contains('good')
    ).toBe(true);

    // Delete all keys
    document.getElementById('delete-all-keys-btn').click();
    document.getElementById('modal-confirm-btn').click();
    expect(document.querySelectorAll('.api-key-row')).toHaveLength(1);
  });

  test('tab-translation.js persists Gemini video fallback checkbox setting', async () => {
    jest.useFakeTimers();
    await mountOptions({ yousub_gemini_fallback_enabled: false });

    const cb = document.getElementById('gemini-video-fallback');
    expect(cb.checked).toBe(false);

    cb.checked = true;
    cb.dispatchEvent(new window.Event('change', { bubbles: true }));
    jest.advanceTimersByTime(600);
    await flushAsync();

    expect(chrome.storage.local.store.yousub_gemini_fallback_enabled).toBe(true);
  });

  test('tab-translation.js catches YOUSUB_CLEAR_CACHE rejection gracefully', async () => {
    await mountOptions();
    chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('Channel closed'));

    document.getElementById('clear-cache-btn').click();
    document.getElementById('modal-confirm-btn').click();
    await flushAsync();
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Channel closed'));
  });

  test('tab-translation.js persists Smart Auto-Enable activation mode and skip music toggle (Phase 89)', async () => {
    jest.useFakeTimers();
    await mountOptions();

    const modeSel = document.getElementById('activation-mode');
    const skipMusicCb = document.getElementById('skip-music-videos');
    expect(modeSel.value).toBe('manual');
    expect(skipMusicCb.checked).toBe(true);

    modeSel.value = 'smart_auto';
    modeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    skipMusicCb.checked = false;
    skipMusicCb.dispatchEvent(new window.Event('change', { bubbles: true }));
    jest.advanceTimersByTime(600);
    await flushAsync();

    expect(chrome.storage.local.store.yousub_activation_mode).toBe('smart_auto');
    expect(chrome.storage.local.store.yousub_skip_music_videos).toBe(false);
  });

  test('tab-translation.js persists style preset, custom prompt visibility, and glossary rules (Phase 90)', async () => {
    jest.useFakeTimers();
    await mountOptions();

    const styleSel = document.getElementById('translation-style');
    const promptGroup = document.getElementById('custom-prompt-group');
    const promptInput = document.getElementById('custom-prompt-input');
    const keepInput = document.getElementById('glossary-keep-terms');
    const pairsInput = document.getElementById('glossary-pairs');
    const pronounInput = document.getElementById('glossary-pronoun-rule');

    expect(styleSel.value).toBe('natural');
    expect(promptGroup.classList.contains('hidden')).toBe(true);

    styleSel.value = 'custom';
    styleSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(promptGroup.classList.contains('hidden')).toBe(false);

    promptInput.value = 'Keep tone formal and crisp.';
    promptInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    keepInput.value = 'YouSub, Vitest';
    keepInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    pairsInput.value = 'worker => tiến trình nền';
    pairsInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    pronounInput.value = 'Speaker uses tôi / các bạn';
    pronounInput.dispatchEvent(new window.Event('input', { bubbles: true }));

    jest.advanceTimersByTime(600);
    await flushAsync();

    expect(chrome.storage.local.store.yousub_translation_style).toBe('custom');
    expect(chrome.storage.local.store.yousub_custom_prompt).toBe('Keep tone formal and crisp.');
    expect(chrome.storage.local.store.yousub_custom_glossary).toEqual({
      keepTermsText: 'YouSub, Vitest',
      glossaryPairsText: 'worker => tiến trình nền',
      pronounRule: 'Speaker uses tôi / các bạn',
    });
  });

  test('tab-translation.js powers 30s Onboarding Wizard and local Cache Savings Dashboard (Phase 91)', async () => {
    await mountOptions({
      yousub_api_keys: [],
      yousub_usage_stats_v1: {
        videosTranslated: 5,
        cacheHits: 3,
        apiRuns: 2,
        apiBatches: 6,
        tokensUsed: 4200,
        estimatedTokensSaved: 9800,
        estimatedRequestsSaved: 4,
      },
    });

    const card = document.getElementById('onboarding-wizard-card');
    const keyInput = document.getElementById('onboarding-key-input');
    const detectedEl = document.getElementById('onboarding-detected-provider');
    const testSaveBtn = document.getElementById('onboarding-test-save-btn');
    const statusEl = document.getElementById('onboarding-status');

    // Wizard auto-shown when no keys exist
    expect(card.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('usage-videos-count').textContent).toBe('5');
    expect(document.getElementById('usage-cache-hits').textContent).toBe('3');
    expect(document.getElementById('usage-tokens-saved').textContent).toContain('9');

    // Auto-detects Groq key on input
    keyInput.value = 'gsk_test_onboarding_key_999';
    keyInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(detectedEl.textContent).toContain('Groq');

    // Empty check guard
    const savedVal = keyInput.value;
    keyInput.value = '';
    testSaveBtn.click();
    expect(statusEl.textContent).toContain('paste an API key');
    keyInput.value = savedVal;

    // 1-click Test & Activate persists valid key and hides wizard
    chrome.runtime.sendMessage.mockResolvedValueOnce({ success: true });
    testSaveBtn.click();
    await flushAsync(8);

    expect(chrome.storage.local.store.yousub_api_keys[0]).toMatchObject({
      provider: 'groq',
      apiKey: 'gsk_test_onboarding_key_999',
      status: 'ok',
    });
    expect(chrome.storage.local.store.yousub_onboarding_dismissed).toBe(true);
    expect(card.classList.contains('hidden')).toBe(true);

    // Reopen wizard via Setup Guide button & dismiss
    document.getElementById('open-onboarding-btn').click();
    expect(card.classList.contains('hidden')).toBe(false);
    document.getElementById('onboarding-dismiss-btn').click();
    expect(card.classList.contains('hidden')).toBe(true);

    // Reset local usage stats via modal confirm
    document.getElementById('reset-usage-stats-btn').click();
    document.getElementById('modal-confirm-btn').click();
    await flushAsync(8);
    expect(document.getElementById('usage-cache-hits').textContent).toBe('0');
    expect(document.getElementById('usage-tokens-saved').textContent).toBe('0');
  });
});
