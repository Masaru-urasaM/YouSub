import '../shared/libs/browser-polyfill.js';
import { Logger } from '../shared/logger.js';
import { HealthManager } from './health.js';
import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';

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
      browser.storage.local.get([
        'yousub_api_keys', 
        'yousub_failover_enabled', 
        'yousub_model_rotation',
        'yousub_custom_models',
        'yousub_hidden_models'
      ]).then(async (res) => {
        const keys = res.yousub_api_keys || [];
        const failoverEnabled = res.yousub_failover_enabled !== false;
        const modelRotation = res.yousub_model_rotation || false;
        const customs = res.yousub_custom_models || {};
        const hiddens = res.yousub_hidden_models || {};

        // Filter out keys that are empty or disabled by user
        const configKeys = keys.filter(k => k.apiKey && k.apiKey.trim().length > 0 && !k.disabled);
        
        if (configKeys.length === 0) return resolve([]);

        // 3. Filter by circuit breaker (Parallelized)
        const healthResults = await Promise.all(configKeys.map(async (k) => {
          const isOpen = await HealthManager.isCircuitOpen(k.provider, k.apiKey);
          return { key: k, isOpen };
        }));

        const activeKeys = healthResults
          .filter(r => !r.isOpen)
          .map(r => r.key);

        if (activeKeys.length === 0) {
          Logger.warn('APIManager', 'All configured keys are in cooldown (Circuit Open).');
          return resolve([]);
        }

        let finalKeys = [];
        
        if (activeKeys.length <= 1 || !failoverEnabled) {
          finalKeys = activeKeys.slice(0, 1);
        } else {
          // If failover is enabled, sort Backups by health score (Parallelized)
          const primary = activeKeys[0];
          const backups = activeKeys.slice(1);

          const scoredBackups = await Promise.all(backups.map(async (bk) => {
            const score = await HealthManager.getScore(bk.provider, bk.apiKey);
            return { key: bk, score };
          }));

          scoredBackups.sort((a, b) => b.score - a.score);
          finalKeys = [primary, ...scoredBackups.map(sb => sb.key)];
        }

        // Intra-Key Model Rotation
        if (modelRotation) {
           const expanded = [];
           for (const k of finalKeys) {
             expanded.push(k);
             const prov = YOUSUB_PROVIDERS.getProvider(k.provider);
             if (!prov) continue;
             
             const builtinIds = prov.models.map(m => m.id);
             const customIds = customs[k.provider] || [];
             const hiddenIds = hiddens[k.provider] || [];
             
             // Get all active models (built-ins + customs) - hidden
             const allModels = [...builtinIds, ...customIds].filter(m => !hiddenIds.includes(m));
             const currentModel = k.model === 'auto' ? prov.defaultModel : k.model;
             
             // Append clones for all remaining models for this API key
             for (const m of allModels) {
                if (m !== currentModel) {
                   expanded.push({ ...k, model: m, isRotationClone: true });
                }
             }
           }
           finalKeys = expanded;
        }

        Logger.debug('APIManager', `Loaded ${finalKeys.length} keys in priority order (includes clones if rotated).`);
        resolve(finalKeys);
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
