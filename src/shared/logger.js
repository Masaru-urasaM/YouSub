import '../shared/libs/browser-polyfill.js';
import { Constants } from './constants.js';

const MAX_LOGS = 10000;

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
    // Only print INFO/WARN/DEBUG in non-production mode
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

    // Attempt to buffer to storage
    this._persist(output);
  },

  info(tag, msg, data) { this.log('INFO', tag, msg, data); },
  warn(tag, msg, data) { this.log('WARN', tag, msg, data); },
  error(tag, msg, data) { this.log('ERROR', tag, msg, data); },
  debug(tag, msg, data) { this.log('DEBUG', tag, msg, data); },
  trace(tag, msg, data) { this.log('TRACE', tag, msg, data); },

  async tail(n = 50) {
    const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    if (!api || !api.storage || !api.storage.local) return console.warn('Storage not available');

    const res = await api.storage.local.get(['yousub_logs']);
    const logs = res.yousub_logs || [];
    const sliced = logs.slice(-n);

    console.group(`YouSub Logs (Last ${n})`);
    sliced.forEach(l => {
      try {
        const p = JSON.parse(l);
        const color = p.level === 'ERROR' ? '#ef4444' : (p.level === 'WARN' ? '#f59e0b' : (p.level === 'TRACE' ? '#06b6d4' : '#3b82f6'));
        console.log(`%c[${p.level}] [${p.tag}] ${p.msg}`, `color: ${color}`, p);
      } catch (e) { console.log(l); }
    });
    console.groupEnd();
  },

  async export() {
    const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    if (!api || !api.storage || !api.storage.local) return alert('Storage not available');

    const res = await api.storage.local.get(['yousub_logs']);
    const logs = res.yousub_logs || [];
    const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `yousub_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  _persist(jsonStr) {
    // Phase 52: Performance Overhaul. 
    // We strictly DISABLE storage persistence during translation to prevent I/O deadlocks.
    // Logs are still available in the REAL-TIME Service Worker Console.
    return; 
    
    /* 
    const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    if (api && api.storage && api.storage.local) {
      api.storage.local.get(['yousub_logs']).then(function(res) {
        let logs = res.yousub_logs || [];
        logs.push(jsonStr);
        if (logs.length > MAX_LOGS) {
          logs.shift(); 
        }
        api.storage.local.set({ yousub_logs: logs });
      }).catch(() => {});
    }
    */
  }
};

// Universal Attachment
if (typeof window !== 'undefined') {
  window.YouSub = window.YouSub || {};
  window.YouSub.Logger = Logger;
} else if (typeof self !== 'undefined') {
  self.YouSub_Logger = Logger;
}
