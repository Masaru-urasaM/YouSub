document.addEventListener('DOMContentLoaded', function() {
  const getSubBtn = document.getElementById('get-sub-btn');
  const openSettingsBtn = document.getElementById('open-settings-btn');
  const statusText = document.getElementById('status-text');
  const loadingDiv = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');

  const dualModeToggle = document.getElementById('dual-mode-toggle');
  const healthStatus = document.getElementById('health-status');
  const healthText = document.getElementById('health-text');

  // Load health status
  function checkHealth() {
    browser.storage.local.get(['yousub_api_keys']).then(function(res) {
      const keys = res.yousub_api_keys || [];
      const hasKeys = keys.length > 0;
      const allFailed = hasKeys && keys.every(k => k.status === 'failed');
      const someFailed = hasKeys && keys.some(k => k.status === 'failed');

      if (!hasKeys) {
        healthStatus.classList.remove('hidden');
        healthStatus.className = 'health-indicator health-error';
        healthText.textContent = 'API Not Configured';
      } else if (allFailed) {
        healthStatus.classList.remove('hidden');
        healthStatus.className = 'health-indicator health-error';
        healthText.textContent = 'All APIs failing';
      } else if (someFailed) {
        healthStatus.classList.remove('hidden');
        healthStatus.className = 'health-indicator health-warning';
        healthText.textContent = 'Some APIs offline';
      } else {
        healthStatus.classList.remove('hidden');
        healthStatus.className = 'health-indicator';
        healthText.textContent = 'API Healthy';
      }
    });
  }

  // Load current Dual Mode state
  browser.storage.local.get(['yousub_dual_mode']).then(function(res) {
    dualModeToggle.checked = !!res.yousub_dual_mode;
  });

  checkHealth();

  dualModeToggle.addEventListener('change', function() {
    const isEnabled = dualModeToggle.checked;
    
    // Save to storage
    browser.storage.local.set({ yousub_dual_mode: isEnabled });

    // Inform active tab content script
    browser.tabs.query({ active: true, currentWindow: true }).then(function(tabs) {
      if (tabs[0] && tabs[0].url.includes('youtube.com/watch')) {
        browser.tabs.sendMessage(tabs[0].id, {
          type: 'YOUSUB_TOGGLE_DUAL_MODE',
          enabled: isEnabled
        });
      }
    });
  });

  openSettingsBtn.addEventListener('click', function() {
    browser.runtime.openOptionsPage();
  });

  getSubBtn.addEventListener('click', function() {
    // UI Update
    getSubBtn.disabled = true;
    loadingDiv.classList.remove('hidden');
    statusText.textContent = "Processing...";
    loadingText.textContent = "Extracting transcript...";

    // Get active tab
    browser.tabs.query({ active: true, currentWindow: true }).then(function(tabs) {
      const activeTab = tabs[0];
      
      if (!activeTab || !activeTab.url.includes('youtube.com/watch')) {
        showError("Please open a YouTube video first.");
        return;
      }

      // Load language preference and API keys from storage
      browser.storage.local.get(['targetLang', 'yousub_api_keys']).then(function(result) {
        const lang = result.targetLang || 'vi';
        const apiKeys = result.yousub_api_keys || [];
        
        // Gate Logic: Check for valid API Keys
        const hasValidKey = apiKeys.some(k => k.apiKey && k.apiKey.trim().length > 0);
        if (!hasValidKey) {
          showError("Please configure an API key in Settings.");
          // Open options page automatically
          setTimeout(() => browser.runtime.openOptionsPage(), 1500);
          return;
        }

        // Send start message to content script
        browser.tabs.sendMessage(activeTab.id, { 
          type: 'YOUSUB_START_EXTRACTION',
          targetLang: lang
        }).then(function(response) {
          if (response && response.started) {
            loadingText.textContent = "Translating...";
            // For MVP, we just wait a bit or let the user close the popup
            setTimeout(() => {
              statusText.textContent = "Request sent! Check console for progress.";
              getSubBtn.disabled = false;
              loadingDiv.classList.add('hidden');
            }, 3000);
          }
        }).catch(function(err) {
          showError("Please refresh the YouTube page and try again.");
        });
      });
    });
  });

  function showError(msg) {
    statusText.textContent = msg;
    statusText.style.color = "#ff1744";
    getSubBtn.disabled = false;
    loadingDiv.classList.add('hidden');
  }
});
