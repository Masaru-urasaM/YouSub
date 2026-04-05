import { Logger } from '../shared/logger.js';
import { initTranslationTab } from './tab-translation.js';
import { initAppearanceTab } from './tab-appearance.js';

// State
let saveTimeout = null;

// DOM Elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');
const saveStatus = document.getElementById('save-status');
const resetBtn = document.getElementById('reset-btn');
const exportLogsBtn = document.getElementById('export-logs-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');

function init() {
  setupTabs();
  
  // Initialize Tabs
  initTranslationTab(showSaveIndicator);
  initAppearanceTab(showSaveIndicator);
  
  attachGlobalEventListeners();
}

function setupTabs() {
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Remove active class from all
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      // Add active class to clicked tab and its content
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');
    });
  });
}

export function showSaveIndicator() {
  saveStatus.textContent = "Saved";
  saveStatus.classList.add('show-saved');
  
  if (saveTimeout) clearTimeout(saveTimeout);
  
  saveTimeout = setTimeout(() => {
    saveStatus.textContent = "All changes saved automatically.";
    saveStatus.classList.remove('show-saved');
  }, 2000);
}

function attachGlobalEventListeners() {
  // Reset settings
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear ALL settings? This cannot be undone.')) {
        browser.storage.local.clear().then(() => {
          browser.storage.local.set({ targetLang: 'vi' }).then(() => {
            location.reload();
          });
        });
      }
    });
  }

  if (exportLogsBtn) {
    exportLogsBtn.addEventListener('click', exportLogs);
  }

  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', () => {
      if (confirm('Clear all cached translations?')) {
        browser.runtime.sendMessage({ type: 'YOUSUB_CLEAR_CACHE' }).then((response) => {
          if (response && response.success) {
            alert('Cache cleared successfully.');
          } else {
            alert('Error clearing cache: ' + (response ? response.error : 'Unknown error'));
          }
        });
      }
    });
  }
}

async function exportLogs() {
  saveStatus.textContent = "Exporting logs...";
  
  try {
    browser.storage.local.get(['yousub_logs']).then((res) => {
      const logs = res.yousub_logs || [];
      if (logs.length === 0) {
        alert("No logs found in storage.");
        saveStatus.textContent = "No logs to export.";
        return;
      }

      const content = logs.join('\n');
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const filename = `yousub_logs_${timestamp}.jsonl`;

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        saveStatus.textContent = "Logs exported successfully!";
        setTimeout(() => showSaveIndicator(), 2000);
      }, 100);
    });
  } catch (e) {
    console.error('[Options] Export failed:', e);
    saveStatus.textContent = "Failed to export logs.";
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
