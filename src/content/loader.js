// src/content/loader.js — YouSub Dynamic Module Loader
// This script acts as a bridge to load ESM content scripts in Manifest V3.

(async () => {
    try {
        // Use browser-polyfill for the loader itself if needed
        const polyfillUrl = typeof browser === 'undefined' ? chrome.runtime.getURL('src/shared/libs/browser-polyfill.js') : null;
        if (polyfillUrl) {
            // We can't easily 'import' a non-module polyfill here, 
            // but the loader only needs chrome.runtime.getURL.
        }

        const mainModuleUrl = chrome.runtime.getURL('src/content/main.js') + '?v=' + Date.now();
        if (typeof YouSub === 'undefined' || !YouSub.Constants || !YouSub.Constants.IS_PRODUCTION) console.log('[YouSub] Loader: Loading main module (cache-busted)...', mainModuleUrl);
        
        await import(mainModuleUrl);
        
        if (typeof YouSub === 'undefined' || !YouSub.Constants || !YouSub.Constants.IS_PRODUCTION) console.log('[YouSub] Loader: Main module loaded successfully.');
    } catch (err) {
        console.error('[YouSub] Loader: Failed to load modules.', err);
    }
})();
