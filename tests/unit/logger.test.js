import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Must load mocks before logger
import '../mocks/chrome.js';

// Mock the browser-polyfill import (no-op in test)
jest.unstable_mockModule('../../src/shared/libs/browser-polyfill.js', () => ({}));

// Mock constants with IS_PRODUCTION: false
jest.unstable_mockModule('../../src/shared/constants.js', () => ({
  Constants: {
    APP_NAME: 'YouSub',
    VERSION: '0.2.0',
    IS_PRODUCTION: false,
  },
}));

const { Logger } = await import('../../src/shared/logger.js');

describe('Logger', () => {
  beforeEach(() => {
    Logger._buffer = [];
    Logger._errorBuffer = [];
    Logger._flushInProgress = false;
    Logger._swRelayCursor = 0;
    if (Logger._flushTimer) {
      clearTimeout(Logger._flushTimer);
      Logger._flushTimer = null;
    }
    global.chrome.storage.session.store = {};
    global.chrome.storage.local.store = {};
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (Logger._flushTimer) {
      clearTimeout(Logger._flushTimer);
      Logger._flushTimer = null;
    }
  });

  describe('In-memory buffering', () => {
    it('should buffer log entries in _buffer', () => {
      Logger.info('Test', 'hello');
      expect(Logger._buffer.length).toBe(1);
      const entry = JSON.parse(Logger._buffer[0]);
      expect(entry.level).toBe('INFO');
      expect(entry.tag).toBe('Test');
      expect(entry.msg).toBe('hello');
    });

    it('should enforce MAX_SESSION_LOGS ring buffer', () => {
      const max = Logger._internals.MAX_SESSION_LOGS;
      for (let i = 0; i < max + 50; i++) {
        Logger.info('Test', `msg-${i}`);
      }
      expect(Logger._buffer.length).toBe(max);
      const first = JSON.parse(Logger._buffer[0]);
      expect(first.msg).toBe('msg-50');
    });

    it('should buffer ERROR entries in both _buffer and _errorBuffer', () => {
      Logger.error('Test', 'fail');
      expect(Logger._buffer.length).toBe(1);
      expect(Logger._errorBuffer.length).toBe(1);
    });

    it('should enforce MAX_ERROR_LOGS on _errorBuffer', () => {
      const max = Logger._internals.MAX_ERROR_LOGS;
      for (let i = 0; i < max + 10; i++) {
        Logger.error('Test', `err-${i}`);
      }
      expect(Logger._errorBuffer.length).toBe(max);
      const first = JSON.parse(Logger._errorBuffer[0]);
      expect(first.msg).toBe('err-10');
    });

    it('should not buffer non-ERROR entries in _errorBuffer', () => {
      Logger.info('Test', 'info');
      Logger.warn('Test', 'warn');
      Logger.debug('Test', 'debug');
      Logger.trace('Test', 'trace');
      expect(Logger._errorBuffer.length).toBe(0);
    });
  });

  describe('Flush to storage', () => {
    it('should flush _buffer to storage.session', async () => {
      Logger.info('Test', 'msg1');
      Logger.info('Test', 'msg2');
      await Logger._flush();

      const key = Logger._internals.STORAGE_KEY_SESSION;
      const stored = global.chrome.storage.session.store[key];
      expect(stored).toBeDefined();
      expect(stored.length).toBe(2);
    });

    it('should flush _errorBuffer to storage.local and clear it', async () => {
      Logger.error('Test', 'err1');
      Logger.error('Test', 'err2');
      await Logger._flush();

      const key = Logger._internals.STORAGE_KEY_ERRORS;
      const stored = global.chrome.storage.local.store[key];
      expect(stored).toBeDefined();
      expect(stored.length).toBe(2);
      expect(Logger._errorBuffer.length).toBe(0);
    });

    it('should append to existing error logs in storage.local', async () => {
      const key = Logger._internals.STORAGE_KEY_ERRORS;
      global.chrome.storage.local.store[key] = ['{"existing":"error"}'];

      Logger.error('Test', 'new-err');
      await Logger._flush();

      const stored = global.chrome.storage.local.store[key];
      expect(stored.length).toBe(2);
    });

    it('should trim error logs to MAX_ERROR_LOGS', async () => {
      const key = Logger._internals.STORAGE_KEY_ERRORS;
      const max = Logger._internals.MAX_ERROR_LOGS;
      const existing = Array.from({ length: max }, (_, i) => `{"old":"${i}"}`);
      global.chrome.storage.local.store[key] = existing;

      Logger.error('Test', 'overflow');
      await Logger._flush();

      const stored = global.chrome.storage.local.store[key];
      expect(stored.length).toBe(max);
    });

    it('should prevent concurrent flushes', async () => {
      Logger._flushInProgress = true;
      Logger.info('Test', 'blocked');
      await Logger._flush();
      expect(global.chrome.storage.session.set).not.toHaveBeenCalled();
    });
  });

  describe('Log reading', () => {
    it('should read from session storage first via _readAllLogs', async () => {
      const key = Logger._internals.STORAGE_KEY_SESSION;
      global.chrome.storage.session.store[key] = ['{"level":"INFO","msg":"from-session"}'];

      const logs = await Logger._readAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('from-session');
    });

    it('should fall back to error logs if session is empty', async () => {
      const key = Logger._internals.STORAGE_KEY_ERRORS;
      global.chrome.storage.local.store[key] = ['{"level":"ERROR","msg":"from-local"}'];

      const logs = await Logger._readAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('from-local');
    });

    it('should fall back to in-memory buffer if storage is empty', async () => {
      Logger.info('Test', 'in-memory');
      const logs = await Logger._readAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('in-memory');
    });
  });

  describe('Log entry format', () => {
    it('should produce valid JSON entries with required fields', () => {
      Logger.info('MyTag', 'test message', { extra: 42 });
      const entry = JSON.parse(Logger._buffer[0]);
      expect(entry.ts).toBeDefined();
      expect(entry.level).toBe('INFO');
      expect(entry.tag).toBe('MyTag');
      expect(entry.msg).toBe('test message');
      expect(entry.extra).toBe(42);
    });

    it('should include ISO timestamp', () => {
      Logger.info('Test', 'ts-check');
      const entry = JSON.parse(Logger._buffer[0]);
      expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
    });
  });

  describe('Content-script relay & external log ingestion (Phase 84)', () => {
    it('relays buffered entries via YOUSUB_LOG_BATCH when storage.session throws or is absent', async () => {
      global.chrome.storage.session.set.mockRejectedValueOnce(new Error('No session access'));
      Logger.info('PlaybackResume', 'Relayed line');
      await Logger._flush();

      expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'YOUSUB_LOG_BATCH',
        entries: [expect.stringContaining('Relayed line')],
      });
    });

    it('appendExternalEntries merges incoming content logs into ring buffer', () => {
      Logger.appendExternalEntries([
        '{"ts":"2026-11-18T00:00:00Z","level":"INFO","tag":"X","msg":"ext"}',
        '',
      ]);
      expect(Logger._buffer).toHaveLength(1);
      expect(Logger._buffer[0]).toContain('"msg":"ext"');
    });
  });
});
