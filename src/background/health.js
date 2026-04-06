import '../shared/libs/browser-polyfill.js';
import { Logger } from '../shared/logger.js';

/**
 * health.js
 * Tracks success/failure and response times for each provider/key.
 */
export const HealthManager = {
  COOLDOWN_MS: 5 * 60 * 1000, // 5 minutes

  /**
   * Generates a hash for identifying a unique provider-key combination.
   */
  getHash(providerId, apiKey) {
    const suffix = (apiKey || '').slice(-6);
    return `${providerId}_${suffix}`;
  },

  /**
   * Reports the result of an API call.
   * @param {string} providerId
   * @param {string} apiKey
   * @param {boolean} success
   * @param {number} duration - ms
   */
  async report(providerId, apiKey, success, duration = 0) {
    const hash = this.getHash(providerId, apiKey);

    return new Promise((resolve) => {
      browser.storage.local.get(['yousub_health_stats']).then((res) => {
        const stats = res.yousub_health_stats || {};
        const entry = stats[hash] || {
          successCount: 0,
          failCount: 0,
          consecutiveFails: 0,
          avgTime: 0,
          lastFailureTime: 0,
          circuitBreakerUntil: 0
        };

        if (success) {
          entry.successCount++;
          entry.consecutiveFails = 0;
          entry.circuitBreakerUntil = 0; // Phase 29: Auto-thaw on success
          // Weighted moving average for speed (80% old, 20% new)
          if (entry.avgTime === 0) {
            entry.avgTime = duration;
          } else {
            entry.avgTime = (entry.avgTime * 0.8) + (duration * 0.2);
          }
        } else {
          entry.failCount++;
          entry.consecutiveFails++;
          entry.lastFailureTime = Date.now();

          // Open circuit breaker if 3 consecutive fails
          if (entry.consecutiveFails >= 3) {
            entry.circuitBreakerUntil = Date.now() + this.COOLDOWN_MS;
            Logger.warn('Health', `Circuit breaker OPEN for ${providerId} until ${new Date(entry.circuitBreakerUntil).toLocaleTimeString()}`);
          }
        }

        stats[hash] = entry;
        browser.storage.local.set({ yousub_health_stats: stats }).then(resolve);
      });
    });
  },

  /**
   * Checks if the circuit is currently open (cooling down).
   */
  async isCircuitOpen(providerId, apiKey) {
    const hash = this.getHash(providerId, apiKey);
    return new Promise((resolve) => {
      browser.storage.local.get(['yousub_health_stats']).then((res) => {
        const stats = res.yousub_health_stats || {};
        const entry = stats[hash];
        if (!entry || !entry.circuitBreakerUntil) return resolve(false);

        const isOpen = Date.now() < entry.circuitBreakerUntil;
        resolve(isOpen);
      });
    });
  },

  /**
   * Calculates a performance score (0.0 to 1.0).
   */
  async getScore(providerId, apiKey) {
    const hash = this.getHash(providerId, apiKey);
    return new Promise((resolve) => {
      browser.storage.local.get(['yousub_health_stats']).then((res) => {
        const stats = res.yousub_health_stats || {};
        const entry = stats[hash];

        if (!entry || (entry.successCount + entry.failCount) === 0) {
          return resolve(0.5); // Default neutral score
        }

        const total = entry.successCount + entry.failCount;
        const successRate = entry.successCount / total;
        
        // Speed score (bonus for fast providers, e.g., < 1000ms is good)
        let speedMult = 1.0;
        if (entry.avgTime > 0) {
          speedMult = Math.max(0.1, 1 - (entry.avgTime / 5000)); // Cap at 5s
        }

        resolve(successRate * speedMult);
      });
    });
  }
};
