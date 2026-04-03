document.addEventListener('DOMContentLoaded', function() {
  const getSubBtn = document.getElementById('get-sub-btn');
  const targetLangSelect = document.getElementById('target-lang');
  const statusText = document.getElementById('status-text');
  const loadingDiv = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');

  // Load saved preference
  chrome.storage.local.get(['targetLang'], function(result) {
    if (result.targetLang) {
      targetLangSelect.value = result.targetLang;
    }
  });

  targetLangSelect.addEventListener('change', function() {
    chrome.storage.local.set({ targetLang: targetLangSelect.value });
  });

  getSubBtn.addEventListener('click', function() {
    // UI Update
    getSubBtn.disabled = true;
    loadingDiv.classList.remove('hidden');
    statusText.textContent = "Processing...";
    loadingText.textContent = "Extracting transcript...";

    // Get active tab
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      const activeTab = tabs[0];
      
      if (!activeTab || !activeTab.url.includes('youtube.com/watch')) {
        showError("Please open a YouTube video first.");
        return;
      }

      // Send start message to content script
      chrome.tabs.sendMessage(activeTab.id, { 
        action: 'YOUSUB_START_EXTRACTION',
        targetLang: targetLangSelect.value
      }, function(response) {
        if (chrome.runtime.lastError) {
          showError("Please refresh the YouTube page and try again.");
          return;
        }

        if (response && response.started) {
          loadingText.textContent = "Translating...";
          // Listen for progress/completion from background or content script
          // For MVP, we just wait a bit or let the user close the popup
          setTimeout(() => {
            statusText.textContent = "Request sent! Check console for progress.";
            getSubBtn.disabled = false;
            loadingDiv.classList.add('hidden');
          }, 3000);
        }
      });
    });
  });

  function showError(msg) {
    statusText.textContent = msg;
    statusText.style.color = "red";
    getSubBtn.disabled = false;
    loadingDiv.classList.add('hidden');
  }
});
