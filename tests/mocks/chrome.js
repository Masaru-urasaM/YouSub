import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Load the English locale catalog so chrome.i18n.getMessage returns real text
 * in jsdom. Wrapped in try/catch: a path mistake degrades to an empty catalog
 * (key-fallback) instead of wiping out every test suite at setup time.
 */
let I18N_MESSAGES = {};
try {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const localePath = path.resolve(__dirname, '../../_locales/en/messages.json');
  I18N_MESSAGES = JSON.parse(fs.readFileSync(localePath, 'utf8'));
} catch {
  I18N_MESSAGES = {};
}

/**
 * Mock Chrome Extension APIs for Jest tests.
 */
global.chrome = {
  i18n: {
    // Mirrors browser.i18n.getMessage: returns the catalog entry's `message`
    // (with $N$ / $1 substitutions applied) or the key itself when missing.
    getMessage: jest.fn((key, substitutions) => {
      const entry = I18N_MESSAGES[key];
      if (!entry || typeof entry.message !== 'string') return '';
      let msg = entry.message;
      const subs = Array.isArray(substitutions)
        ? substitutions
        : substitutions !== undefined
          ? [substitutions]
          : [];
      // Named placeholders: $NAME$ -> resolves via `placeholders` -> $1..$9
      if (entry.placeholders) {
        Object.keys(entry.placeholders).forEach((name) => {
          const content = entry.placeholders[name].content || '';
          const idxMatch = content.match(/^\$(\d+)$/);
          const value = idxMatch ? (subs[Number(idxMatch[1]) - 1] ?? '') : content;
          msg = msg.replace(new RegExp(`\\$${name}\\$`, 'gi'), value);
        });
      }
      // Positional placeholders: $1..$9
      msg = msg.replace(/\$(\d)/g, (_m, d) => subs[Number(d) - 1] ?? '');
      return msg;
    }),
    getUILanguage: jest.fn(() => 'en'),
  },
  // ... existing chrome mock ...
  storage: {
    session: {
      get: jest.fn((keys, callback) => {
        const result = {};
        if (typeof keys === 'string') {
          result[keys] = global.chrome.storage.session.store[keys];
        } else if (Array.isArray(keys)) {
          keys.forEach((k) => (result[k] = global.chrome.storage.session.store[k]));
        } else if (keys === null) {
          Object.assign(result, global.chrome.storage.session.store);
        }
        if (callback) callback(result);
        return Promise.resolve(result);
      }),
      set: jest.fn((items, callback) => {
        Object.assign(global.chrome.storage.session.store, items);
        if (callback) callback();
        return Promise.resolve();
      }),
      remove: jest.fn((keys, callback) => {
        if (typeof keys === 'string') {
          delete global.chrome.storage.session.store[keys];
        } else if (Array.isArray(keys)) {
          keys.forEach((k) => delete global.chrome.storage.session.store[k]);
        }
        if (callback) callback();
        return Promise.resolve();
      }),
      clear: jest.fn((callback) => {
        global.chrome.storage.session.store = {};
        if (callback) callback();
        return Promise.resolve();
      }),
      store: {},
    },
    local: {
      get: jest.fn((keys, callback) => {
        const result = {};
        if (typeof keys === 'string') {
          result[keys] = global.chrome.storage.local.store[keys];
        } else if (Array.isArray(keys)) {
          keys.forEach((k) => (result[k] = global.chrome.storage.local.store[k]));
        } else if (keys === null) {
          Object.assign(result, global.chrome.storage.local.store);
        }
        if (callback) callback(result);
        return Promise.resolve(result);
      }),
      set: jest.fn((items, callback) => {
        Object.assign(global.chrome.storage.local.store, items);
        if (callback) callback();
        return Promise.resolve();
      }),
      remove: jest.fn((keys, callback) => {
        if (typeof keys === 'string') {
          delete global.chrome.storage.local.store[keys];
        } else if (Array.isArray(keys)) {
          keys.forEach((k) => delete global.chrome.storage.local.store[k]);
        }
        if (callback) callback();
        return Promise.resolve();
      }),
      clear: jest.fn((callback) => {
        global.chrome.storage.local.store = {};
        if (callback) callback();
        return Promise.resolve();
      }),
      store: {}, // Internal store for testing
      onChanged: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
      },
    },
    // WebExtensions also exposes change events at the storage level
    // (chrome.storage.onChanged) — src/content/overlay.js subscribes here.
    onChanged: {
      _listeners: [],
      addListener: jest.fn((fn) => {
        global.chrome.storage.onChanged._listeners.push(fn);
      }),
      removeListener: jest.fn((fn) => {
        const list = global.chrome.storage.onChanged._listeners;
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }),
    },
  },
  permissions: {
    contains: jest.fn(() => Promise.resolve(false)),
    request: jest.fn(() => Promise.resolve(true)),
  },
  runtime: {
    id: 'mock-extension-id',
    sendMessage: jest.fn((message, callback) => {
      if (callback) callback({ success: true });
      return Promise.resolve({ success: true });
    }),
    connect: jest.fn(({ name } = {}) => ({
      name: name || '',
      postMessage: jest.fn(),
      disconnect: jest.fn(),
      onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
      onDisconnect: { addListener: jest.fn(), removeListener: jest.fn() },
    })),
    onConnect: {
      _listeners: [],
      addListener: jest.fn((fn) => {
        global.chrome.runtime.onConnect._listeners.push(fn);
      }),
      removeListener: jest.fn((fn) => {
        const list = global.chrome.runtime.onConnect._listeners;
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }),
    },
    onMessage: {
      _listeners: [],
      addListener: jest.fn((fn) => {
        global.chrome.runtime.onMessage._listeners.push(fn);
      }),
      removeListener: jest.fn((fn) => {
        const list = global.chrome.runtime.onMessage._listeners;
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }),
    },
    openOptionsPage: jest.fn(),
    getURL: jest.fn((path) => `chrome-extension://mock-id/${path}`),
    lastError: null,
  },
  tabs: {
    query: jest.fn(() => Promise.resolve([{ id: 1, url: 'https://youtube.com/watch?v=123' }])),
    create: jest.fn(() => Promise.resolve({ id: 2 })),
    sendMessage: jest.fn(() => Promise.resolve()),
  },
};

// Silence expected SUT console noise during unit runs so real Jest failures
// stand out cleanly (Rule 6 machine-readable output). Override with
// YOUSUB_TEST_VERBOSE_CONSOLE=1 when debugging a specific suite.
if (!process.env.YOUSUB_TEST_VERBOSE_CONSOLE) {
  console.log = jest.fn();
  console.warn = jest.fn();
  console.error = jest.fn();
  console.info = jest.fn();
  console.debug = jest.fn();
  console.group = jest.fn();
  console.groupEnd = jest.fn();
}

// Unified API for cross-browser support
global.browser = global.chrome;
