import {
  TRANSLATION_ACTIVATION_KEY,
  SKIP_MUSIC_VIDEOS_KEY,
  TRANSLATION_STYLE_KEY,
  CUSTOM_PROMPT_KEY,
  CUSTOM_GLOSSARY_KEY,
  USAGE_STATS_KEY,
  ONBOARDING_DISMISSED_KEY,
} from '../shared/constants.js';
import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { normalizeUsageStats, resetUsageStats } from '../shared/usage-stats.js';
import { showConfirmModal } from './options-modal.js';
import {
  sanitizeKey,
  applyRowStatusText,
  applyRowHealthBadge,
  renderSingleRow,
} from './translation-row.js';

// Localized message helper with graceful fallback to the provided default.
function i18n(key, fallback) {
  try {
    const msg = browser.i18n && browser.i18n.getMessage(key);
    if (msg) return msg;
  } catch {
    /* i18n unavailable */
  }
  return fallback;
}

let apiKeys = [];
let failoverEnabled = true;
let modelRotation = false;
let customModelsRegistry = {};
let hiddenModelsRegistry = {};
let onboardingDismissed = false;
let onboardingForceOpen = false;

// DOM Elements
let container,
  template,
  addBackupBtn,
  deleteAllBtn,
  failoverCheckbox,
  rotationCheckbox,
  activationModeSelect,
  skipMusicCheckbox,
  streamingModeCheckbox,
  geminiFallbackCheckbox,
  translationStyleSelect,
  customPromptGroup,
  customPromptInput,
  glossaryKeepTermsInput,
  glossaryPairsInput,
  glossaryPronounInput,
  onboardingCard,
  onboardingKeyInput,
  onboardingDetectedEl,
  onboardingStatusEl,
  onboardingTestSaveBtn,
  onboardingDismissBtn,
  openOnboardingBtn,
  usageVideosEl,
  usageCacheHitsEl,
  usageRequestsSavedEl,
  usageTokensSavedEl,
  usageTokensUsedNoteEl,
  resetUsageStatsBtn,
  noKeysAlert,
  targetLangSelect,
  clearCacheBtn;
let triggerSaveCallback = null;
let saveTimeout = null;
let modalEls = {};

export function initTranslationTab(saveIndicatorCallback) {
  triggerSaveCallback = saveIndicatorCallback;

  targetLangSelect = document.getElementById('target-lang');
  container = document.getElementById('api-keys-list');
  template = document.getElementById('api-key-row-template');
  addBackupBtn = document.getElementById('add-backup-btn');
  deleteAllBtn = document.getElementById('delete-all-keys-btn');
  failoverCheckbox = document.getElementById('enable-failover');
  rotationCheckbox = document.getElementById('enable-rotation');
  activationModeSelect = document.getElementById('activation-mode');
  skipMusicCheckbox = document.getElementById('skip-music-videos');
  streamingModeCheckbox = document.getElementById('streaming-mode');
  geminiFallbackCheckbox = document.getElementById('gemini-video-fallback');
  translationStyleSelect = document.getElementById('translation-style');
  customPromptGroup = document.getElementById('custom-prompt-group');
  customPromptInput = document.getElementById('custom-prompt-input');
  glossaryKeepTermsInput = document.getElementById('glossary-keep-terms');
  glossaryPairsInput = document.getElementById('glossary-pairs');
  glossaryPronounInput = document.getElementById('glossary-pronoun-rule');
  onboardingCard = document.getElementById('onboarding-wizard-card');
  onboardingKeyInput = document.getElementById('onboarding-key-input');
  onboardingDetectedEl = document.getElementById('onboarding-detected-provider');
  onboardingStatusEl = document.getElementById('onboarding-status');
  onboardingTestSaveBtn = document.getElementById('onboarding-test-save-btn');
  onboardingDismissBtn = document.getElementById('onboarding-dismiss-btn');
  openOnboardingBtn = document.getElementById('open-onboarding-btn');
  usageVideosEl = document.getElementById('usage-videos-count');
  usageCacheHitsEl = document.getElementById('usage-cache-hits');
  usageRequestsSavedEl = document.getElementById('usage-requests-saved');
  usageTokensSavedEl = document.getElementById('usage-tokens-saved');
  usageTokensUsedNoteEl = document.getElementById('usage-tokens-used-note');
  resetUsageStatsBtn = document.getElementById('reset-usage-stats-btn');
  noKeysAlert = document.getElementById('no-keys-alert');
  clearCacheBtn = document.getElementById('clear-cache-btn');

  modalEls = {
    confirmModal: document.getElementById('confirm-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalMessage: document.getElementById('modal-message'),
    modalCancelBtn: document.getElementById('modal-cancel-btn'),
    modalConfirmBtn: document.getElementById('modal-confirm-btn'),
  };

  loadSettings();
  attachEventListeners();

  if (typeof browser !== 'undefined' && browser.storage) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.yousub_api_keys || changes.yousub_health_stats)) {
        updateRealtimeStatuses();
      }
      if (area === 'local' && changes[TRANSLATION_STYLE_KEY] && translationStyleSelect) {
        translationStyleSelect.value = changes[TRANSLATION_STYLE_KEY].newValue || 'natural';
        syncCustomPromptVisibility();
      }
      if (area === 'local' && changes[USAGE_STATS_KEY]) {
        renderUsageStatsUI(changes[USAGE_STATS_KEY].newValue);
      }
    });
  }
}

function syncCustomPromptVisibility() {
  if (!customPromptGroup || !translationStyleSelect) return;
  customPromptGroup.classList.toggle('hidden', translationStyleSelect.value !== 'custom');
}

function syncOnboardingVisibility(validKeyCount) {
  if (!onboardingCard) return;
  const shouldShow = onboardingForceOpen || (!onboardingDismissed && validKeyCount === 0);
  onboardingCard.classList.toggle('hidden', !shouldShow);
}

function renderUsageStatsUI(rawStats) {
  const stats = normalizeUsageStats(rawStats);
  if (usageVideosEl) usageVideosEl.textContent = stats.videosTranslated.toLocaleString();
  if (usageCacheHitsEl) usageCacheHitsEl.textContent = stats.cacheHits.toLocaleString();
  if (usageRequestsSavedEl) {
    usageRequestsSavedEl.textContent = stats.estimatedRequestsSaved.toLocaleString();
  }
  if (usageTokensSavedEl)
    usageTokensSavedEl.textContent = stats.estimatedTokensSaved.toLocaleString();
  if (usageTokensUsedNoteEl) {
    const usedStr = stats.tokensUsed.toLocaleString();
    const batchesStr = stats.apiBatches.toLocaleString();
    usageTokensUsedNoteEl.textContent = `Live BYOK usage: ${usedStr} tokens across ${batchesStr} batches`;
  }
}

function loadSettings() {
  browser.storage.local
    .get([
      'targetLang',
      'yousub_api_keys',
      'yousub_failover_enabled',
      'yousub_model_rotation',
      TRANSLATION_ACTIVATION_KEY,
      SKIP_MUSIC_VIDEOS_KEY,
      TRANSLATION_STYLE_KEY,
      CUSTOM_PROMPT_KEY,
      CUSTOM_GLOSSARY_KEY,
      USAGE_STATS_KEY,
      ONBOARDING_DISMISSED_KEY,
      'yousub_streaming_mode',
      'yousub_gemini_fallback_enabled',
      'yousub_custom_models',
      'yousub_hidden_models',
      'yousub_health_stats',
    ])
    .then((items) => {
      targetLangSelect.value = items.targetLang || 'vi';

      apiKeys = items.yousub_api_keys || [];
      if (apiKeys.length === 0) {
        apiKeys.push(createEmptyKey());
      }

      failoverEnabled = items.yousub_failover_enabled !== false;
      modelRotation = items.yousub_model_rotation !== false;
      onboardingDismissed = Boolean(items[ONBOARDING_DISMISSED_KEY]);
      customModelsRegistry = items.yousub_custom_models || {};
      hiddenModelsRegistry = items.yousub_hidden_models || {};

      failoverCheckbox.checked = failoverEnabled;
      rotationCheckbox.checked = modelRotation;
      if (activationModeSelect) {
        activationModeSelect.value = items[TRANSLATION_ACTIVATION_KEY] || 'manual';
      }
      if (skipMusicCheckbox) {
        skipMusicCheckbox.checked = items[SKIP_MUSIC_VIDEOS_KEY] !== false;
      }
      if (translationStyleSelect) {
        translationStyleSelect.value = items[TRANSLATION_STYLE_KEY] || 'natural';
        syncCustomPromptVisibility();
      }
      if (customPromptInput) {
        customPromptInput.value = items[CUSTOM_PROMPT_KEY] || '';
      }
      const glossary = items[CUSTOM_GLOSSARY_KEY] || {};
      if (glossaryKeepTermsInput) {
        glossaryKeepTermsInput.value = glossary.keepTermsText || '';
      }
      if (glossaryPairsInput) {
        glossaryPairsInput.value = glossary.glossaryPairsText || '';
      }
      if (glossaryPronounInput) {
        glossaryPronounInput.value = glossary.pronounRule || '';
      }
      if (streamingModeCheckbox) {
        streamingModeCheckbox.checked = items.yousub_streaming_mode || false;
      }
      if (geminiFallbackCheckbox) {
        geminiFallbackCheckbox.checked = items.yousub_gemini_fallback_enabled !== false;
      }

      renderUsageStatsUI(items[USAGE_STATS_KEY]);
      renderKeysUI(items.yousub_health_stats || {});
    })
    .catch(() => {});
}

function createEmptyKey() {
  return {
    provider: 'auto',
    model: 'auto',
    apiKey: '',
    status: 'untested',
    statusMessage: '',
    testedAt: 0,
  };
}

function showModal(title, message, onConfirm) {
  showConfirmModal(modalEls, title, message, onConfirm);
}

function renderKeysUI(healthStats = {}) {
  container.innerHTML = '';
  let validKeyCount = 0;

  const rowCtx = {
    template,
    getApiKeys: () => apiKeys,
    getCustomModels: () => customModelsRegistry,
    getHiddenModels: () => hiddenModelsRegistry,
    noKeysAlert,
    showModal,
    debouncedSave,
    rerenderKeys: renderKeysUI,
    i18n,
  };

  apiKeys.forEach((keyData, index) => {
    if (keyData.apiKey && keyData.apiKey.trim() !== '') {
      validKeyCount++;
    }
    container.appendChild(renderSingleRow(keyData, index, healthStats, rowCtx));
  });

  noKeysAlert.classList.toggle('hidden', validKeyCount > 0);
  syncOnboardingVisibility(validKeyCount);
  addBackupBtn.classList.toggle('hidden', apiKeys.length >= 4);
}

/**
 * Updates only the status and health indicators of existing rows without full re-render.
 * Preserves user focus and unsaved input in the fields.
 */
function updateRealtimeStatuses() {
  browser.storage.local
    .get(['yousub_api_keys', 'yousub_health_stats'])
    .then((items) => {
      const keys = items.yousub_api_keys || [];
      const healthStats = items.yousub_health_stats || {};

      keys.forEach((keyData, index) => {
        const row = container.querySelector(`.api-key-row[data-index="${index}"]`);
        if (!row) return;

        const statusText = row.querySelector('.status-text');
        const healthIndicator = row.querySelector('.health-indicator');
        const healthStatsText = row.querySelector('.health-stats');
        const cleanKey = sanitizeKey(keyData.apiKey);
        const keyHash = `${keyData.provider}_${cleanKey.slice(-6)}`;
        const stats = healthStats[keyHash];

        if (stats && stats.successCount > 0 && Date.now() > (stats.circuitBreakerUntil || 0)) {
          if (keyData.status === 'failed') {
            keyData.status = 'ok';
            keyData.statusMessage = 'Recovered';
          }
        }

        applyRowStatusText(statusText, keyData, i18n, true);
        applyRowHealthBadge(healthIndicator, healthStatsText, stats, true);
      });

      if (!(
        document.activeElement &&
        (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT')
      )) {
        apiKeys = keys;
      }
    })
    .catch(() => {});
}

function attachEventListeners() {
  targetLangSelect.addEventListener('change', debouncedSave);
  addBackupBtn.addEventListener('click', () => {
    if (apiKeys.length < 4) {
      apiKeys.push(createEmptyKey());
      renderKeysUI();
      debouncedSave();
    }
  });
  deleteAllBtn.addEventListener('click', () => {
    showModal(
      'Delete All API Keys',
      'Are you sure you want to delete ALL configured API keys? This action cannot be undone.',
      () => {
        apiKeys = [createEmptyKey()];
        renderKeysUI();
        debouncedSave();
      }
    );
  });
  failoverCheckbox.addEventListener('change', () => {
    failoverEnabled = failoverCheckbox.checked;
    debouncedSave();
  });
  rotationCheckbox.addEventListener('change', () => {
    modelRotation = rotationCheckbox.checked;
    debouncedSave();
  });
  if (activationModeSelect) {
    activationModeSelect.addEventListener('change', debouncedSave);
  }
  if (skipMusicCheckbox) {
    skipMusicCheckbox.addEventListener('change', debouncedSave);
  }
  if (streamingModeCheckbox) {
    streamingModeCheckbox.addEventListener('change', debouncedSave);
  }
  if (geminiFallbackCheckbox) {
    geminiFallbackCheckbox.addEventListener('change', debouncedSave);
  }
  if (translationStyleSelect) {
    translationStyleSelect.addEventListener('change', () => {
      syncCustomPromptVisibility();
      debouncedSave();
    });
  }
  if (customPromptInput) {
    customPromptInput.addEventListener('input', debouncedSave);
  }
  if (glossaryKeepTermsInput) {
    glossaryKeepTermsInput.addEventListener('input', debouncedSave);
  }
  if (glossaryPairsInput) {
    glossaryPairsInput.addEventListener('input', debouncedSave);
  }
  if (glossaryPronounInput) {
    glossaryPronounInput.addEventListener('input', debouncedSave);
  }
  if (onboardingKeyInput) {
    onboardingKeyInput.addEventListener('input', () => {
      const cleanKey = sanitizeKey(onboardingKeyInput.value);
      const detected = YOUSUB_PROVIDERS.detectProviderFromKey(cleanKey);
      const pObj = detected ? YOUSUB_PROVIDERS.getProvider(detected) : null;
      if (onboardingDetectedEl) {
        onboardingDetectedEl.textContent = pObj
          ? `Detected: ${pObj.name}`
          : cleanKey
            ? 'Provider auto-detect: Google Gemini / Custom'
            : '';
      }
      if (onboardingStatusEl) {
        onboardingStatusEl.textContent = '';
        onboardingStatusEl.className = 'onboarding-status';
      }
    });
  }
  if (onboardingTestSaveBtn) {
    onboardingTestSaveBtn.addEventListener('click', () => {
      const cleanKey = sanitizeKey(onboardingKeyInput ? onboardingKeyInput.value : '');
      if (!cleanKey) {
        if (onboardingStatusEl) {
          onboardingStatusEl.textContent = 'Please paste an API key first.';
          onboardingStatusEl.className = 'onboarding-status error';
        }
        return;
      }
      const provider = YOUSUB_PROVIDERS.detectProviderFromKey(cleanKey) || 'google';
      const model = YOUSUB_PROVIDERS.resolveModel(provider, 'auto');
      const pObj = YOUSUB_PROVIDERS.getProvider(provider);
      onboardingTestSaveBtn.disabled = true;
      if (onboardingStatusEl) {
        onboardingStatusEl.textContent = 'Testing connection...';
        onboardingStatusEl.className = 'onboarding-status';
      }
      browser.runtime
        .sendMessage({
          type: 'YOUSUB_TEST_API_KEY',
          provider,
          model,
          apiKey: cleanKey,
        })
        .then((res) => {
          if (res && res.success) {
            const slot = {
              provider,
              model,
              apiKey: cleanKey,
              status: 'ok',
              statusMessage: 'OK',
              testedAt: Date.now(),
              disabled: false,
            };
            const emptyIdx = apiKeys.findIndex((k) => !k.apiKey || k.apiKey.trim() === '');
            if (emptyIdx !== -1) {
              apiKeys[emptyIdx] = slot;
            } else if (apiKeys.length < 4) {
              apiKeys.push(slot);
            } else {
              apiKeys[0] = slot;
            }
            onboardingDismissed = true;
            onboardingForceOpen = false;
            browser.storage.local.set({ [ONBOARDING_DISMISSED_KEY]: true }).catch(() => {});
            renderKeysUI();
            performSave();
            if (onboardingStatusEl) {
              onboardingStatusEl.textContent = `Connected & saved (${pObj?.name || provider})!`;
              onboardingStatusEl.className = 'onboarding-status ok';
            }
          } else if (onboardingStatusEl) {
            onboardingStatusEl.textContent = res?.error || 'Key verification failed.';
            onboardingStatusEl.className = 'onboarding-status error';
          }
        })
        .catch((err) => {
          if (onboardingStatusEl) {
            onboardingStatusEl.textContent = err?.message || 'Verification failed.';
            onboardingStatusEl.className = 'onboarding-status error';
          }
        })
        .finally(() => {
          onboardingTestSaveBtn.disabled = false;
        });
    });
  }
  if (onboardingDismissBtn) {
    onboardingDismissBtn.addEventListener('click', () => {
      onboardingDismissed = true;
      onboardingForceOpen = false;
      browser.storage.local.set({ [ONBOARDING_DISMISSED_KEY]: true }).catch(() => {});
      if (onboardingCard) onboardingCard.classList.add('hidden');
    });
  }
  if (openOnboardingBtn) {
    openOnboardingBtn.addEventListener('click', () => {
      onboardingForceOpen = true;
      if (onboardingCard) onboardingCard.classList.remove('hidden');
      if (onboardingKeyInput) onboardingKeyInput.focus();
    });
  }
  if (resetUsageStatsBtn) {
    resetUsageStatsBtn.addEventListener('click', () => {
      showModal(
        'Reset Usage Statistics',
        'Reset all local translation and 30-day cache savings counters to zero?',
        () => {
          resetUsageStats().then((next) => renderUsageStatsUI(next));
        }
      );
    });
  }
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', () => {
      showModal(
        'Clear Translation Cache',
        'Clear all cached translations? This will remove all saved video signatures and require re-translating videos the next time you watch them.',
        () => {
          browser.runtime
            .sendMessage({ type: 'YOUSUB_CLEAR_CACHE' })
            .then((response) => {
              if (response && response.success) {
                alert(`Cache cleared successfully! Removed ${response.count || 0} entries.`);
              } else {
                alert('Error clearing cache: ' + (response ? response.error : 'Unknown error'));
              }
            })
            .catch((err) => {
              alert('Error clearing cache: ' + (err?.message || 'Unknown error'));
            });
        }
      );
    });
  }
}

function debouncedSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(performSave, 500);
}

function performSave() {
  const settings = {
    targetLang: targetLangSelect.value,
    yousub_api_keys: apiKeys,
    yousub_failover_enabled: failoverEnabled,
    yousub_model_rotation: modelRotation,
    [TRANSLATION_ACTIVATION_KEY]: activationModeSelect ? activationModeSelect.value : 'manual',
    [SKIP_MUSIC_VIDEOS_KEY]: skipMusicCheckbox ? skipMusicCheckbox.checked : true,
    [TRANSLATION_STYLE_KEY]: translationStyleSelect ? translationStyleSelect.value : 'natural',
    [CUSTOM_PROMPT_KEY]: customPromptInput ? customPromptInput.value.trim() : '',
    [CUSTOM_GLOSSARY_KEY]: {
      keepTermsText: glossaryKeepTermsInput ? glossaryKeepTermsInput.value : '',
      glossaryPairsText: glossaryPairsInput ? glossaryPairsInput.value : '',
      pronounRule: glossaryPronounInput ? glossaryPronounInput.value.trim() : '',
    },
    yousub_streaming_mode: streamingModeCheckbox ? streamingModeCheckbox.checked : false,
    yousub_gemini_fallback_enabled: geminiFallbackCheckbox ? geminiFallbackCheckbox.checked : true,
    yousub_custom_models: customModelsRegistry,
    yousub_hidden_models: hiddenModelsRegistry,
  };
  browser.storage.local.set(settings).then(() => {
    if (triggerSaveCallback) triggerSaveCallback();
  });
}
