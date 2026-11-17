import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/debug/debug.html'), 'utf8');

const flushAsync = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

async function mountDebug(logs = []) {
  jest.resetModules();
  chrome.storage.local.store = { yousub_debug_history: logs };
  const parsed = new DOMParser().parseFromString(DEBUG_HTML, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;

  let readyCb;
  const spy = jest.spyOn(document, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'DOMContentLoaded') readyCb = fn;
  });
  await import('../../src/debug/debug.js');
  spy.mockRestore();

  await readyCb();
  await flushAsync(6);
}

describe('debug.js UI (T10)', () => {
  const origClipboard = navigator.clipboard;
  const origConfirm = window.confirm;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn(() => Promise.resolve()) },
    });
    window.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: origClipboard });
    window.confirm = origConfirm;
  });

  test('renders empty state when no logs are stored', async () => {
    await mountDebug([]);
    expect(document.getElementById('debug-list').textContent).toContain('No batches recorded yet');
    document.getElementById('copy-all-btn').click();
    await flushAsync();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  test('renders batch cards with escaped HTML, supports copy, copy-all, refresh, and clear', async () => {
    jest.useFakeTimers();
    await mountDebug([
      {
        timestamp: 1700000000000,
        provider: 'openai',
        model: 'gpt-4o-mini',
        duration: '250ms',
        success: true,
        input: '<script>in</script>',
        output: '<b>out</b>',
        systemPrompt: 'sys & prompt',
      },
      {
        timestamp: 1700000005000,
        provider: 'groq',
        model: 'llama',
        success: false,
        input: '',
        output: '',
        systemPrompt: '',
      },
    ]);

    const cards = document.querySelectorAll('.batch-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.status-badge').textContent.trim()).toBe('SUCCESS');
    expect(cards[1].querySelector('.status-badge.failed').textContent.trim()).toBe('FAILED');
    expect(document.getElementById('debug-list').querySelector('script')).toBeNull(); // HTML-escaped

    // Per-card copy button
    const firstCopyBtn = cards[0].querySelector('.copy-btn');
    firstCopyBtn.click();
    await flushAsync();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('<script>in</script>');
    expect(firstCopyBtn.textContent).toBe('Copied!');
    await jest.advanceTimersByTimeAsync(2000);
    expect(firstCopyBtn.textContent).toBe('Copy');

    // Copy All button
    const copyAllBtn = document.getElementById('copy-all-btn');
    copyAllBtn.click();
    await flushAsync();
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      expect.stringContaining('=== YouSub Batch Debug Log ===')
    );
    expect(copyAllBtn.textContent).toBe('Copied!');
    await jest.advanceTimersByTimeAsync(2000);
    expect(copyAllBtn.textContent).toBe('Copy All');

    // Refresh
    chrome.storage.local.store.yousub_debug_history = [
      {
        timestamp: 1700000010000,
        provider: 'gemini',
        model: 'flash',
        success: true,
        input: 'refreshed',
        output: 'ok',
        systemPrompt: 'sys',
      },
    ];
    document.getElementById('refresh-debug-btn').click();
    await flushAsync();
    expect(document.querySelectorAll('.batch-card')).toHaveLength(1);

    // Clear Logs
    document.getElementById('clear-debug-btn').click();
    await flushAsync();
    expect(chrome.storage.local.store.yousub_debug_history).toBeUndefined();
    expect(document.getElementById('debug-list').textContent).toContain('No batches recorded yet');
  });
});
