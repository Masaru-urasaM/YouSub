import { Logger } from '../shared/logger.js';

let fontSizeInput, fontSizeVal, fontColorInput, fontColorHex, bgOpacityInput, bgOpacityVal, posBottomInput, posBottomVal, previewOverlay;
let triggerSaveCallback = null;
let saveTimeout = null;

export function initAppearanceTab(saveIndicatorCallback) {
  triggerSaveCallback = saveIndicatorCallback;

  // Input Elements
  fontSizeInput = document.getElementById('font-size');
  fontSizeVal = document.getElementById('font-size-val');
  fontColorInput = document.getElementById('font-color');
  fontColorHex = document.getElementById('font-color-hex');
  bgOpacityInput = document.getElementById('bg-opacity');
  bgOpacityVal = document.getElementById('bg-opacity-val');
  posBottomInput = document.getElementById('pos-bottom');
  posBottomVal = document.getElementById('pos-bottom-val');
  
  // Preview Element
  previewOverlay = document.getElementById('subtitle-preview');

  loadSettings();
  attachEventListeners();
}

function loadSettings() {
  chrome.storage.local.get(['yousub_appearance'], (res) => {
    const styles = res.yousub_appearance || {
      fontSize: 1.6,
      fontColor: '#ffffff',
      bgOpacity: 0.75,
      posBottom: 80
    };

    // Update Inputs
    fontSizeInput.value = styles.fontSize;
    fontColorInput.value = styles.fontColor;
    bgOpacityInput.value = styles.bgOpacity;
    posBottomInput.value = styles.posBottom;

    updateUIStrings();
    updatePreview();
  });
}

function attachEventListeners() {
  const inputs = [fontSizeInput, fontColorInput, bgOpacityInput, posBottomInput];
  
  inputs.forEach(input => {
    input.addEventListener('input', () => {
      updateUIStrings();
      updatePreview();
      debouncedSave();
    });
  });
}

function updateUIStrings() {
  fontSizeVal.textContent = fontSizeInput.value;
  fontColorHex.textContent = fontColorInput.value.toUpperCase();
  bgOpacityVal.textContent = Math.round(bgOpacityInput.value * 100) + '%';
  posBottomVal.textContent = posBottomInput.value + 'px';
}

function updatePreview() {
  if (!previewOverlay) return;

  const styles = {
    fontSize: fontSizeInput.value + 'em',
    color: fontColorInput.value,
    backgroundColor: `rgba(0, 0, 0, ${bgOpacityInput.value})`,
    bottom: (posBottomInput.value / 10) + '%' // Scale offset for preview container
  };

  Object.assign(previewOverlay.style, styles);
}

function debouncedSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveAppearance, 500);
}

function loadAppearance() {
  browser.storage.local.get(['yousub_appearance']).then((res) => {
    const appearance = res.yousub_appearance || {};
    
    // Set form values
    fontSizeInput.value = appearance.fontSize || 1.6;
    fontSizeVal.textContent = appearance.fontSize || 1.6;

    const fontColor = appearance.fontColor || '#ffffff';
    fontColorInput.value = fontColor;
    fontColorHex.textContent = fontColor.toUpperCase();

    const bgOpacity = appearance.bgOpacity !== undefined ? appearance.bgOpacity : 0.75;
    bgOpacityInput.value = bgOpacity;
    bgOpacityVal.textContent = Math.round(bgOpacity * 100) + '%';

    const posBottom = appearance.posBottom || 80;
    posBottomInput.value = posBottom;
    posBottomVal.textContent = posBottom + 'px';

    updatePreview();
  });
}

function saveAppearance() {
  const appearance = {
    fontSize: parseFloat(fontSizeInput.value),
    fontColor: fontColorInput.value,
    bgOpacity: parseFloat(bgOpacityInput.value),
    posBottom: parseInt(posBottomInput.value, 10)
  };

  browser.storage.local.set({ yousub_appearance: appearance }).then(() => {
    if (triggerSaveCallback) triggerSaveCallback();
  });
}
