import { YOUSUB_PROVIDERS } from '../shared/providers-registry.js';

document.addEventListener('DOMContentLoaded', function () {
  const getSubBtn = document.getElementById('get-sub-btn');
  const clearPageCacheBtn = document.getElementById('clear-page-cache-btn');
  const openSettingsBtn = document.getElementById('open-settings-btn');
  const loadingDiv = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');

  const dualModeToggle = document.getElementById('dual-mode-toggle');
  const healthStatus = document.getElementById('health-status');
  const healthText = document.getElementById('health-text');

  // Modal Elements
  const confirmModal = document.getElementById('confirm-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalMessage = document.getElementById('modal-message');
  const modalCancelBtn = document.getElementById('modal-cancel-btn');
  const modalConfirmBtn = document.getElementById('modal-confirm-btn');

  let currentLang = 'vi';

  // Load and apply initial states
  browser.storage.local.get(['targetLang', 'yousub_api_keys', 'yousub_dual_mode', 'yousub_translation_enabled']).then(async function (res) {
    currentLang = res.targetLang || 'vi';

    // Update button text with full language name
    const langObj = YOUSUB_PROVIDERS.languages.find(l => l.code === currentLang);
    const langName = langObj ? langObj.name.toUpperCase() : currentLang.toUpperCase();
    getSubBtn.textContent = `Translate to ${langName}`;

    // Update toggle state: ONLY active if global enabled is true AND it exists in cache
    if (res.yousub_translation_enabled) {
      const videoId = await getCurrentVideoId();
      if (videoId) {
        const check = await browser.runtime.sendMessage({
          type: 'YOUSUB_CHECK_CACHE',
          videoId,
          targetLang: currentLang
        });

        if (check && check.exists) {
          getSubBtn.classList.add('active');
        } else {
          // New video: Force inactive until clicked
          getSubBtn.classList.remove('active');
        }
      }
    }

    dualModeToggle.checked = !!res.yousub_dual_mode;
    checkHealth(res.yousub_api_keys || []);

    // Show/Hide Clear Cache button
    const videoId = await getCurrentVideoId();
    if (videoId) {
      clearPageCacheBtn.classList.remove('hidden');
    }
  });

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
    } catch (e) { }
    return null;
  }

  function checkHealth(keys) {
    const hasKeys = keys.length > 0;
    const onlineKeys = keys.filter(k => k.status === 'success' || (k.key && !k.status)); // Simple heuristic
    const allFailed = hasKeys && keys.every(k => k.status === 'failed');

    healthStatus.classList.remove('hidden');
    if (!hasKeys) {
      healthStatus.className = 'health-indicator health-error';
      healthText.textContent = 'API Not Configured';
    } else if (allFailed) {
      healthStatus.className = 'health-indicator health-error';
      healthText.textContent = 'All APIs Offline';
    } else if (onlineKeys.length > 0) {
      healthStatus.className = 'health-indicator';

      // Build list of online models
      const modelNames = onlineKeys.map(k => {
        const provider = YOUSUB_PROVIDERS.getProvider(k.provider);
        const model = provider ? (provider.models.find(m => m.id === k.model) || { name: k.model }) : { name: k.model };
        return `${model.name} (Online)`;
      });

      healthText.innerHTML = modelNames.join('<br>');
    } else {
      healthStatus.className = 'health-indicator health-warning';
      healthText.textContent = 'Checking APIs...';
    }
  }

  dualModeToggle.addEventListener('change', function () {
    const isEnabled = dualModeToggle.checked;
    browser.storage.local.set({ yousub_dual_mode: isEnabled });

    sendMessageToActiveTab({
      type: 'YOUSUB_TOGGLE_DUAL_MODE',
      enabled: isEnabled
    });
  });

  openSettingsBtn.addEventListener('click', function () {
    browser.runtime.openOptionsPage();
  });

  clearPageCacheBtn.addEventListener('click', async function () {
    const videoId = await getCurrentVideoId();
    if (!videoId) return;

    showConfirmModal(
      'Clear Cache',
      'Delete translation cache for this video?',
      () => {
        clearPageCacheBtn.disabled = true;
        clearPageCacheBtn.textContent = 'Clearing...';

        browser.runtime.sendMessage({
          type: 'YOUSUB_CLEAR_VIDEO_CACHE',
          videoId
        }).then(res => {
          if (res.success) {
            clearPageCacheBtn.textContent = 'Cache Cleared!';
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
              targetLang: currentLang
            });
          } else {
            clearPageCacheBtn.textContent = 'Error clearing';
            setTimeout(() => {
              clearPageCacheBtn.disabled = false;
              clearPageCacheBtn.textContent = 'Clear Page Cache';
            }, 2000);
          }
        });
      }
    );
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
      targetLang: currentLang
    });
  });

  function sendMessageToActiveTab(msg) {
    browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      if (tabs[0] && tabs[0].url.includes('youtube.com/watch')) {
        browser.tabs.sendMessage(tabs[0].id, msg).catch(() => { });
      }
    });
  }

  function showError(msg) {
    console.error(`YouSub Error: ${msg}`);
    getSubBtn.classList.remove('active');
    browser.storage.local.set({ yousub_translation_enabled: false });
  }

  /**
   * Shows a custom confirmation modal within the popup
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
});
