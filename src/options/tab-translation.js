import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { Logger } from '../shared/logger.js';

let apiKeys = [];
let failoverEnabled = true;
let modelRotation = false;
let customModelsRegistry = {};
let hiddenModelsRegistry = {};

/**
 * Helper to remove non-printable and zero-width characters (Shared logic)
 */
const sanitizeKey = (key) => {
  if (!key) return '';
  return key.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
};

// DOM Elements
let container, template, addBackupBtn, deleteAllBtn, failoverCheckbox, rotationCheckbox, streamingModeCheckbox, noKeysAlert, targetLangSelect, clearCacheBtn;
let triggerSaveCallback = null;
let saveTimeout = null;

// Modal Elements
let confirmModal, modalTitle, modalMessage, modalCancelBtn, modalConfirmBtn;

export function initTranslationTab(saveIndicatorCallback) {
  triggerSaveCallback = saveIndicatorCallback;

  // Translation Language Dropdown
  targetLangSelect = document.getElementById('target-lang');

  // API Keys Config Elements
  container = document.getElementById('api-keys-list');
  template = document.getElementById('api-key-row-template');
  addBackupBtn = document.getElementById('add-backup-btn');
  deleteAllBtn = document.getElementById('delete-all-keys-btn');
  failoverCheckbox = document.getElementById('enable-failover');
  rotationCheckbox = document.getElementById('enable-rotation');
  streamingModeCheckbox = document.getElementById('streaming-mode');
  noKeysAlert = document.getElementById('no-keys-alert');
  clearCacheBtn = document.getElementById('clear-cache-btn');

  // Confirmation Modal Elements
  confirmModal = document.getElementById('confirm-modal');
  modalTitle = document.getElementById('modal-title');
  modalMessage = document.getElementById('modal-message');
  modalCancelBtn = document.getElementById('modal-cancel-btn');
  modalConfirmBtn = document.getElementById('modal-confirm-btn');

  loadSettings();
  attachEventListeners();

  // Live Sync: Monitor background changes (e.g., API failures while user is watching)
  if (typeof browser !== 'undefined' && browser.storage) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.yousub_api_keys || changes.yousub_health_stats)) {
        updateRealtimeStatuses();
      }
    });
  }
}

function loadSettings() {
  browser.storage.local.get([
    'targetLang',
    'yousub_api_keys',
    'yousub_failover_enabled',
    'yousub_model_rotation',
    'yousub_streaming_mode',
    'yousub_custom_models',
    'yousub_hidden_models',
    'yousub_health_stats'
  ]).then((items) => {
    // 1. Target Language
    targetLangSelect.value = items.targetLang || 'vi';

    // 2. Default data
    apiKeys = items.yousub_api_keys || [];
    if (apiKeys.length === 0) {
      // Create empty primary key entry
      apiKeys.push(createEmptyKey());
    }

    failoverEnabled = items.yousub_failover_enabled !== false; // default true
    modelRotation = items.yousub_model_rotation || false;
    customModelsRegistry = items.yousub_custom_models || {};
    hiddenModelsRegistry = items.yousub_hidden_models || {};

    failoverCheckbox.checked = failoverEnabled;
    rotationCheckbox.checked = modelRotation;
    if (streamingModeCheckbox) {
      streamingModeCheckbox.checked = items.yousub_streaming_mode || false;
    }

    const healthStats = items.yousub_health_stats || {};
    renderKeysUI(healthStats);
  });
}

function createEmptyKey() {
  return {
    provider: 'auto',
    model: 'auto',
    apiKey: '',
    status: 'untested',
    statusMessage: '',
    testedAt: 0
  };
}

function renderKeysUI(healthStats = {}) {
  container.innerHTML = '';

  let validKeyCount = 0;

  apiKeys.forEach((keyData, index) => {
    if (keyData.apiKey && keyData.apiKey.trim() !== '') {
      validKeyCount++;
    }
    const node = renderSingleRow(keyData, index, healthStats);
    container.appendChild(node);
  });

  // Toggle warning
  if (validKeyCount === 0) {
    noKeysAlert.classList.remove('hidden');
  } else {
    noKeysAlert.classList.add('hidden');
  }

  // Hide/Show "Add Backup" based on max limit (4 limits: 1 primary + 3 backups)
  if (apiKeys.length >= 4) {
    addBackupBtn.classList.add('hidden');
  } else {
    addBackupBtn.classList.remove('hidden');
  }
}

function renderSingleRow(keyData, index, healthStats = {}) {
  const clone = template.content.cloneNode(true);
  const rowDev = clone.querySelector('.api-key-row');
  const title = clone.querySelector('.row-title');
  const deleteBtn = clone.querySelector('.delete-row-btn');
  const disableBtn = clone.querySelector('.toggle-disable-row-btn');
  const resetBtn = clone.querySelector('.reset-row-btn');
  const providerSelect = clone.querySelector('.provider-select');
  const modelInput = clone.querySelector('.model-select');
  const deleteCustomBtn = clone.querySelector('.delete-custom-model-btn');
  const apiKeyInput = clone.querySelector('.api-key-input');
  const visibilityBtn = clone.querySelector('.toggle-visibility-btn');
  const testBtn = clone.querySelector('.test-key-btn');
  const statusText = clone.querySelector('.status-text');
  const healthIndicator = clone.querySelector('.health-indicator');
  const healthDot = clone.querySelector('.health-dot');
  const healthStatsText = clone.querySelector('.health-stats');
  const connectOllamaBtn = clone.querySelector('.connect-ollama-btn');
  const fetchOllamaBtn = clone.querySelector('.fetch-ollama-models-btn');

  const isPrimary = (index === 0);
  rowDev.setAttribute('data-index', index);
  title.textContent = isPrimary ? "Primary Key:" : `Backup Key ${index}:`;

  if (keyData.disabled) {
    rowDev.style.opacity = '0.5';
    disableBtn.textContent = 'Enable';
  } else {
    rowDev.style.opacity = '1';
    disableBtn.textContent = 'Disable';
  }

  disableBtn.addEventListener('click', () => {
    keyData.disabled = !keyData.disabled;
    if (keyData.disabled) {
      rowDev.style.opacity = '0.5';
      disableBtn.textContent = 'Enable';
    } else {
      rowDev.style.opacity = '1';
      disableBtn.textContent = 'Disable';
    }
    debouncedSave();
  });

  resetBtn.addEventListener('click', () => {
    browser.storage.local.get(['yousub_health_stats']).then(res => {
      const stats = res.yousub_health_stats || {};
      const cleanKey = sanitizeKey(keyData.apiKey);
      const keyHash = `${keyData.provider}_${cleanKey.slice(-6)}`;

      if (stats[keyHash]) {
        delete stats[keyHash];
        browser.storage.local.set({ yousub_health_stats: stats }).then(() => {
          keyData.status = 'untested';
          keyData.statusMessage = '';
          debouncedSave();
          // Load updated stats and re-render
          browser.storage.local.get(['yousub_health_stats']).then(r => renderKeysUI(r.yousub_health_stats));
        });
      } else {
        alert("This key is already completely clean. No stats to reset.");
      }
    });
  });

  if (!isPrimary) {
    deleteBtn.classList.remove('hidden');
    deleteBtn.addEventListener('click', () => {
      showConfirmModal(
        'Remove Backup Key',
        `Are you sure you want to remove Backup Key ${index}? This action cannot be undone.`,
        () => {
          apiKeys.splice(index, 1);
          debouncedSave();
          renderKeysUI();
        }
      );
    });
  }

  // Health Stats Logic
  const cleanKeyForRow = sanitizeKey(keyData.apiKey);
  const keyHash = `${keyData.provider}_${cleanKeyForRow.slice(-6)}`;
  const stats = healthStats[keyHash];
  if (stats && (stats.successCount + stats.failCount) > 0) {
    healthIndicator.classList.remove('hidden');
    const total = stats.successCount + stats.failCount;
    const rate = Math.round((stats.successCount / total) * 100);
    const speed = Math.round(stats.avgTime || 0);

    healthStatsText.textContent = `Success: ${rate}% • ${speed}ms`;

    // Dot color
    healthIndicator.className = 'health-indicator';
    if (Date.now() < (stats.circuitBreakerUntil || 0)) {
      healthIndicator.classList.add('broken');
      healthStatsText.textContent = `BROKEN (Cooldown until ${new Date(stats.circuitBreakerUntil).toLocaleTimeString()})`;
    } else if (rate > 90) {
      healthIndicator.classList.add('good');
    } else if (rate > 60) {
      healthIndicator.classList.add('fair');
    } else {
      healthIndicator.classList.add('poor');
    }
  }

  providerSelect.innerHTML = `<option value="auto">-- Auto-Detect --</option>`;
  YOUSUB_PROVIDERS.providers.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    providerSelect.appendChild(opt);
  });
  providerSelect.value = keyData.provider || 'auto';

  // Create unique datalist for this row
  const datalistId = `model-list-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const datalist = document.createElement('datalist');
  datalist.id = datalistId;
  modelInput.setAttribute('list', datalistId);
  modelInput.parentNode.appendChild(datalist);

  const populateModels = () => {
    const provId = providerSelect.value;
    datalist.innerHTML = `<option value="auto">Auto-Select Best Model</option>`;
    if (provId && provId !== 'auto') {
      const models = YOUSUB_PROVIDERS.getModelsForProvider(provId);
      const hidden = hiddenModelsRegistry[provId] || [];

      // Phase 50.3: Handle Ollama specifically
      if (provId === 'ollama') {
        const ollamaModels = keyData.ollamaModels || [];
        if (ollamaModels.length > 0) {
          ollamaModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.name;
            opt.textContent = `${m.name} (Local)`;
            datalist.appendChild(opt);
          });
          return; // Skip static defaults if we have real models
        }
      }

      models.forEach(m => {
        if (!hidden.includes(m.id)) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          datalist.appendChild(opt);
        }
      });
      // Append Custom Models
      if (customModelsRegistry[provId]) {
        customModelsRegistry[provId].forEach(cm => {
          if (!hidden.includes(cm)) {
            const opt = document.createElement('option');
            opt.value = cm;
            opt.textContent = `${cm} (Custom)`;
            datalist.appendChild(opt);
          }
        });
      }
    }
  };

  const checkCustomModelStatus = () => {
    const val = modelInput.value;
    if (val && val !== 'auto' && val.trim().length > 0) {
      deleteCustomBtn.classList.remove('hidden');
    } else {
      deleteCustomBtn.classList.add('hidden');
    }
  };

  const updateOllamaUI = () => {
    const isOllama = providerSelect.value === 'ollama';
    if (isOllama) {
      apiKeyInput.closest('.api-key-input-group').classList.add('hidden');
      connectOllamaBtn.classList.remove('hidden');
      fetchOllamaBtn.classList.remove('hidden');

      // Check permission state
      chrome.permissions.contains({ origins: ['http://localhost/*'] }, (result) => {
        if (result) {
          connectOllamaBtn.textContent = 'Connected to Localhost';
          connectOllamaBtn.disabled = true;
          connectOllamaBtn.classList.add('ok');
        } else {
          connectOllamaBtn.textContent = 'Connect Ollama';
          connectOllamaBtn.disabled = false;
          connectOllamaBtn.classList.remove('ok');
        }
      });
    } else {
      apiKeyInput.closest('.api-key-input-group').classList.remove('hidden');
      connectOllamaBtn.classList.add('hidden');
      fetchOllamaBtn.classList.add('hidden');
    }
  };

  updateOllamaUI();
  populateModels();
  modelInput.value = keyData.model || 'auto';
  checkCustomModelStatus();

  providerSelect.addEventListener('change', (e) => {
    keyData.provider = e.target.value;
    updateOllamaUI();
    populateModels();
    keyData.model = 'auto';
    modelInput.value = 'auto';
    checkCustomModelStatus();
    debouncedSave();
  });

  modelInput.addEventListener('input', (e) => {
    keyData.model = e.target.value;
    checkCustomModelStatus();
    debouncedSave();
  });

  connectOllamaBtn.addEventListener('click', () => {
    chrome.permissions.request({
      origins: ['http://localhost/*']
    }, (granted) => {
      if (granted) {
        updateOllamaUI();
        alert('Permission granted! YouSub can now connect to your local Ollama instance.');
      }
    });
  });

  fetchOllamaBtn.addEventListener('click', () => {
    fetchOllamaBtn.textContent = 'Fetching...';
    chrome.runtime.sendMessage({
      type: 'YOUSUB_FETCH_OLLAMA_MODELS',
      endpoint: 'http://localhost:11434/api/tags'
    }).then(res => {
      fetchOllamaBtn.textContent = 'Refresh Models';
      if (res && res.success && res.models) {
        keyData.ollamaModels = res.models;
        populateModels();
        debouncedSave();
        alert(`Successfully found ${res.models.length} local models!`);
      } else {
        alert('Failed to reach Ollama. Make sure Ollama is running at http://localhost:11434');
      }
    }).catch(err => {
      fetchOllamaBtn.textContent = 'Refresh Models';
      alert('Error: ' + err.message);
    });
  });

  deleteCustomBtn.addEventListener('click', () => {
    const provId = providerSelect.value;
    const val = modelInput.value;
    if (provId === 'auto' || val === 'auto') return;

    showConfirmModal(
      'Delete Custom Model',
      `Are you sure you want to delete the model '${val}'?`,
      () => {
        // If it exists in custom, remove it
        if (customModelsRegistry[provId]) {
          customModelsRegistry[provId] = customModelsRegistry[provId].filter(m => m !== val);
        }

        // If it is built-in, add to hidden registry
        const models = YOUSUB_PROVIDERS.getModelsForProvider(provId);
        const isBuiltin = models.some(m => m.id === val);
        if (isBuiltin) {
          if (!hiddenModelsRegistry[provId]) hiddenModelsRegistry[provId] = [];
          if (!hiddenModelsRegistry[provId].includes(val)) {
            hiddenModelsRegistry[provId].push(val);
          }
        }

        keyData.model = 'auto';
        modelInput.value = 'auto';
        populateModels();
        checkCustomModelStatus();
        debouncedSave();
      }
    );
  });

  apiKeyInput.value = keyData.apiKey || '';
  apiKeyInput.addEventListener('input', (e) => {
    keyData.apiKey = e.target.value.trim();
    if (providerSelect.value === 'auto' && keyData.apiKey.length > 3) {
      const detected = YOUSUB_PROVIDERS.detectProviderFromKey(keyData.apiKey);
      if (detected) {
        providerSelect.value = detected;
        keyData.provider = detected;
        populateModels();
      }
    }
    debouncedSave();
    const hasKeys = apiKeys.some(k => k.apiKey && k.apiKey.length > 0);
    noKeysAlert.classList.toggle('hidden', hasKeys);
  });

  visibilityBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      visibilityBtn.textContent = 'Hide';
    } else {
      apiKeyInput.type = 'password';
      visibilityBtn.textContent = 'Show';
    }
  });

  testBtn.addEventListener('click', () => {
    if (!keyData.apiKey) {
      statusText.className = 'status-text failed';
      statusText.textContent = 'Failed: Empty API Key';
      keyData.status = 'failed';
      keyData.statusMessage = 'Empty key';
      debouncedSave();
      return;
    }

    testBtn.textContent = 'Testing...';
    testBtn.disabled = true;
    statusText.className = 'status-text';
    statusText.textContent = 'Testing connection...';

    browser.runtime.sendMessage({
      type: 'YOUSUB_TEST_API_KEY',
      provider: keyData.provider,
      model: keyData.model,
      apiKey: keyData.apiKey
    }).then((response) => {
      if (response) {
        if (response.success) {
          statusText.classList.add('ok');
          const dateStr = new Date().toISOString().split('T')[0];
          statusText.textContent = `OK (tested ${dateStr})`;
          keyData.status = 'ok';
          keyData.statusMessage = `Tested ${dateStr}`;

          // If custom model tested successfully, save it!
          const provId = keyData.provider;
          const currentModel = keyData.model;
          if (provId && provId !== 'auto' && currentModel && currentModel !== 'auto') {
            const builtinModels = YOUSUB_PROVIDERS.getModelsForProvider(provId);
            const isBuiltin = builtinModels.some(m => m.id === currentModel);
            if (!isBuiltin) {
              if (!customModelsRegistry[provId]) customModelsRegistry[provId] = [];
              if (!customModelsRegistry[provId].includes(currentModel)) {
                customModelsRegistry[provId].push(currentModel);
                populateModels();
                checkCustomModelStatus();
              }
            }
          }
        } else {
          statusText.classList.add('failed');
          statusText.textContent = `Failed: ${response.message}`;
          keyData.status = 'failed';
          keyData.statusMessage = response.message;
        }
      }
      keyData.testedAt = Date.now();
      testBtn.textContent = 'Test';
      testBtn.disabled = false;
      debouncedSave();
    }).catch((err) => {
      statusText.classList.add('failed');
      statusText.textContent = 'Failed: Extension error';
      keyData.status = 'failed';
      testBtn.textContent = 'Test';
      testBtn.disabled = false;
    });
  });

  if (keyData.status === 'ok') {
    statusText.classList.add('ok');
    statusText.textContent = keyData.statusMessage ? `OK (${keyData.statusMessage})` : 'OK';
  } else if (keyData.status === 'failed') {
    statusText.classList.add('failed');
    statusText.textContent = keyData.statusMessage ? `Failed: ${keyData.statusMessage}` : 'Failed';
  } else {
    statusText.classList.add('untested');
    statusText.textContent = '-- Not tested --';
  }

  // Set initial classes for real-time updates
  if (keyData.status === 'failed') {
    statusText.classList.add('pulse-red');
  }

  return clone;
}

/**
 * Updates only the status and health indicators of existing rows without full re-render.
 * This preserves user focus and unsaved input in the fields.
 */
function updateRealtimeStatuses() {
  browser.storage.local.get(['yousub_api_keys', 'yousub_health_stats']).then((items) => {
    const keys = items.yousub_api_keys || [];
    const healthStats = items.yousub_health_stats || {};

    keys.forEach((keyData, index) => {
      const row = container.querySelector(`.api-key-row[data-index="${index}"]`);
      if (!row) return;

      // Update Status Text
      const statusText = row.querySelector('.status-text');
      if (statusText) {
        statusText.className = 'status-text';
        if (keyData.status === 'ok') {
          statusText.classList.add('ok');
          statusText.textContent = keyData.statusMessage ? `OK (${keyData.statusMessage})` : 'OK';
        } else if (keyData.status === 'failed') {
          statusText.classList.add('failed');
          statusText.classList.add('pulse-red');
          statusText.textContent = keyData.statusMessage ? `Failed: ${keyData.statusMessage}` : 'Failed';
        } else {
          statusText.classList.add('untested');
          statusText.textContent = '-- Not tested --';
        }
      }

      // Update Health Indicator
      const healthIndicator = row.querySelector('.health-indicator');
      const healthStatsText = row.querySelector('.health-stats');
      const cleanKeyForUpdate = sanitizeKey(keyData.apiKey);
      const keyHash = `${keyData.provider}_${cleanKeyForUpdate.slice(-6)}`;
      const stats = healthStats[keyHash];
      
      // Phase 41: Special Sync - If stats show healthy, override 'failed' status in UI
      if (stats && stats.successCount > 0 && Date.now() > (stats.circuitBreakerUntil || 0)) {
        if (keyData.status === 'failed') {
          keyData.status = 'ok';
          keyData.statusMessage = 'Recovered';
        }
      }

      if (healthIndicator) {
        if (stats && (stats.successCount + stats.failCount) > 0) {
          healthIndicator.classList.remove('hidden');
          const total = stats.successCount + stats.failCount;
          const rate = Math.round((stats.successCount / total) * 100);
          const speed = Math.round(stats.avgTime || 0);

          healthStatsText.textContent = `Success: ${rate}% • ${speed}ms`;
          healthIndicator.className = 'health-indicator';
          
          if (Date.now() < (stats.circuitBreakerUntil || 0)) {
            healthIndicator.classList.add('broken');
            healthStatsText.textContent = `BROKEN (Cooldown until ${new Date(stats.circuitBreakerUntil).toLocaleTimeString()})`;
          } else if (rate > 90) {
            healthIndicator.classList.add('good');
          } else if (rate > 60) {
            healthIndicator.classList.add('fair');
          } else {
            healthIndicator.classList.add('poor');
          }
        } else {
          healthIndicator.classList.add('hidden');
        }
      }
    });

    // Update the local apiKeys reference if the user is NOT actively typing
    // We check if any input has focus
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT')) {
      // Don't merge data yet to avoid overwriting current input
    } else {
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
    showConfirmModal(
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
      showConfirmModal(
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

/**
 * Shows a custom confirmation modal
 * @param {string} title
 * @param {string} message
 * @param {function} onConfirm
 */
function showConfirmModal(title, message, onConfirm) {
  if (!confirmModal) return;

  modalTitle.textContent = title;
  modalMessage.textContent = message;

  const handleConfirm = () => {
    closeModal();
    onConfirm();
  };

  const handleCancel = () => {
    closeModal();
  };

  const closeModal = () => {
    confirmModal.classList.add('hidden');
    modalConfirmBtn.removeEventListener('click', handleConfirm);
    modalCancelBtn.removeEventListener('click', handleCancel);
  };

  modalConfirmBtn.addEventListener('click', handleConfirm);
  modalCancelBtn.addEventListener('click', handleCancel);

  // Close on backdrop click
  confirmModal.onclick = (e) => {
    if (e.target === confirmModal) closeModal();
  };

  confirmModal.classList.remove('hidden');
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
    yousub_hidden_models: hiddenModelsRegistry
  };
  browser.storage.local.set(settings).then(() => {
    if (triggerSaveCallback) triggerSaveCallback();
  });
}
