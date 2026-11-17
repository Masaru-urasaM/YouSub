import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';
import { applyI18n } from '../shared/i18n.js';

/**
 * Helper to remove non-printable and zero-width characters from API keys.
 */
export const sanitizeKey = (key) => {
  if (!key) return '';
  // eslint-disable-next-line no-control-regex -- intentional: strips control/zero-width chars
  return key.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
};

export function buildQuotaDisplay(response, providerId) {
  const parts = [];

  if (response.usage?.totalTokens) {
    parts.push(`Test: ${response.usage.totalTokens} tok`);
  }

  const rl = response.rateLimit;
  if (rl?.limitTokens) {
    const rem = rl.remainingTokens ?? 0;
    const lim = rl.limitTokens;
    const pct = Math.round((rem / lim) * 100);
    const cls = pct < 3 ? 'quota-danger' : pct < 10 ? 'quota-warn' : '';
    const wrap = cls ? `<span class="${cls}">` : '<span>';
    parts.push(
      `${wrap}Remaining: ${rem.toLocaleString()}/${lim.toLocaleString()} tok/min (${pct}%)</span>`
    );
  }

  if (rl?.limitRequests) {
    const remR = rl.remainingRequests ?? 0;
    parts.push(`Requests: ${remR.toLocaleString()}/${rl.limitRequests.toLocaleString()}/min`);
  }

  if (providerId === 'anthropic' && rl?.inputTokensLimit) {
    const inRem = rl.inputTokensRemaining ?? 0;
    const outRem = rl.outputTokensRemaining ?? 0;
    parts.push(
      `In: ${inRem.toLocaleString()}/${rl.inputTokensLimit.toLocaleString()} · Out: ${outRem.toLocaleString()}/${rl.outputTokensLimit.toLocaleString()}`
    );
  }

  const q = response.quota;
  if (q) {
    const sym = q.currency === 'USD' ? '$' : q.currency === 'CNY' ? '¥' : `${q.currency} `;
    if (q.credits.used != null && q.credits.limit != null) {
      const pct = Math.round((q.credits.used / q.credits.limit) * 100);
      const cls = pct > 90 ? 'quota-danger' : pct > 80 ? 'quota-warn' : '';
      const wrap = cls ? `<span class="${cls}">` : '<span>';
      parts.push(
        `${wrap}Credits: ${sym}${q.credits.used.toFixed(2)}/${sym}${q.credits.limit.toFixed(2)} used (${pct}%)</span>`
      );
    } else if (q.credits.used != null && q.credits.limit == null) {
      parts.push(`Used: ${sym}${q.credits.used.toFixed(2)} (free tier)`);
    } else if (q.credits.remaining != null) {
      const cls = q.credits.remaining <= 0 ? 'quota-danger' : '';
      const wrap = cls ? `<span class="${cls}">` : '<span>';
      parts.push(`${wrap}Balance: ${sym}${q.credits.remaining.toFixed(2)} remaining</span>`);
    }
  }

  if (parts.length === 0) return '';

  if (providerId === 'ollama' && parts.length === 1) {
    parts.push('Local model');
  }

  return parts.join(' · ');
}

export function applyRowStatusText(statusText, keyData, i18n, resetClass = false) {
  if (!statusText) return;
  if (resetClass) statusText.className = 'status-text';

  if (keyData.status === 'ok') {
    statusText.classList.add('ok');
    statusText.textContent = keyData.statusMessage ? `OK (${keyData.statusMessage})` : 'OK';
  } else if (keyData.status === 'failed') {
    statusText.classList.add('failed', 'pulse-red');
    statusText.textContent = keyData.statusMessage ? `Failed: ${keyData.statusMessage}` : 'Failed';
  } else {
    statusText.classList.add('untested');
    statusText.textContent = i18n('optionsRowNotTested', '-- Not tested --');
  }
}

export function applyRowHealthBadge(
  healthIndicator,
  healthStatsText,
  stats,
  hideWhenEmpty = false
) {
  if (!healthIndicator) return;
  if (stats && stats.successCount + stats.failCount > 0) {
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
  } else if (hideWhenEmpty) {
    healthIndicator.classList.add('hidden');
  }
}

export function renderSingleRow(keyData, index, healthStats = {}, ctx) {
  const {
    template,
    getApiKeys,
    getCustomModels,
    getHiddenModels,
    noKeysAlert,
    showModal,
    debouncedSave,
    rerenderKeys,
    i18n,
  } = ctx;

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
  const healthStatsText = clone.querySelector('.health-stats');
  const connectOllamaBtn = clone.querySelector('.connect-ollama-btn');
  const fetchOllamaBtn = clone.querySelector('.fetch-ollama-models-btn');

  applyI18n(clone);

  const isPrimary = index === 0;
  rowDev.setAttribute('data-index', index);
  title.textContent = isPrimary
    ? i18n('optionsRowPrimaryKey', 'Primary Key:')
    : i18n('optionsRowBackupKey', `Backup Key ${index}:`).replace('{index}', index);

  const syncDisabledUI = () => {
    if (keyData.disabled) {
      rowDev.style.opacity = '0.5';
      disableBtn.textContent = i18n('optionsRowEnable', 'Enable');
    } else {
      rowDev.style.opacity = '1';
      disableBtn.textContent = i18n('optionsRowDisable', 'Disable');
    }
  };
  syncDisabledUI();

  disableBtn.addEventListener('click', () => {
    keyData.disabled = !keyData.disabled;
    syncDisabledUI();
    debouncedSave();
  });

  resetBtn.addEventListener('click', () => {
    browser.storage.local.get(['yousub_health_stats']).then((res) => {
      const stats = res.yousub_health_stats || {};
      const cleanKey = sanitizeKey(keyData.apiKey);
      const keyHash = `${keyData.provider}_${cleanKey.slice(-6)}`;

      if (stats[keyHash]) {
        delete stats[keyHash];
        browser.storage.local.set({ yousub_health_stats: stats }).then(() => {
          keyData.status = 'untested';
          keyData.statusMessage = '';
          debouncedSave();
          browser.storage.local
            .get(['yousub_health_stats'])
            .then((r) => rerenderKeys(r.yousub_health_stats));
        });
      } else {
        alert('This key is already completely clean. No stats to reset.');
      }
    });
  });

  if (!isPrimary) {
    deleteBtn.classList.remove('hidden');
    deleteBtn.addEventListener('click', () => {
      showModal(
        'Remove Backup Key',
        `Are you sure you want to remove Backup Key ${index}? This action cannot be undone.`,
        () => {
          getApiKeys().splice(index, 1);
          debouncedSave();
          rerenderKeys();
        }
      );
    });
  }

  const cleanKeyForRow = sanitizeKey(keyData.apiKey);
  const keyHash = `${keyData.provider}_${cleanKeyForRow.slice(-6)}`;
  applyRowHealthBadge(healthIndicator, healthStatsText, healthStats[keyHash], false);

  providerSelect.innerHTML = `<option value="auto">-- Auto-Detect --</option>`;
  YOUSUB_PROVIDERS.providers.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    providerSelect.appendChild(opt);
  });
  providerSelect.value = keyData.provider || 'auto';

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
      const hidden = getHiddenModels()[provId] || [];

      if (provId === 'ollama') {
        const ollamaModels = keyData.ollamaModels || [];
        if (ollamaModels.length > 0) {
          ollamaModels.forEach((m) => {
            const opt = document.createElement('option');
            opt.value = m.name;
            opt.textContent = `${m.name} (Local)`;
            datalist.appendChild(opt);
          });
          return;
        }
      }

      models.forEach((m) => {
        if (!hidden.includes(m.id)) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          datalist.appendChild(opt);
        }
      });

      const customForProv = getCustomModels()[provId];
      if (customForProv) {
        customForProv.forEach((cm) => {
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

      browser.permissions.contains({ origins: ['http://localhost/*'] }).then((result) => {
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
    browser.permissions.request({ origins: ['http://localhost/*'] }).then((granted) => {
      if (granted) {
        updateOllamaUI();
        alert('Permission granted! YouSub can now connect to your local Ollama instance.');
      }
    });
  });

  fetchOllamaBtn.addEventListener('click', () => {
    fetchOllamaBtn.textContent = 'Fetching...';
    browser.runtime
      .sendMessage({
        type: 'YOUSUB_FETCH_OLLAMA_MODELS',
        endpoint: 'http://localhost:11434/api/tags',
      })
      .then((res) => {
        fetchOllamaBtn.textContent = 'Refresh Models';
        if (res && res.success && res.models) {
          keyData.ollamaModels = res.models;
          populateModels();
          debouncedSave();
          alert(`Successfully found ${res.models.length} local models!`);
        } else {
          alert('Failed to reach Ollama. Make sure Ollama is running at http://localhost:11434');
        }
      })
      .catch((err) => {
        fetchOllamaBtn.textContent = 'Refresh Models';
        alert('Error: ' + err.message);
      });
  });

  deleteCustomBtn.addEventListener('click', () => {
    const provId = providerSelect.value;
    const val = modelInput.value;
    if (provId === 'auto' || val === 'auto') return;

    showModal('Delete Custom Model', `Are you sure you want to delete the model '${val}'?`, () => {
      const customModelsRegistry = getCustomModels();
      const hiddenModelsRegistry = getHiddenModels();

      if (customModelsRegistry[provId]) {
        customModelsRegistry[provId] = customModelsRegistry[provId].filter((m) => m !== val);
      }

      const models = YOUSUB_PROVIDERS.getModelsForProvider(provId);
      const isBuiltin = models.some((m) => m.id === val);
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
    });
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
    const hasKeys = getApiKeys().some((k) => k.apiKey && k.apiKey.length > 0);
    noKeysAlert.classList.toggle('hidden', hasKeys);
  });

  visibilityBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      visibilityBtn.textContent = i18n('optionsRowHide', 'Hide');
    } else {
      apiKeyInput.type = 'password';
      visibilityBtn.textContent = i18n('optionsRowShow', 'Show');
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

    browser.runtime
      .sendMessage({
        type: 'YOUSUB_TEST_API_KEY',
        provider: keyData.provider,
        model: keyData.model,
        apiKey: keyData.apiKey,
      })
      .then((response) => {
        if (response) {
          if (response.success) {
            statusText.classList.add('ok');
            const dateStr = new Date().toISOString().split('T')[0];
            statusText.textContent = `OK (tested ${dateStr})`;
            keyData.status = 'ok';
            keyData.statusMessage = `Tested ${dateStr}`;

            let existingQuota = rowDev.querySelector('.quota-detail');
            if (!existingQuota) {
              existingQuota = document.createElement('span');
              existingQuota.className = 'quota-detail';
              statusText.parentNode.appendChild(existingQuota);
            }
            const resolvedProvider =
              keyData.provider === 'auto'
                ? YOUSUB_PROVIDERS.detectProviderFromKey(keyData.apiKey) || 'unknown'
                : keyData.provider;
            existingQuota.innerHTML = buildQuotaDisplay(response, resolvedProvider);

            const provId = keyData.provider;
            const currentModel = keyData.model;
            if (provId && provId !== 'auto' && currentModel && currentModel !== 'auto') {
              const builtinModels = YOUSUB_PROVIDERS.getModelsForProvider(provId);
              const isBuiltin = builtinModels.some((m) => m.id === currentModel);
              if (!isBuiltin) {
                const customModelsRegistry = getCustomModels();
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
      })
      .catch(() => {
        statusText.classList.add('failed');
        statusText.textContent = 'Failed: Extension error';
        keyData.status = 'failed';
        testBtn.textContent = 'Test';
        testBtn.disabled = false;
      });
  });

  applyRowStatusText(statusText, keyData, i18n, false);

  return clone;
}
