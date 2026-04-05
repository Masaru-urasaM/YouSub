import '../shared/libs/browser-polyfill.js';
import { Logger } from '../shared/logger.js';
import { HealthManager } from './health.js';

/**
 * api-manager.js
 * Manages the lifecycle and healthy of configured API keys.
 */
export const APIManager = {
  /**
   * Loads all healthy API keys from storage.
   * Filters out keys that are in a circuit-breaker cooldown.
   * Sorts backups by health score.
   * @returns {Promise<Array>} Array of key objects.
   */
  async getValidKeys() {
    return new Promise(async (resolve) => {
      browser.storage.local.get(['yousub_api_keys', 'yousub_failover_enabled']).then(async (res) => {
        const keys = res.yousub_api_keys || [];
        const failoverEnabled = res.yousub_failover_enabled !== false;

        // Filter out keys that are empty
        const configKeys = keys.filter(k => k.apiKey && k.apiKey.trim().length > 0);
        
        if (configKeys.length === 0) return resolve([]);

        // Filter by circuit breaker
        const activeKeys = [];
        for (const k of configKeys) {
          const isOpen = await HealthManager.isCircuitOpen(k.provider, k.apiKey);
          if (!isOpen) {
            activeKeys.push(k);
          } else {
            Logger.warn('APIManager', `Skipping ${k.provider} (Circuit Open)`);
          }
        }

        if (activeKeys.length <= 1 || !failoverEnabled) {
          return resolve(activeKeys.slice(0, 1));
        }

        // If failover is enabled, sort Backups by health score
        const primary = activeKeys[0];
        const backups = activeKeys.slice(1);

        // Map scores
        const scoredBackups = await Promise.all(backups.map(async (bk) => {
          const score = await HealthManager.getScore(bk.provider, bk.apiKey);
          return { key: bk, score };
        }));

        // Sort backups: highest score first
        scoredBackups.sort((a, b) => b.score - a.score);

        const sorted = [primary, ...scoredBackups.map(sb => sb.key)];
        Logger.debug('APIManager', `Loaded ${sorted.length} keys in priority order.`);
        resolve(sorted);
      });
    });
  },

  /**
   * Marks a specific key as failed in storage so it won't be picked immediately next time.
   */
  async markKeyFailed(providerId, apiKey, reason) {
    return new Promise((resolve) => {
      browser.storage.local.get(['yousub_api_keys']).then((res) => {
        const keys = res.yousub_api_keys || [];
        let updated = false;

        const newKeys = keys.map(k => {
          if (k.provider === providerId && k.apiKey === apiKey) {
            updated = true;
            return {
              ...k,
              status: 'failed',
              statusMessage: reason,
              testedAt: Date.now()
            };
          }
          return k;
        });

        if (updated) {
          browser.storage.local.set({ yousub_api_keys: newKeys }).then(() => {
            Logger.warn('APIManager', `Marked ${providerId} key as failed: ${reason}`);
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
  }
};
