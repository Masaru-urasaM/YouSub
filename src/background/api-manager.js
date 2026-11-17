import '../shared/libs/browser-polyfill.js';
import { Logger } from '../shared/logger.js';
import { HealthManager } from './health.js';
import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { sanitizeKey } from '../shared/utils.js';

function extractModelSizeB(modelId) {
  const match = modelId.match(/(\d+)b/i);
  return match ? parseInt(match[1]) : null;
}

function getGroqMaxLines(modelId, defaultMax) {
  const sizeB = extractModelSizeB(modelId);
  if (sizeB === null) return defaultMax;
  if (sizeB >= 70) return Math.round((defaultMax * 2) / 3);
  if (sizeB >= 32) return Math.round((defaultMax * 1) / 3);
  if (sizeB >= 17) return Math.round((defaultMax * 0.5) / 3);
  return Math.round((defaultMax * 0.25) / 3);
}

const DEFAULT_MAX_LINES = 50;

/**
 * api-manager.js
 * Manages the lifecycle and healthy of configured API keys.
 */
export const APIManager = {
  /**
   * Helper: storage.get with internal timeout
   */
  async _storageGet(keys, timeoutMs = 5000) {
    return await Promise.race([
      browser.storage.local.get(keys),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`StorageTimeout: ${JSON.stringify(keys)}`)), timeoutMs)
      ),
    ]);
  },

  /**
   * Filter and return keys that are:
   * 1. Enabled by user
   * 2. Not blocked by circuit breaker
   */
  async getValidKeys() {
    try {
      const res = await this._storageGet([
        'yousub_api_keys',
        'yousub_failover_enabled',
        'yousub_model_rotation',
        'yousub_custom_models',
        'yousub_hidden_models',
      ]);

      const keys = res.yousub_api_keys || [];
      const failoverEnabled = res.yousub_failover_enabled !== false;
      const modelRotation = res.yousub_model_rotation !== false;
      const customs = res.yousub_custom_models || {};
      const hiddens = res.yousub_hidden_models || {};

      // 1. Initial Filtering & Sanitization
      const configKeys = keys
        .map((k, index) => {
          const cleanKey = sanitizeKey(k.apiKey);
          const name = `Key #${index + 1} (${k.provider})`;

          if (!k.apiKey || cleanKey.length === 0) {
            Logger.debug('APIManager', `Skipped ${name}: Key is empty.`);
            return null;
          }
          if (k.disabled) {
            Logger.debug('APIManager', `Skipped ${name}: Disabled by user.`);
            return null;
          }
          return { ...k, apiKey: cleanKey };
        })
        .filter(Boolean);

      if (configKeys.length === 0) {
        Logger.warn('APIManager', 'No active API keys found (all empty or disabled).');
        return [];
      }

      // 2. Fetch all health stats once (Optimization)
      const statsRes = await this._storageGet(['yousub_health_stats']);
      const stats = statsRes.yousub_health_stats || {};

      // 3. Filter by circuit breaker
      const healthResults = await Promise.all(
        configKeys.map(async (k) => {
          const hash = HealthManager.getHash(k.provider, k.apiKey);
          const entry = stats[hash];

          const isOpen = await HealthManager.isCircuitOpen(k.provider, k.apiKey, stats);

          if (isOpen && entry) {
            const resumeTime = new Date(entry.circuitBreakerUntil).toLocaleTimeString();
            Logger.warn(
              'APIManager',
              `Skipped ${k.provider}_${k.apiKey.slice(-4)}: Circuit OPEN until ${resumeTime}.`
            );
          }

          // Phase 75a: single source of truth for the health score (this was an
          // inline duplicate of HealthManager's formula; identical 10s-cap math).
          k.score = HealthManager.computeScore(entry);

          k.isCircuitOpen = isOpen;
          return { key: k, isOpen };
        })
      );

      const activeKeys = healthResults.filter((r) => !r.isOpen).map((r) => r.key);

      if (activeKeys.length === 0) {
        Logger.warn('APIManager', 'All configured keys are in cooldown (Circuit Open).');
        return [];
      }

      let finalKeys = [];

      if (activeKeys.length <= 1 || !failoverEnabled) {
        finalKeys = activeKeys.slice(0, 1);
      } else {
        // If failover is enabled, sort Backups by health score
        const primary = activeKeys[0];
        const backups = activeKeys.slice(1);

        backups.sort((a, b) => b.score - a.score);
        finalKeys = [primary, ...backups];
      }

      // Intra-Key Model Rotation
      if (modelRotation) {
        const expanded = [];
        for (const k of finalKeys) {
          const prov = YOUSUB_PROVIDERS.getProvider(k.provider);
          const resolvedModel = YOUSUB_PROVIDERS.resolveModel(k.provider, k.model);
          const entry = resolvedModel !== k.model ? { ...k, model: resolvedModel } : k;

          if (entry.provider === 'groq') {
            entry.maxLinesPerBatch = getGroqMaxLines(resolvedModel, DEFAULT_MAX_LINES);
          }

          expanded.push(entry);
          if (!prov) continue;

          const builtinIds = prov.models.map((m) => m.id);
          const customIds = customs[entry.provider] || [];
          const hiddenIds = hiddens[entry.provider] || [];

          const allModels = [...builtinIds, ...customIds].filter((m) => !hiddenIds.includes(m));
          const currentModel = resolvedModel;

          const clones = [];
          for (const m of allModels) {
            if (m !== currentModel) {
              const clone = { ...entry, model: m, isRotationClone: true };
              if (entry.provider === 'groq') {
                clone.maxLinesPerBatch = getGroqMaxLines(m, DEFAULT_MAX_LINES);
              }
              clones.push(clone);
            }
          }

          if (entry.provider === 'groq') {
            clones.sort(
              (a, b) =>
                (b.maxLinesPerBatch || DEFAULT_MAX_LINES) -
                (a.maxLinesPerBatch || DEFAULT_MAX_LINES)
            );
          }
          expanded.push(...clones);
        }
        finalKeys = expanded;
      }

      // Stamp maxLinesPerBatch on Groq keys and normalize deprecated models even when rotation is off
      finalKeys = finalKeys.map((k) => {
        const resolvedModel = YOUSUB_PROVIDERS.resolveModel(k.provider, k.model);
        const updated = resolvedModel !== k.model ? { ...k, model: resolvedModel } : k;
        if (updated.provider === 'groq' && !updated.maxLinesPerBatch) {
          updated.maxLinesPerBatch = getGroqMaxLines(resolvedModel, DEFAULT_MAX_LINES);
        }
        return updated;
      });

      Logger.debug('APIManager', `Loaded ${finalKeys.length} keys in priority order.`);
      return finalKeys;
    } catch (err) {
      Logger.error('APIManager', `Critical Error in getValidKeys: ${err.message}`);
      return []; // Defensive: return empty array so pipeline can show proper error notification
    }
  },

  /**
   * Marks a specific key as failed in storage so it won't be picked immediately next time.
   */
  async markKeyFailed(providerId, apiKey, reason) {
    return new Promise((resolve) => {
      browser.storage.local.get(['yousub_api_keys']).then((res) => {
        const keys = res.yousub_api_keys || [];
        let updated = false;

        const newKeys = keys.map((k) => {
          if (k.provider === providerId && k.apiKey === apiKey) {
            updated = true;
            return {
              ...k,
              status: 'failed',
              statusMessage: reason,
              testedAt: Date.now(),
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
  },
};
