import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { TRANSLATION_STYLE_KEY, USAGE_STATS_KEY, devLog, devWarn } from '../shared/constants.js';
import { TRANSLATION_STYLE_PRESETS } from '../shared/video-context.js';
import { normalizeUsageStats } from '../shared/usage-stats.js';
import { applyI18n } from '../shared/i18n.js';
import { escapeHtml as esc } from '../shared/utils.js';
import {
  PipelineTelemetry,
  PIPELINE_KEY_PREFIX,
  createInitialSnapshot,
} from '../shared/pipeline-telemetry.js';
import { PipelineFlowView } from './pipeline-flow-view.js';
import { PopupResumeView } from './popup-resume-view.js';

// Localized message helper with graceful fallback to the provided default.
function i18n(key, fallback, substitutions) {
  try {
    const msg = browser.i18n && browser.i18n.getMessage(key, substitutions);
    if (msg) return msg;
  } catch {
    /* i18n unavailable */
  }
  return fallback;
}

document.addEventListener('DOMContentLoaded', function () {
  // Localize static markup first (graceful fallback keeps English if missing).
  applyI18n(document);

  const getSubBtn = document.getElementById('get-sub-btn');
  const clearPageCacheBtn = document.getElementById('clear-page-cache-btn');
  const openDebugBtn = document.getElementById('open-debug-btn');
  const openSettingsBtn = document.getElementById('open-settings-btn');

  const dualModeToggle = document.getElementById('dual-mode-toggle');
  const healthStatus = document.getElementById('health-status');
  const healthText = document.getElementById('health-text');
  const setupWizardBtn = document.getElementById('popup-setup-wizard-btn');
  const usageSavingsEl = document.getElementById('popup-usage-savings');
  const langSelector = document.getElementById('lang-selector');
  const styleSelector = document.getElementById('style-selector');

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
  let activeVideoId = null;

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

  if (styleSelector) {
    const styleLabelKeys = {
      natural: 'stylePresetNatural',
      technical: 'stylePresetTechnical',
      academic: 'stylePresetAcademic',
      anime: 'stylePresetAnime',
      custom: 'stylePresetCustom',
    };
    TRANSLATION_STYLE_PRESETS.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = i18n(styleLabelKeys[p.id] || '', p.name);
      styleSelector.appendChild(opt);
    });
    styleSelector.addEventListener('change', function () {
      browser.storage.local.set({ [TRANSLATION_STYLE_KEY]: styleSelector.value || 'natural' });
    });
  }

  // Load and apply initial states
  browser.storage.local
    .get([
      'targetLang',
      'yousub_api_keys',
      'yousub_dual_mode',
      'yousub_translation_enabled',
      TRANSLATION_STYLE_KEY,
      USAGE_STATS_KEY,
    ])
    .then(async function (res) {
      // 1. Immediate UI Updates (No await)
      updateLanguageUI(res.targetLang);
      if (styleSelector) {
        styleSelector.value = res[TRANSLATION_STYLE_KEY] || 'natural';
      }
      renderUsageSavingsLine(res[USAGE_STATS_KEY]);
      dualModeToggle.checked = !!res.yousub_dual_mode;

      // Clear timeout as we got data
      clearTimeout(healthTimeout);
      checkHealth(res.yousub_api_keys || []);

      // 2. Async/Optional Updates (Wrapped in try-catch to prevent UI freeze)
      try {
        const videoId = await getCurrentVideoId();
        activeVideoId = videoId;
        PopupResumeView.init({ i18n }).catch((err) => {
          devWarn('[YouSub] Popup: Resume view init error:', err);
        });
        if (videoId) {
          clearPageCacheBtn.classList.remove('hidden');
          loadExecutionStats(videoId);
          loadPipelineFlow(videoId);

          // Phase 35.16: Query real-time state from content script
          browser.tabs
            .query({ active: true, currentWindow: true })
            .then((tabs) => {
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
            })
            .catch(() => {});
        }
      } catch (e) {
        devWarn('[YouSub] Popup: Async initialization failed, falling back to safe UI.', e);
      }
    })
    .catch((err) => {
      devWarn('[YouSub] Popup: Failed to read initial storage.', err);
    });

  // Sync language & live telemetry changes in real-time
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.targetLang) {
      updateLanguageUI(changes.targetLang.newValue);
    }
    if (area === 'local' && changes[TRANSLATION_STYLE_KEY] && styleSelector) {
      styleSelector.value = changes[TRANSLATION_STYLE_KEY].newValue || 'natural';
    }
    if (area === 'local' && changes[USAGE_STATS_KEY]) {
      renderUsageSavingsLine(changes[USAGE_STATS_KEY].newValue);
    }
    if (!activeVideoId) return;
    const pipelineKey = `${PIPELINE_KEY_PREFIX}${activeVideoId}`;
    const statsKey = `yousub_stats_${activeVideoId}`;
    if (changes[pipelineKey]) {
      const container = document.getElementById('pipeline-visualizer');
      PipelineFlowView.renderPopupFlow(container, changes[pipelineKey].newValue || null, i18n);
    }
    if (area === 'local' && changes[statsKey]) {
      loadExecutionStats(activeVideoId);
    }
  });

  function renderUsageSavingsLine(rawStats) {
    if (!usageSavingsEl) return;
    const stats = normalizeUsageStats(rawStats);
    if (stats.cacheHits <= 0 && stats.videosTranslated <= 0) {
      usageSavingsEl.classList.add('hidden');
      return;
    }
    const tmpl = i18n(
      'popupUsageSavingsSummary',
      '30d Cache: {hits} hits · ~{tokens} tokens saved'
    );
    usageSavingsEl.textContent = tmpl
      .replace('{hits}', stats.cacheHits.toLocaleString())
      .replace('{tokens}', stats.estimatedTokensSaved.toLocaleString());
    usageSavingsEl.classList.remove('hidden');
  }

  function updateLanguageUI(newLang) {
    currentLang = newLang || 'vi';
    // Phase 56: Sync dropdown selection
    if (langSelector.value !== currentLang) {
      langSelector.value = currentLang;
    }
    const langObj = YOUSUB_PROVIDERS.languages.find((l) => l.code === currentLang);
    const langName = langObj ? langObj.name.toUpperCase() : currentLang.toUpperCase();
    getSubBtn.textContent = i18n('popupTranslateTo', `Translate to ${langName}`, [langName]);
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

    if (setupWizardBtn) {
      setupWizardBtn.classList.toggle('hidden', !(!hasKeys || allDisabled));
    }

    if (!hasKeys) {
      healthStatus.className = 'health-indicator health-error';
      healthText.textContent = i18n('popupHealthApiNotConfigured', 'API Not Configured');
      return;
    }

    if (allDisabled) {
      healthStatus.className = 'health-indicator health-error';
      healthText.textContent = i18n('popupHealthAllKeysDisabled', 'All API Keys Disabled');
      return;
    }

    // Default state: Checking
    healthStatus.className = 'health-indicator health-warning';
    healthText.textContent = i18n('popupHealthChecking', 'Checking APIs...');

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
            const onlineLabel = i18n('popupHealthOnlineSuffix', 'Online');
            const names = healthy.map((s) => {
              const p = YOUSUB_PROVIDERS.getProvider(s.provider);
              const resolvedId = YOUSUB_PROVIDERS.resolveModel(s.provider, s.model);
              const m = p
                ? p.models.find((m) => m.id === resolvedId) || { name: resolvedId }
                : { name: resolvedId };
              const pTag = p ? p.name.split(' ')[0] : s.provider;
              return `<span class="health-row"><span class="health-provider">${esc(pTag)}</span> <span class="health-model">${esc(m.name)}</span> <span class="health-tag">(${esc(onlineLabel)})</span></span>`;
            });
            healthText.innerHTML = names.join('');
          } else if (poor.length > 0) {
            healthStatus.className = 'health-indicator health-warning';
            healthText.textContent = i18n(
              'popupHealthDegradation',
              'Service Degradation (Poor Latency)'
            );
          } else if (broken.length > 0) {
            healthStatus.className = 'health-indicator health-error';
            healthText.textContent = i18n('popupHealthCircuitOpen', 'API Error (Circuit Open)');
          } else {
            healthStatus.className = 'health-indicator health-warning';
            healthText.textContent = i18n('popupHealthChecking', 'Checking APIs...');
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

  if (setupWizardBtn) {
    setupWizardBtn.addEventListener('click', function () {
      browser.runtime.openOptionsPage();
    });
  }

  openDebugBtn.addEventListener('click', function () {
    browser.tabs.create({ url: browser.runtime.getURL('src/debug/debug.html') });
  });

  clearPageCacheBtn.addEventListener('click', async function () {
    const videoId = await getCurrentVideoId();
    if (!videoId) return;

    showConfirmModal(
      i18n('popupClearCacheConfirmTitle', 'Clear Cache'),
      i18n('popupClearCacheConfirmMessage', 'Delete translation cache for this video?'),
      () => {
        clearPageCacheBtn.disabled = true;
        clearPageCacheBtn.textContent = i18n('popupClearing', 'Clearing...');

        const resetClearBtn = () => {
          clearPageCacheBtn.disabled = false;
          clearPageCacheBtn.textContent = i18n('popupClearPageCache', 'Clear Page Cache');
        };
        const showClearError = () => {
          clearPageCacheBtn.textContent = i18n('popupErrorClearing', 'Error clearing');
          setTimeout(resetClearBtn, 2000);
        };

        browser.runtime
          .sendMessage({
            type: 'YOUSUB_CLEAR_VIDEO_CACHE',
            videoId,
          })
          .then((res) => {
            if (res && res.success) {
              clearPageCacheBtn.textContent = i18n('popupCacheCleared', 'Cache Cleared!');

              // Hide stats & pipeline visualizer when cache is cleared
              const statsContainer = document.getElementById('execution-stats');
              if (statsContainer) statsContainer.classList.add('hidden');
              const flowContainer = document.getElementById('pipeline-visualizer');
              if (flowContainer) flowContainer.classList.add('hidden');
              Promise.resolve(browser.storage.local.remove(`yousub_stats_${videoId}`)).catch(
                () => {}
              );
              Promise.resolve(PipelineTelemetry.clear(videoId)).catch(() => {});

              setTimeout(resetClearBtn, 2000);

              // Disable translation if it was active, as cache is gone
              getSubBtn.classList.remove('active');
              Promise.resolve(
                browser.storage.local.set({ yousub_translation_enabled: false })
              ).catch(() => {});
              sendMessageToActiveTab({
                type: 'YOUSUB_TOGGLE_TRANSLATION',
                enabled: false,
                targetLang: currentLang,
              });
            } else {
              showClearError();
            }
          })
          .catch(showClearError);
      }
    );
  });

  getSubBtn.addEventListener('click', function () {
    const wasActive = getSubBtn.classList.contains('active');
    const newState = !wasActive;

    // UI Update
    if (newState) {
      getSubBtn.classList.add('active');
      const flowContainer = document.getElementById('pipeline-visualizer');
      if (flowContainer && activeVideoId && flowContainer.classList.contains('hidden')) {
        PipelineFlowView.renderPopupFlow(
          flowContainer,
          createInitialSnapshot(activeVideoId, {
            mode: 'transcript',
            stage: 'EXTRACT',
            extraction: {
              source: 'probing',
              sourceLang: 'auto',
              targetLang: currentLang,
              steps: [
                {
                  id: 'extract',
                  label: 'Scan Captions',
                  status: 'active',
                  detail: 'DOM & Innertube',
                },
              ],
            },
          }),
          i18n
        );
      }
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
      ...(activeVideoId ? { videoId: activeVideoId } : {}),
    });
  });

  function sendMessageToActiveTab(msg) {
    Promise.resolve(browser.tabs.query({ active: true, currentWindow: true }))
      .then(function (tabs) {
        if (!tabs || !tabs[0] || !tabs[0].url) return;
        const url = tabs[0].url;

        // Phase 50.1.4: Support both regular watch and shorts URLs
        if (url.includes('youtube.com/watch') || url.includes('youtube.com/shorts/')) {
          Promise.resolve(browser.tabs.sendMessage(tabs[0].id, msg)).catch(() => {
            if (msg.type === 'YOUSUB_TOGGLE_TRANSLATION' && msg.enabled) {
              const targetVideoId = msg.videoId || activeVideoId;
              Promise.resolve(
                browser.storage.local.set({
                  yousub_translation_enabled: true,
                  ...(targetVideoId ? { yousub_autostart_video: targetVideoId } : {}),
                })
              )
                .then(() => {
                  if (typeof browser.tabs.reload === 'function') {
                    return Promise.resolve(browser.tabs.reload(tabs[0].id)).catch(() => {});
                  }
                })
                .catch(() => {});
            }
          });
        }
      })
      .catch(() => {});
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

  async function loadPipelineFlow(videoId) {
    const flowContainer = document.getElementById('pipeline-visualizer');
    if (!flowContainer || !videoId) return;
    try {
      const snapshot = await PipelineTelemetry.getSnapshot(videoId);
      PipelineFlowView.renderPopupFlow(flowContainer, snapshot, i18n);
    } catch (e) {
      devWarn('[YouSub] Popup: Failed to load pipeline telemetry.', e);
    }
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
    Promise.resolve(browser.storage.local.get([key]))
      .then((res) => {
        const stats = res[key];
        if (!stats) {
          statsContainer.classList.add('hidden');
          return;
        }

        statsContainer.classList.remove('hidden');

        if (stats.source === 'cache') {
          sourceBadge.textContent = i18n('popupStatsCache', 'Cache');
          sourceBadge.className = 'stats-badge cache';
          modelName.textContent = i18n('popupStatsLoadedFromMemory', 'Loaded from memory');
          requestsVal.textContent = '--';
          durationVal.textContent = '--';
          inputTokensVal.textContent = '--';
          outputTokensVal.textContent = '--';
        } else {
          sourceBadge.textContent = i18n('popupStatsApi', 'API');
          sourceBadge.className = 'stats-badge';
          modelName.textContent = stats.model || i18n('popupStatsUnknownModel', 'Unknown model');

          requestsVal.textContent = stats.batchCount || '0';

          const seconds = (stats.durationMs / 1000).toFixed(1);
          durationVal.textContent = `${seconds}s`;

          inputTokensVal.textContent = (stats.promptTokens || 0).toLocaleString();
          outputTokensVal.textContent = (stats.completionTokens || 0).toLocaleString();
        }
      })
      .catch(() => {});
  }
});
