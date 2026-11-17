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

// DOM Elements
let container,
  template,
  addBackupBtn,
  deleteAllBtn,
  failoverCheckbox,
  rotationCheckbox,
  streamingModeCheckbox,
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
  streamingModeCheckbox = document.getElementById('streaming-mode');
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
    });
  }
}

function loadSettings() {
  browser.storage.local
    .get([
      'targetLang',
      'yousub_api_keys',
      'yousub_failover_enabled',
      'yousub_model_rotation',
      'yousub_streaming_mode',
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
      customModelsRegistry = items.yousub_custom_models || {};
      hiddenModelsRegistry = items.yousub_hidden_models || {};

      failoverCheckbox.checked = failoverEnabled;
      rotationCheckbox.checked = modelRotation;
      if (streamingModeCheckbox) {
        streamingModeCheckbox.checked = items.yousub_streaming_mode || false;
      }

      renderKeysUI(items.yousub_health_stats || {});
    });
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
  addBackupBtn.classList.toggle('hidden', apiKeys.length >= 4);
}

/**
 * Updates only the status and health indicators of existing rows without full re-render.
 * Preserves user focus and unsaved input in the fields.
 */
function updateRealtimeStatuses() {
  browser.storage.local.get(['yousub_api_keys', 'yousub_health_stats']).then((items) => {
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
  });
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
  if (streamingModeCheckbox) {
    streamingModeCheckbox.addEventListener('change', debouncedSave);
  }
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', () => {
      showModal(
        'Clear Translation Cache',
        'Clear all cached translations? This will remove all saved video signatures and require re-translating videos the next time you watch them.',
        () => {
          browser.runtime.sendMessage({ type: 'YOUSUB_CLEAR_CACHE' }).then((response) => {
            if (response && response.success) {
              alert(`Cache cleared successfully! Removed ${response.count || 0} entries.`);
            } else {
              alert('Error clearing cache: ' + (response ? response.error : 'Unknown error'));
            }
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
    yousub_streaming_mode: streamingModeCheckbox ? streamingModeCheckbox.checked : false,
    yousub_custom_models: customModelsRegistry,
    yousub_hidden_models: hiddenModelsRegistry,
  };
  browser.storage.local.set(settings).then(() => {
    if (triggerSaveCallback) triggerSaveCallback();
  });
}
