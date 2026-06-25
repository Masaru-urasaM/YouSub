import { Logger } from '../shared/logger.js';
import { Constants } from '../shared/constants.js';
import { applyI18n } from '../shared/i18n.js';
import { initTranslationTab } from './tab-translation.js';
import { initAppearanceTab } from './tab-appearance.js';

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

// State
let saveTimeout = null;

// DOM Elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');
const saveStatus = document.getElementById('save-status');
const resetBtn = document.getElementById('reset-btn');
const exportLogsBtn = document.getElementById('export-logs-btn');

function init() {
  // Localize static markup first (graceful fallback keeps English if missing).
  applyI18n(document);
  setVersionStrings();
  setupTabs();

  // Initialize Tabs
  initTranslationTab(showSaveIndicator);
  initAppearanceTab(showSaveIndicator);

  attachGlobalEventListeners();
}

function setVersionStrings() {
  const badge = document.getElementById('version-badge');
  if (badge) badge.textContent = `v${Constants.VERSION}`;
  const aboutVersion = document.getElementById('about-version');
  if (aboutVersion) aboutVersion.textContent = `Version ${Constants.VERSION}`;
}

function activateTab(btn) {
  // Remove active class from all
  tabBtns.forEach((b) => {
    b.classList.remove('active');
    b.setAttribute('aria-selected', 'false');
    b.setAttribute('tabindex', '-1');
  });
  tabPanes.forEach((p) => p.classList.remove('active'));

  // Add active class to selected tab and its content
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  btn.setAttribute('tabindex', '0');
  const targetId = btn.getAttribute('data-target');
  document.getElementById(targetId).classList.add('active');
}

function setupTabs() {
  tabBtns.forEach((btn, index) => {
    btn.addEventListener('click', () => activateTab(btn));

    // ARIA tab pattern: ArrowLeft/ArrowRight move focus & activate
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const next = tabBtns[(index + dir + tabBtns.length) % tabBtns.length];
      activateTab(next);
      next.focus();
    });
  });
}

export function showSaveIndicator() {
  saveStatus.textContent = i18n('optionsSaved', 'Saved');
  saveStatus.classList.add('show-saved');

  if (saveTimeout) clearTimeout(saveTimeout);

  saveTimeout = setTimeout(() => {
    saveStatus.textContent = i18n('optionsSavedAuto', 'All changes saved automatically.');
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
