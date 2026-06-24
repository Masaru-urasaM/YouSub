import '../shared/libs/browser-polyfill.js';
import { Logger } from '../shared/logger.js';
import { sanitizeKey } from '../shared/utils.js';

/**
 * health.js
 * Tracks success/failure and response times for each provider/key.
 */

export const HealthManager = {
  COOLDOWN_MS: 2 * 60 * 1000, // 2 minutes (Relaxed from 5m)

  /**
   * Generates a hash for identifying a unique provider-key combination.
   */
  getHash(providerId, apiKey) {
    const cleanKey = sanitizeKey(apiKey);
    const suffix = cleanKey.slice(-6);
    return `${providerId}_${suffix}`;
  },

  /**
   * Reports the result of an API call.
   * @param {string} providerId
   * @param {string} apiKey
   * @param {boolean} success
   * @param {number} duration - ms
   */
  async report(providerId, apiKey, success, duration = 0, options = {}) {
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
          circuitBreakerUntil: 0,
        };

        if (success) {
          entry.successCount++;
          entry.consecutiveFails = 0;
          entry.circuitBreakerUntil = 0; // Phase 29: Auto-thaw on success
          // Weighted moving average for speed (80% old, 20% new)
          if (entry.avgTime === 0) {
            entry.avgTime = duration;
          } else {
            entry.avgTime = entry.avgTime * 0.8 + duration * 0.2;
          }
        } else {
          entry.failCount++;
          entry.lastFailureTime = Date.now();

          if (options.isTransient) {
            // Transient errors (e.g., 429 rate limit) — track but don't escalate circuit breaker
            Logger.debug(
              'Health',
              `Transient failure for ${providerId} (not counting toward circuit breaker)`
            );
          } else {
            entry.consecutiveFails++;

            // Open circuit breaker if 10 consecutive fails (Relaxed from 5)
            if (entry.consecutiveFails >= 10) {
              entry.circuitBreakerUntil = Date.now() + this.COOLDOWN_MS;
              Logger.warn(
                'Health',
                `Circuit breaker OPEN for ${providerId} until ${new Date(entry.circuitBreakerUntil).toLocaleTimeString()}`
              );
            }
          }
        }

        stats[hash] = entry;
        browser.storage.local.set({ yousub_health_stats: stats }).then(resolve);
      });
    });
  },

  /**
   * Checks if the circuit is currently open (cooling down).
   * @param {string} providerId
   * @param {string} apiKey
   * @param {Object} [preFetchedStats] - Optional pre-fetched stats to avoid storage I/O
   */
  async isCircuitOpen(providerId, apiKey, preFetchedStats = null) {
    const hash = this.getHash(providerId, apiKey);
    try {
      const stats =
        preFetchedStats ||
        (await browser.storage.local.get(['yousub_health_stats'])).yousub_health_stats ||
        {};
      const entry = stats[hash];

      if (!entry || !entry.circuitBreakerUntil) return false;

      const isOpen = Date.now() < entry.circuitBreakerUntil;
      return isOpen;
    } catch (e) {
      Logger.error('Health', `Check error: ${e.message}`);
      return false;
    }
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

        if (!entry || entry.successCount + entry.failCount === 0) {
          return resolve(0.5); // Default neutral score
        }

        const total = entry.successCount + entry.failCount;
        const successRate = entry.successCount / total;

        // Speed score (bonus for fast providers, e.g., < 1000ms is good)
        let speedMult = 1.0;
        if (entry.avgTime > 0) {
          speedMult = Math.max(0.1, 1 - entry.avgTime / 5000); // Cap at 5s
        }

        resolve(successRate * speedMult);
      });
    });
  },

  /**
   * Returns a health summary for all keys.
   */
  async getSummary(keys = []) {
    const res = await browser.storage.local.get(['yousub_health_stats']);
    const stats = res.yousub_health_stats || {};

    return keys.map((k) => {
      const hash = this.getHash(k.provider, k.apiKey);
      const entry = stats[hash];
      const isOpen = entry ? Date.now() < entry.circuitBreakerUntil : false;
      const total = entry ? entry.successCount + entry.failCount : 0;
      const rate = total > 0 ? entry.successCount / total : 1;

      return {
        provider: k.provider,
        model: k.model,
        isOpen: isOpen,
        successRate: rate,
        consecutiveFails: entry ? entry.consecutiveFails : 0,
        status: isOpen ? 'broken' : rate < 0.5 ? 'poor' : 'healthy',
      };
    });
  },

  /**
   * Resets health stats for a specific provider/key combination.
   * Called when a manual API test succeeds, to clear stale failure history.
   */
  async resetStats(providerId, apiKey) {
    const hash = this.getHash(providerId, apiKey);
    const res = await browser.storage.local.get(['yousub_health_stats']);
    const stats = res.yousub_health_stats || {};

    if (stats[hash]) {
      stats[hash] = {
        successCount: 1,
        failCount: 0,
        consecutiveFails: 0,
        avgTime: stats[hash].avgTime || 0,
        lastFailureTime: 0,
        circuitBreakerUntil: 0,
      };
      await browser.storage.local.set({ yousub_health_stats: stats });
      Logger.info('Health', `Stats reset for ${providerId} after successful test`);
    }
  },
};
