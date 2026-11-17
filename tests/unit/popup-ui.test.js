import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POPUP_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/popup/popup.html'), 'utf8');

const flushAsync = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

async function mountPopup(
  storageSeed = {},
  {
    tabUrl = 'https://www.youtube.com/watch?v=abc123',
    tabTitle = 'Demo Video - YouTube',
    stateRes = null,
    healthRes = null,
  } = {}
) {
  jest.resetModules();
  chrome.storage.local.store = { ...storageSeed };
  chrome.storage.onChanged._listeners.length = 0;

  chrome.tabs.query.mockResolvedValue([{ id: 1, url: tabUrl, title: tabTitle }]);
  chrome.tabs.sendMessage.mockImplementation(async (_id, msg) => {
    if (msg.type === 'YOUSUB_GET_STATE') return stateRes;
    return { success: true };
  });
  chrome.runtime.sendMessage.mockImplementation(async (msg) => {
    if (msg.type === 'YOUSUB_GET_HEALTH_SUMMARY') {
      if (healthRes instanceof Error) throw healthRes;
      return healthRes || { success: true, summary: [] };
    }
    if (msg.type === 'YOUSUB_CLEAR_VIDEO_CACHE') return { success: true };
    return { success: true };
  });

  const parsed = new DOMParser().parseFromString(POPUP_HTML, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;

  let readyCb;
  const spy = jest.spyOn(document, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'DOMContentLoaded') readyCb = fn;
  });
  await import('../../src/popup/popup.js');
  spy.mockRestore();

  readyCb();
  await flushAsync(8);
}

describe('popup.js UI & interactions (T10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('populates languages without auto, shows API Not Configured when empty, and syncs tab state', async () => {
    await mountPopup(
      { targetLang: 'ja', yousub_api_keys: [], yousub_dual_mode: false },
      { stateRes: { isTranslationActive: true, isDualMode: true } }
    );

    const langSelect = document.getElementById('lang-selector');
    const optionVals = [...langSelect.options].map((o) => o.value);
    expect(optionVals).not.toContain('auto');
    expect(optionVals).toContain('vi');
    expect(langSelect.value).toBe('ja');

    expect(document.getElementById('health-text').textContent).toBe('API Not Configured');
    expect(document.getElementById('get-sub-btn').textContent).toContain('JAPANESE');
    expect(document.getElementById('get-sub-btn').classList.contains('active')).toBe(true);
    expect(document.getElementById('dual-mode-toggle').checked).toBe(true);
    expect(document.getElementById('clear-page-cache-btn').classList.contains('hidden')).toBe(
      false
    );
  });

  test('renders health summary states: healthy, poor, broken, all-disabled, and cache fallback', async () => {
    // Healthy
    await mountPopup(
      { yousub_api_keys: [{ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k1' }] },
      {
        healthRes: {
          success: true,
          summary: [{ provider: 'openai', model: 'gpt-4o-mini', status: 'healthy' }],
        },
      }
    );
    expect(document.getElementById('health-text').textContent).toContain('Online');

    // Poor
    await mountPopup(
      { yousub_api_keys: [{ provider: 'openai', model: 'm1', apiKey: 'k1' }] },
      {
        healthRes: {
          success: true,
          summary: [{ provider: 'openai', model: 'm1', status: 'poor' }],
        },
      }
    );
    expect(document.getElementById('health-text').textContent).toBe(
      'Service Degradation (Poor Latency)'
    );

    // Broken
    await mountPopup(
      { yousub_api_keys: [{ provider: 'openai', model: 'm1', apiKey: 'k1' }] },
      {
        healthRes: {
          success: true,
          summary: [{ provider: 'openai', model: 'm1', status: 'broken' }],
        },
      }
    );
    expect(document.getElementById('health-text').textContent).toBe('API Error (Circuit Open)');

    // All disabled
    await mountPopup({ yousub_api_keys: [{ provider: 'openai', apiKey: 'k1', disabled: true }] });
    expect(document.getElementById('health-text').textContent).toBe('All API Keys Disabled');

    // Health IPC error fallback
    await mountPopup(
      { yousub_api_keys: [{ provider: 'openai', apiKey: 'k1', status: 'success' }] },
      { healthRes: new Error('bg down') }
    );
    expect(document.getElementById('health-text').textContent).toBe('Service Ready (Cache Mode)');
  });

  test('loads execution stats for Shorts (cache & api modes)', async () => {
    // API stats on Shorts URL
    await mountPopup(
      {
        yousub_stats_sh123: {
          source: 'api',
          model: 'gpt-4o',
          batchCount: 3,
          durationMs: 2500,
          promptTokens: 1200,
          completionTokens: 450,
        },
      },
      { tabUrl: 'https://www.youtube.com/shorts/sh123', tabTitle: 'Short Clip - YouTube' }
    );
    expect(document.getElementById('execution-stats').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('stats-title-text').textContent).toBe(
      'Last Execution: Short Clip'
    );
    expect(document.getElementById('stats-source-badge').textContent).toBe('API');
    expect(document.getElementById('stats-model-name').textContent).toBe('gpt-4o');
    expect(document.getElementById('stats-requests').textContent).toBe('3');
    expect(document.getElementById('stats-duration').textContent).toBe('2.5s');

    // Cache stats
    await mountPopup(
      { yousub_stats_sh123: { source: 'cache' } },
      { tabUrl: 'https://www.youtube.com/shorts/sh123' }
    );
    expect(document.getElementById('stats-source-badge').textContent).toBe('Cache');
    expect(document.getElementById('stats-model-name').textContent).toBe('Loaded from memory');
    expect(document.getElementById('stats-requests').textContent).toBe('--');
  });

  test('handles language change, toggle buttons, settings/debug buttons, and storage sync', async () => {
    await mountPopup({ targetLang: 'vi' });

    const langSelect = document.getElementById('lang-selector');
    langSelect.value = 'fr';
    langSelect.dispatchEvent(new Event('change'));
    expect(chrome.storage.local.store.targetLang).toBe('fr');
    expect(document.getElementById('get-sub-btn').textContent).toContain('FRENCH');

    document.getElementById('get-sub-btn').click();
    await flushAsync();
    expect(chrome.storage.local.store.yousub_translation_enabled).toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, {
      type: 'YOUSUB_TOGGLE_TRANSLATION',
      enabled: true,
      targetLang: 'fr',
    });

    const dual = document.getElementById('dual-mode-toggle');
    dual.checked = true;
    dual.dispatchEvent(new Event('change'));
    await flushAsync();
    expect(chrome.storage.local.store.yousub_dual_mode).toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, {
      type: 'YOUSUB_TOGGLE_DUAL_MODE',
      enabled: true,
    });

    document.getElementById('open-settings-btn').click();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();

    document.getElementById('open-debug-btn').click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://mock-id/src/debug/debug.html',
    });

    // Live storage sync from Options
    const onChanged = chrome.storage.onChanged._listeners[0];
    onChanged({ targetLang: { newValue: 'es' } }, 'local');
    expect(document.getElementById('get-sub-btn').textContent).toContain('SPANISH');
  });

  test('clear-page-cache modal supports Escape close and Confirm clear flow', async () => {
    jest.useFakeTimers();
    await mountPopup({ yousub_stats_abc123: { source: 'cache' } });

    const clearBtn = document.getElementById('clear-page-cache-btn');
    const modal = document.getElementById('confirm-modal');

    clearBtn.click();
    await flushAsync();
    expect(modal.classList.contains('hidden')).toBe(false);

    // Escape closes without clearing
    modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'YOUSUB_CLEAR_VIDEO_CACHE' })
    );

    // Confirm clears cache and updates UI
    clearBtn.click();
    await flushAsync();
    document.getElementById('modal-confirm-btn').click();
    await flushAsync(6);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'YOUSUB_CLEAR_VIDEO_CACHE',
      videoId: 'abc123',
    });
    expect(clearBtn.textContent).toBe('Cache Cleared!');
    jest.advanceTimersByTime(2000);
    expect(clearBtn.disabled).toBe(false);
    expect(clearBtn.textContent).toBe('Clear Page Cache');
  });
});
