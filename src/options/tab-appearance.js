let fontSizeInput,
  fontSizeVal,
  fontColorInput,
  fontColorHex,
  bgOpacityInput,
  bgOpacityVal,
  posBottomInput,
  posBottomVal,
  showStagePillInput,
  showDesktopFabInput,
  previewOverlay;
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
  showStagePillInput = document.getElementById('show-stage-pill');
  showDesktopFabInput = document.getElementById('show-desktop-fab');

  // Preview Element
  previewOverlay = document.getElementById('subtitle-preview');

  loadSettings();
  attachEventListeners();
}

function loadSettings() {
  browser.storage.local.get(['yousub_appearance']).then((res) => {
    const styles = res.yousub_appearance || {
      fontSize: 1.5,
      fontColor: '#ffffff',
      bgOpacity: 0.25,
      posBottom: 20,
    };

    // Update Inputs
    fontSizeInput.value = styles.fontSize;
    fontColorInput.value = styles.fontColor;
    bgOpacityInput.value = styles.bgOpacity;
    posBottomInput.value = styles.posBottom;
    if (showStagePillInput) {
      showStagePillInput.checked = styles.showStagePill !== false;
    }
    if (showDesktopFabInput) {
      showDesktopFabInput.checked = Boolean(styles.showDesktopFab);
    }

    updateUIStrings();
    updatePreview();
  });
}

function attachEventListeners() {
  const inputs = [fontSizeInput, fontColorInput, bgOpacityInput, posBottomInput];

  inputs.forEach((input) => {
    input.addEventListener('input', () => {
      updateUIStrings();
      updatePreview();
      debouncedSave();
    });
  });

  if (showStagePillInput) {
    showStagePillInput.addEventListener('change', () => {
      debouncedSave();
    });
  }
  if (showDesktopFabInput) {
    showDesktopFabInput.addEventListener('change', () => {
      debouncedSave();
    });
  }
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
    bottom: posBottomInput.value / 10 + '%', // Scale offset for preview container
  };

  Object.assign(previewOverlay.style, styles);
}

function debouncedSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveAppearance, 500);
}

function saveAppearance() {
  const appearance = {
    fontSize: parseFloat(fontSizeInput.value),
    fontColor: fontColorInput.value,
    bgOpacity: parseFloat(bgOpacityInput.value),
    posBottom: parseInt(posBottomInput.value, 10),
    showStagePill: showStagePillInput ? showStagePillInput.checked : true,
    showDesktopFab: showDesktopFabInput ? showDesktopFabInput.checked : false,
  };

  browser.storage.local.set({ yousub_appearance: appearance }).then(() => {
    if (triggerSaveCallback) triggerSaveCallback();
  });
}
