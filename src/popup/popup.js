import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { devLog, devWarn } from '../shared/constants.js';

document.addEventListener('DOMContentLoaded', function () {
  const getSubBtn = document.getElementById('get-sub-btn');
  const clearPageCacheBtn = document.getElementById('clear-page-cache-btn');
  const openDebugBtn = document.getElementById('open-debug-btn');
  const openSettingsBtn = document.getElementById('open-settings-btn');

  const dualModeToggle = document.getElementById('dual-mode-toggle');
  const healthStatus = document.getElementById('health-status');
  const healthText = document.getElementById('health-text');
  const langSelector = document.getElementById('lang-selector');

  // Modal Elements
  const confirmModal = document.getElementById('confirm-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalMessage = document.getElementById('modal-message');
  const modalCancelBtn = document.getElementById('modal-cancel-btn');
  const modalConfirmBtn = document.getElementById('modal-confirm-btn');

  // Phase 35.8: Add fail-safe timeout for "Checking APIs..."
  const healthTimeout = setTimeout(() => {
    if (healthStatus.textContent.includes('Checking')) {
      devWarn('[YouSub] Popup: Health check timed out. Showing fallback.');
      healthStatus.textContent = '● System Ready (Check Skipped)';
      healthStatus.className = 'status-dot neutral';
    }
  }, 2000);

  let currentLang = 'vi';

  // Phase 56: Populate language selector (exclude 'auto')
  YOUSUB_PROVIDERS.languages
    .filter((l) => l.code !== 'auto')
    .forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.name;
      langSelector.appendChild(opt);
    });

  langSelector.addEventListener('change', function () {
    const newLang = langSelector.value;
    currentLang = newLang;
    browser.storage.local.set({ targetLang: newLang });
    updateLanguageUI(newLang);
  });

  // Load and apply initial states
  browser.storage.local
    .get(['targetLang', 'yousub_api_keys', 'yousub_dual_mode', 'yousub_translation_enabled'])
    .then(async function (res) {
      // 1. Immediate UI Updates (No await)
      updateLanguageUI(res.targetLang);
      dualModeToggle.checked = !!res.yousub_dual_mode;

      // Clear timeout as we got data
      clearTimeout(healthTimeout);
      checkHealth(res.yousub_api_keys || []);

      // 2. Async/Optional Updates (Wrapped in try-catch to prevent UI freeze)
      try {
        const videoId = await getCurrentVideoId();
        if (videoId) {
          clearPageCacheBtn.classList.remove('hidden');
          loadExecutionStats(videoId);

          // Phase 35.16: Query real-time state from content script
          browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
            if (tabs[0]) {
              browser.tabs
                .sendMessage(tabs[0].id, { type: 'YOUSUB_GET_STATE' })
                .then((res) => {
                  if (res) {
                    devLog('[YouSub] Popup: State received from Tab:', res);
                    if (res.isTranslationActive) getSubBtn.classList.add('active');
                    else getSubBtn.classList.remove('active');

                    dualModeToggle.checked = !!res.isDualMode;
                  }
                })
                .catch((err) => {
                  devWarn(
                    '[YouSub] Popup: Could not get state from Tab (likely script not loaded).',
                    err
                  );
                });
            }
          });
        }
      } catch (e) {
        devWarn('[YouSub] Popup: Async initialization failed, falling back to safe UI.', e);
      }
    });

  // Sync language changes from Options page in real-time
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.targetLang) {
      updateLanguageUI(changes.targetLang.newValue);
    }
  });

  function updateLanguageUI(newLang) {
    currentLang = newLang || 'vi';
    // Phase 56: Sync dropdown selection
    if (langSelector.value !== currentLang) {
      langSelector.value = currentLang;
    }
    const langObj = YOUSUB_PROVIDERS.languages.find((l) => l.code === currentLang);
    const langName = langObj ? langObj.name.toUpperCase() : currentLang.toUpperCase();
    getSubBtn.textContent = `Translate to ${langName}`;
  }

  async function getCurrentVideoId() {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs[0] && tabs[0].url) {
        const url = new URL(tabs[0].url);
        if (url.pathname === '/watch') {
          return url.searchParams.get('v');
        } else if (url.pathname.startsWith('/shorts/')) {
          return url.pathname.split('/')[2];
        }
      }
    } catch {}
    return null;
  }

  function checkHealth(keys) {
    const hasKeys = keys.length > 0;
    const activeKeys = keys.filter((k) => k.apiKey && k.apiKey.trim() !== '' && !k.disabled);
    const allDisabled = hasKeys && activeKeys.length === 0;

    healthStatus.classList.remove('hidden');

    if (!hasKeys) {
      healthStatus.className = 'health-indicator health-error';
      healthText.textContent = 'API Not Configured';
      return;
    }

    if (allDisabled) {
      healthStatus.className = 'health-indicator health-error';
      healthText.textContent = 'All API Keys Disabled';
      return;
    }

    // Default state: Checking
    healthStatus.className = 'health-indicator health-warning';
    healthText.textContent = 'Checking APIs...';

    // Fetch real-time health from background
    browser.runtime
      .sendMessage({ type: 'YOUSUB_GET_HEALTH_SUMMARY' })
      .then((res) => {
        if (res && res.success && res.summary) {
          const summary = res.summary;
          const healthy = summary.filter((s) => s.status === 'healthy');
          const broken = summary.filter((s) => s.status === 'broken');
          const poor = summary.filter((s) => s.status === 'poor');

          if (healthy.length > 0) {
            healthStatus.className = 'health-indicator';
            const names = healthy.map((s) => {
              const p = YOUSUB_PROVIDERS.getProvider(s.provider);
              const m = p
                ? p.models.find((m) => m.id === s.model) || { name: s.model }
                : { name: s.model };
              return `${m.name} (Online)`;
            });
            healthText.innerHTML = names.join('<br>');
          } else if (poor.length > 0) {
            healthStatus.className = 'health-indicator health-warning';
            healthText.textContent = 'Service Degradation (Poor Latency)';
          } else if (broken.length > 0) {
            healthStatus.className = 'health-indicator health-error';
            healthText.textContent = 'API Error (Circuit Open)';
          } else {
            healthStatus.className = 'health-indicator health-warning';
            healthText.textContent = 'Checking APIs...';
          }
        }
      })
      .catch((err) => {
        console.error('[YouSub] Popup: Health check error', err);
        // Fallback to basic storage-only check
        const onlineKeys = activeKeys.filter((k) => k.status === 'success' || !k.status);
        if (onlineKeys.length > 0) {
          healthStatus.className = 'health-indicator';
          healthText.textContent = 'Service Ready (Cache Mode)';
        }
      });
  }

  dualModeToggle.addEventListener('change', function () {
    const isEnabled = dualModeToggle.checked;
    browser.storage.local.set({ yousub_dual_mode: isEnabled });

    sendMessageToActiveTab({
      type: 'YOUSUB_TOGGLE_DUAL_MODE',
      enabled: isEnabled,
    });
  });

  openSettingsBtn.addEventListener('click', function () {
    browser.runtime.openOptionsPage();
  });

  openDebugBtn.addEventListener('click', function () {
    browser.tabs.create({ url: browser.runtime.getURL('src/debug/debug.html') });
  });

  clearPageCacheBtn.addEventListener('click', async function () {
    const videoId = await getCurrentVideoId();
    if (!videoId) return;

    showConfirmModal('Clear Cache', 'Delete translation cache for this video?', () => {
      clearPageCacheBtn.disabled = true;
      clearPageCacheBtn.textContent = 'Clearing...';

      browser.runtime
        .sendMessage({
          type: 'YOUSUB_CLEAR_VIDEO_CACHE',
          videoId,
        })
        .then((res) => {
          if (res.success) {
            clearPageCacheBtn.textContent = 'Cache Cleared!';

            // Hide stats when cache is cleared
            const statsContainer = document.getElementById('execution-stats');
            if (statsContainer) statsContainer.classList.add('hidden');
            browser.storage.local.remove(`yousub_stats_${videoId}`);

            setTimeout(() => {
              clearPageCacheBtn.disabled = false;
              clearPageCacheBtn.textContent = 'Clear Page Cache';
            }, 2000);

            // Disable translation if it was active, as cache is gone
            getSubBtn.classList.remove('active');
            browser.storage.local.set({ yousub_translation_enabled: false });
            sendMessageToActiveTab({
              type: 'YOUSUB_TOGGLE_TRANSLATION',
              enabled: false,
              targetLang: currentLang,
            });
          } else {
            clearPageCacheBtn.textContent = 'Error clearing';
            setTimeout(() => {
              clearPageCacheBtn.disabled = false;
              clearPageCacheBtn.textContent = 'Clear Page Cache';
            }, 2000);
          }
        });
    });
  });

  getSubBtn.addEventListener('click', function () {
    const wasActive = getSubBtn.classList.contains('active');
    const newState = !wasActive;

    // UI Update
    if (newState) {
      getSubBtn.classList.add('active');
    } else {
      getSubBtn.classList.remove('active');
    }

    // Save state
    browser.storage.local.set({ yousub_translation_enabled: newState });

    // Inform content script
    sendMessageToActiveTab({
      type: 'YOUSUB_TOGGLE_TRANSLATION',
      enabled: newState,
      targetLang: currentLang,
    });
  });

  function sendMessageToActiveTab(msg) {
    browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      if (!tabs[0] || !tabs[0].url) return;
      const url = tabs[0].url;

      // Phase 50.1.4: Support both regular watch and shorts URLs
      if (url.includes('youtube.com/watch') || url.includes('youtube.com/shorts/')) {
        browser.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
      }
    });
  }

  /**
   * Shows a custom confirmation modal within the popup
   */
  function showConfirmModal(title, message, onConfirm) {
    if (!confirmModal) return;

    modalTitle.textContent = title;
    modalMessage.textContent = message;

    // A11y: remember the element that opened the modal so focus can return to it
    const opener = document.activeElement;

    const handleConfirm = () => {
      closeModal();
      onConfirm();
    };

    const handleCancel = () => {
      closeModal();
    };

    const handleKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    };

    const closeModal = () => {
      confirmModal.classList.add('hidden');
      modalConfirmBtn.removeEventListener('click', handleConfirm);
      modalCancelBtn.removeEventListener('click', handleCancel);
      confirmModal.removeEventListener('keydown', handleKeydown);
      // A11y: return focus to the opener
      if (opener && typeof opener.focus === 'function') opener.focus();
    };

    modalConfirmBtn.addEventListener('click', handleConfirm);
    modalCancelBtn.addEventListener('click', handleCancel);
    confirmModal.addEventListener('keydown', handleKeydown);

    // Close on backdrop click
    confirmModal.onclick = (e) => {
      if (e.target === confirmModal) closeModal();
    };

    confirmModal.classList.remove('hidden');
    // A11y: move focus to the cancel button (first focusable / safe default)
    modalCancelBtn.focus();
  }

  /**
   * Phase 35.13: Load and display translation metrics
   */
  async function loadExecutionStats(videoId) {
    const statsContainer = document.getElementById('execution-stats');
    const statsTitle = document.getElementById('stats-title-text');
    const sourceBadge = document.getElementById('stats-source-badge');
    const modelName = document.getElementById('stats-model-name');
    const requestsVal = document.getElementById('stats-requests');
    const durationVal = document.getElementById('stats-duration');
    const inputTokensVal = document.getElementById('stats-input-tokens');
    const outputTokensVal = document.getElementById('stats-output-tokens');

    if (!statsContainer) return;

    // Get tab title for context (Phase 35.14)
    let videoTitle = 'Last Execution';
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs[0] && tabs[0].title) {
        const rawTitle = tabs[0].title;
        videoTitle = `Last Execution: ${rawTitle.replace(/\s*-\s*YouTube$/, '')}`;
      }
    } catch (e) {
      devWarn('[YouSub] Popup: Could not fetch tab title.', e);
    }
    statsTitle.textContent = videoTitle;
    statsTitle.title = videoTitle; // Tooltip for full title

    const key = `yousub_stats_${videoId}`;
    browser.storage.local.get([key]).then((res) => {
      const stats = res[key];
      if (!stats) {
        statsContainer.classList.add('hidden');
        return;
      }

      statsContainer.classList.remove('hidden');

      if (stats.source === 'cache') {
        sourceBadge.textContent = 'Cache';
        sourceBadge.className = 'stats-badge cache';
        modelName.textContent = 'Loaded from memory';
        requestsVal.textContent = '--';
        durationVal.textContent = '--';
        inputTokensVal.textContent = '--';
        outputTokensVal.textContent = '--';
      } else {
        sourceBadge.textContent = 'API';
        sourceBadge.className = 'stats-badge';
        modelName.textContent = stats.model || 'Unknown model';

        requestsVal.textContent = stats.batchCount || '0';

        const seconds = (stats.durationMs / 1000).toFixed(1);
        durationVal.textContent = `${seconds}s`;

        inputTokensVal.textContent = (stats.promptTokens || 0).toLocaleString();
        outputTokensVal.textContent = (stats.completionTokens || 0).toLocaleString();
      }
    });
  }
});
