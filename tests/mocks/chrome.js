import { jest } from '@jest/globals';

/**
 * Mock Chrome Extension APIs for Jest tests.
 */
global.chrome = {
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
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  runtime: {
    id: 'mock-extension-id',
    sendMessage: jest.fn((message, callback) => {
      if (callback) callback({ success: true });
      return Promise.resolve({ success: true });
    }),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    openOptionsPage: jest.fn(),
    getURL: jest.fn((path) => `chrome-extension://mock-id/${path}`),
    lastError: null,
  },
  tabs: {
    query: jest.fn(() => Promise.resolve([{ id: 1, url: 'https://youtube.com/watch?v=123' }])),
    sendMessage: jest.fn(() => Promise.resolve()),
  },
};

// Unified API for cross-browser support
global.browser = global.chrome;
