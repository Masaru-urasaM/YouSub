import '../shared/libs/browser-polyfill.js';

const MAX_LOGS = 1000;

export const Logger = {
  log(level, tag, msg, data = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level: level,
      tag: tag,
      msg: msg,
      ...data
    };
    
    // Print to console for human developer / LLM review
    const output = JSON.stringify(entry);
    if (level === 'ERROR') {
      console.error(output);
    } else if (level === 'WARN') {
      console.warn(output);
    } else {
      console.log(output);
    }

    // Attempt to buffer to storage
    this._persist(output);
  },

  info(tag, msg, data) { this.log('INFO', tag, msg, data); },
  warn(tag, msg, data) { this.log('WARN', tag, msg, data); },
  error(tag, msg, data) { this.log('ERROR', tag, msg, data); },
  debug(tag, msg, data) { this.log('DEBUG', tag, msg, data); },

  _persist(jsonStr) {
    const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    if (api && api.storage && api.storage.local) {
      api.storage.local.get(['yousub_logs']).then(function(res) {
        let logs = res.yousub_logs || [];
        logs.push(jsonStr);
        if (logs.length > MAX_LOGS) {
          logs.shift(); // Keep bounded
        }
        api.storage.local.set({ yousub_logs: logs });
      }).catch(() => {
        // Silently fail if storage is restricted
      });
    }
  }
};
