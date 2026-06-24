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

function init() {
  setupTabs();

  // Initialize Tabs
  initTranslationTab(showSaveIndicator);
  initAppearanceTab(showSaveIndicator);

  attachGlobalEventListeners();
}

function setupTabs() {
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      // Remove active class from all
      tabBtns.forEach((b) => b.classList.remove('active'));
      tabPanes.forEach((p) => p.classList.remove('active'));

      // Add active class to clicked tab and its content
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');
    });
  });
}

export function showSaveIndicator() {
  saveStatus.textContent = 'Saved';
  saveStatus.classList.add('show-saved');

  if (saveTimeout) clearTimeout(saveTimeout);

  saveTimeout = setTimeout(() => {
    saveStatus.textContent = 'All changes saved automatically.';
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
}

async function exportLogs() {
  saveStatus.textContent = 'Exporting logs...';

  try {
    const count = await Logger.export();
    if (count === null) {
      saveStatus.textContent = 'No logs to export.';
    } else {
      saveStatus.textContent = `Exported ${count} log entries.`;
      setTimeout(() => showSaveIndicator(), 2000);
    }
  } catch (e) {
    Logger.error('Options', 'Export failed', { error: e.message });
    saveStatus.textContent = 'Failed to export logs.';
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
