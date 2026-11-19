import '../shared/libs/browser-polyfill.js';
import { Constants } from './constants.js';

const MAX_SESSION_LOGS = 10000;
const MAX_ERROR_LOGS = 200;
const FLUSH_INTERVAL_MS = 5000;

const STORAGE_KEY_SESSION = 'yousub_session_logs';
const STORAGE_KEY_ERRORS = 'yousub_error_logs';

export const Logger = {
  _buffer: [],
  _errorBuffer: [],
  _flushTimer: null,
  _flushInProgress: false,
  _swRelayCursor: 0,

  log(level, tag, msg, data = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      tag,
      msg,
      ...data,
    };

    const isProd = Constants && Constants.IS_PRODUCTION;
    const output = JSON.stringify(entry);

    if (level === 'ERROR') {
      console.error(output);
    } else if (level === 'TRACE') {
      console.log(output);
    } else if (!isProd) {
      if (level === 'WARN') {
        console.warn(output);
      } else {
        console.log(output);
      }
    }

    this._bufferEntry(output, level);
  },

  info(tag, msg, data) {
    this.log('INFO', tag, msg, data);
  },
  warn(tag, msg, data) {
    this.log('WARN', tag, msg, data);
  },
  error(tag, msg, data) {
    this.log('ERROR', tag, msg, data);
  },
  debug(tag, msg, data) {
    this.log('DEBUG', tag, msg, data);
  },
  trace(tag, msg, data) {
    this.log('TRACE', tag, msg, data);
  },

  _bufferEntry(jsonStr, level) {
    this._buffer.push(jsonStr);
    if (this._buffer.length > MAX_SESSION_LOGS) {
      this._buffer.shift();
      if (this._swRelayCursor > 0) this._swRelayCursor--;
    }

    if (level === 'ERROR') {
      this._errorBuffer.push(jsonStr);
      if (this._errorBuffer.length > MAX_ERROR_LOGS) {
        this._errorBuffer.shift();
      }
    }

    this._scheduleFlush();
  },

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, FLUSH_INTERVAL_MS);
  },

  async _flush() {
    if (this._flushInProgress) return;
    this._flushInProgress = true;

    const api = this._getStorageApi();
    if (!api) {
      this._flushInProgress = false;
      return;
    }

    try {
      const sessionCopy = this._buffer.slice(-MAX_SESSION_LOGS);
      let sessionPersisted = false;
      if (api.session) {
        try {
          await api.session.set({ [STORAGE_KEY_SESSION]: sessionCopy });
          sessionPersisted = true;
        } catch {
          sessionPersisted = false;
        }
      }

      // Chrome MV3 content scripts cannot write chrome.storage.session directly;
      // relay unsent JSONL lines to the background service worker's session buffer.
      if (!sessionPersisted && this._swRelayCursor < this._buffer.length) {
        const pending = this._buffer.slice(this._swRelayCursor);
        const root =
          typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;
        if (root && root.runtime && typeof root.runtime.sendMessage === 'function') {
          this._swRelayCursor = this._buffer.length;
          try {
            await Promise.resolve(
              root.runtime.sendMessage({ type: 'YOUSUB_LOG_BATCH', entries: pending })
            );
          } catch {}
        }
      }

      if (this._errorBuffer.length > 0 && api.local) {
        const res = await api.local.get([STORAGE_KEY_ERRORS]);
        let existing = res[STORAGE_KEY_ERRORS] || [];
        existing = existing.concat(this._errorBuffer);
        if (existing.length > MAX_ERROR_LOGS) {
          existing = existing.slice(-MAX_ERROR_LOGS);
        }
        await api.local.set({ [STORAGE_KEY_ERRORS]: existing });
        this._errorBuffer = [];
      }
    } catch {
      // Silent fail — log persistence must never break the app
    }

    this._flushInProgress = false;
  },

  appendExternalEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    for (const item of entries) {
      if (typeof item !== 'string' || !item.trim()) continue;
      this._buffer.push(item);
      if (this._buffer.length > MAX_SESSION_LOGS) {
        this._buffer.shift();
      }
    }
    this._scheduleFlush();
  },

  _getStorageApi() {
    const root =
      typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;
    if (!root || !root.storage) return null;
    return {
      session: root.storage.session || null,
      local: root.storage.local || null,
    };
  },

  async tail(n = 50) {
    const logs = await this._readAllLogs();
    const sliced = logs.slice(-n);

    console.group(`YouSub Logs (Last ${n})`);
    sliced.forEach((l) => {
      try {
        const p = JSON.parse(l);
        const color =
          p.level === 'ERROR'
            ? '#ef4444'
            : p.level === 'WARN'
              ? '#f59e0b'
              : p.level === 'TRACE'
                ? '#06b6d4'
                : '#3b82f6';
        console.log(`%c[${p.level}] [${p.tag}] ${p.msg}`, `color: ${color}`, p);
      } catch {
        console.log(l);
      }
    });
    console.groupEnd();
  },

  async export() {
    const logs = await this._readAllLogs();
    if (logs.length === 0) {
      console.warn('[Logger] No logs to export');
      return null;
    }

    const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yousub_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return logs.length;
  },

  async _readAllLogs() {
    const api = this._getStorageApi();
    if (!api) return this._buffer.slice();

    let sessionLogs = [];
    let errorLogs = [];

    try {
      if (api.session) {
        const res = await api.session.get([STORAGE_KEY_SESSION]);
        sessionLogs = res[STORAGE_KEY_SESSION] || [];
      }
    } catch {}

    try {
      if (api.local) {
        const res = await api.local.get([STORAGE_KEY_ERRORS]);
        errorLogs = res[STORAGE_KEY_ERRORS] || [];
      }
    } catch {}

    if (sessionLogs.length > 0) return sessionLogs;
    if (errorLogs.length > 0) return errorLogs;
    return this._buffer.slice();
  },

  _internals: {
    MAX_SESSION_LOGS,
    MAX_ERROR_LOGS,
    FLUSH_INTERVAL_MS,
    STORAGE_KEY_SESSION,
    STORAGE_KEY_ERRORS,
  },
};

// Universal Attachment
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.Logger = Logger;
} else if (typeof self !== 'undefined') {
  self.YouSub_Logger = Logger;
}
