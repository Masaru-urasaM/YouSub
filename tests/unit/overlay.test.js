import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for src/content/overlay.js — the subtitle overlay DOM renderer.
 *
 * Notes on the test environment / strategy:
 * - overlay.js keeps module-level singletons (container, currentLayout,
 *   currentStyles, playerElement, ...). ESM imports are cached, so that state
 *   leaks across tests in this file. We call Overlay.destroy() FIRST in every
 *   beforeEach to null all of them (destroy is guarded for the null case).
 * - Container creation is lazy: there is no Overlay.init(). It happens inside
 *   createOverlay(), triggered by show()/renderSubtitles()/setLoading()/
 *   showStatus(). createOverlay() needs a player element in the DOM
 *   (#movie_player for the regular YouTube layout).
 * - jsdom does NOT provide ResizeObserver, which setupPlayerObserver() uses.
 *   We install a minimal shim (observe/disconnect) BEFORE importing the module.
 * - TrustedTypes needs no mock: window.trustedTypes is absent in jsdom, so the
 *   policy stays null and TrustedTypes.toSafeHTML() returns the raw string.
 * - Storage is promise-based (loadLayout/saveLayout/refreshStyles use
 *   .get().then()). flushMicrotasks() drains those resolved-promise callbacks.
 */

// ResizeObserver shim — required before the module's setupPlayerObserver runs.
let lastResizeObserver = null;
class MockResizeObserver {
  constructor(cb) {
    this.cb = cb;
    lastResizeObserver = this;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = MockResizeObserver;

const { Overlay } = await import('../../src/content/overlay.js');

// Storage reads resolve via promises; drain a couple of microtask turns so the
// .then() callbacks (loadLayout / saveLayout / refreshStyles) have executed.
const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** Append a fake regular-layout player so createOverlay() can find it. */
function createPlayer() {
  const player = document.createElement('div');
  player.id = 'movie_player';
  player.className = 'html5-video-player';
  document.body.appendChild(player);
  return player;
}

describe('Overlay Module', () => {
  beforeEach(() => {
    // Order matters: destroy() nulls module singletons first, then we wipe the
    // DOM and storage and build a fresh player for the next test.
    Overlay.destroy();
    document.body.innerHTML = '';
    chrome.storage.local.store = {};
    jest.clearAllMocks();
    createPlayer();
  });

  afterEach(() => {
    Overlay.destroy();
  });

  describe('container creation (lazy)', () => {
    test('renderSubtitles creates the overlay container in the DOM', () => {
      expect(document.getElementById('yousub-overlay')).toBeNull();
      Overlay.renderSubtitles('hello', '', false);
      const container = document.getElementById('yousub-overlay');
      expect(container).not.toBeNull();
      // Container is appended inside the player element.
      expect(container.parentElement).toBe(document.getElementById('movie_player'));
    });

    test('show() creates the container and adds the visible class', () => {
      Overlay.show();
      const container = document.getElementById('yousub-overlay');
      expect(container).not.toBeNull();
      expect(container.classList.contains('yousub-visible')).toBe(true);
    });

    test('container holds the expected child elements', () => {
      Overlay.show();
      expect(document.getElementById('yousub-status-container')).not.toBeNull();
      expect(document.getElementById('yousub-text-translated')).not.toBeNull();
      expect(document.getElementById('yousub-text-original')).not.toBeNull();
      expect(document.getElementById('yousub-spinner')).not.toBeNull();
    });

    test('createOverlay no-ops (no container) when no player element exists', () => {
      // Remove the player set up in beforeEach so createOverlay cannot find one.
      document.body.innerHTML = '';
      Overlay.renderSubtitles('text', '', false);
      expect(document.getElementById('yousub-overlay')).toBeNull();
    });
  });

  describe('renderSubtitles', () => {
    test('single mode: translated text set, original line hidden', () => {
      Overlay.renderSubtitles('Translated line', 'Source line', false);
      const translated = document.getElementById('yousub-text-translated');
      const original = document.getElementById('yousub-text-original');
      expect(translated.textContent).toBe('Translated line');
      // original is not populated and stays hidden in single mode.
      expect(original.classList.contains('hidden')).toBe(true);
    });

    test('dual mode: both lines populated, original line shown', () => {
      Overlay.renderSubtitles('Dich', 'Original', true);
      const translated = document.getElementById('yousub-text-translated');
      const original = document.getElementById('yousub-text-original');
      expect(translated.textContent).toBe('Dich');
      expect(original.textContent).toBe('Original');
      expect(original.classList.contains('hidden')).toBe(false);
    });

    test('dual mode with empty original keeps the original line hidden', () => {
      Overlay.renderSubtitles('Only translated', '', true);
      const original = document.getElementById('yousub-text-original');
      expect(original.classList.contains('hidden')).toBe(true);
    });

    test('falsy translated text renders empty string', () => {
      Overlay.renderSubtitles(undefined, '', false);
      expect(document.getElementById('yousub-text-translated').textContent).toBe('');
    });

    test('isTranslated=true clears dimming and hides the spinner', () => {
      // Put the overlay into the loading/dimmed state first.
      Overlay.setLoading(true);
      const translated = document.getElementById('yousub-text-translated');
      const spinner = document.getElementById('yousub-spinner');
      expect(translated.classList.contains('yousub-dimmed')).toBe(true);

      Overlay.renderSubtitles('final', '', false, true);
      expect(translated.classList.contains('yousub-dimmed')).toBe(false);
      expect(spinner.classList.contains('hidden')).toBe(true);
    });

    test('isTranslated falsy while loading dims text and shows spinner', () => {
      Overlay.setLoading(true);
      // Clear the dim/spinner that setLoading applied, to prove renderSubtitles
      // re-applies them via the _translationInProgress branch.
      const translated = document.getElementById('yousub-text-translated');
      const spinner = document.getElementById('yousub-spinner');
      translated.classList.remove('yousub-dimmed');
      spinner.classList.add('hidden');

      Overlay.renderSubtitles('rough', '', false, false);
      expect(translated.classList.contains('yousub-dimmed')).toBe(true);
      expect(spinner.classList.contains('hidden')).toBe(false);
    });

    test('uses textContent (no HTML injection)', () => {
      Overlay.renderSubtitles('<b>bold</b>', '', false);
      const translated = document.getElementById('yousub-text-translated');
      // Rendered as literal text, not parsed into a <b> element.
      expect(translated.textContent).toBe('<b>bold</b>');
      expect(translated.querySelector('b')).toBeNull();
    });
  });

  describe('setText', () => {
    test('delegates to renderSubtitles in single mode', () => {
      Overlay.setText('Quick text');
      const translated = document.getElementById('yousub-text-translated');
      const original = document.getElementById('yousub-text-original');
      expect(translated.textContent).toBe('Quick text');
      expect(original.classList.contains('hidden')).toBe(true);
    });
  });

  describe('show / hide visibility', () => {
    test('hide() removes the visible class', () => {
      Overlay.show();
      const container = document.getElementById('yousub-overlay');
      expect(container.classList.contains('yousub-visible')).toBe(true);
      Overlay.hide();
      expect(container.classList.contains('yousub-visible')).toBe(false);
    });

    test('hide() is a no-op when there is no container', () => {
      // No container created yet; should not throw.
      expect(() => Overlay.hide()).not.toThrow();
      expect(document.getElementById('yousub-overlay')).toBeNull();
    });
  });

  describe('setLoading', () => {
    test('loading=true adds loading class, shows spinner, dims text', () => {
      Overlay.setLoading(true);
      const container = document.getElementById('yousub-overlay');
      const spinner = document.getElementById('yousub-spinner');
      const translated = document.getElementById('yousub-text-translated');
      expect(container.classList.contains('yousub-loading')).toBe(true);
      expect(spinner.classList.contains('hidden')).toBe(false);
      expect(translated.classList.contains('yousub-dimmed')).toBe(true);
    });

    test('loading=false removes loading class, hides spinner, undims text', () => {
      Overlay.setLoading(true);
      Overlay.setLoading(false);
      const container = document.getElementById('yousub-overlay');
      const spinner = document.getElementById('yousub-spinner');
      const translated = document.getElementById('yousub-text-translated');
      expect(container.classList.contains('yousub-loading')).toBe(false);
      expect(spinner.classList.contains('hidden')).toBe(true);
      expect(translated.classList.contains('yousub-dimmed')).toBe(false);
    });
  });

  describe('showStatus', () => {
    test('appends a status message element with the typed class', () => {
      Overlay.showStatus('Saved!', 'success', 4000);
      const statusContainer = document.getElementById('yousub-status-container');
      const msg = statusContainer.querySelector('.yousub-status-msg');
      expect(msg).not.toBeNull();
      expect(msg.classList.contains('yousub-status-success')).toBe(true);
      expect(msg.textContent).toBe('Saved!');
    });

    test('invalid type falls back to the info class', () => {
      Overlay.showStatus('Note', 'not-a-real-type', 4000);
      const msg = document
        .getElementById('yousub-status-container')
        .querySelector('.yousub-status-msg');
      expect(msg.classList.contains('yousub-status-info')).toBe(true);
    });

    test('TrustedTypes passthrough: HTML in the message is parsed into nodes', () => {
      // window.trustedTypes is absent in jsdom -> toSafeHTML returns the raw
      // string -> innerHTML parses it. Confirms the passthrough path works.
      Overlay.showStatus('<span class="x">hi</span>', 'info', 4000);
      const msg = document
        .getElementById('yousub-status-container')
        .querySelector('.yousub-status-msg');
      expect(msg.querySelector('span.x')).not.toBeNull();
      expect(msg.textContent).toBe('hi');
    });

    test('an open-settings action link sends a runtime message on click', () => {
      Overlay.showStatus('<a data-action="open-settings">Open</a>', 'warning', 4000);
      const link = document
        .getElementById('yousub-status-container')
        .querySelector('[data-action="open-settings"]');
      expect(link).not.toBeNull();
      link.dispatchEvent(new window.Event('click', { bubbles: true }));
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'YOUSUB_OPEN_SETTINGS' });
    });
  });

  describe('applyStyles', () => {
    beforeEach(() => {
      Overlay.show(); // ensure container + elements exist
    });

    test('applies fontSize, fontColor, bgOpacity, and posBottom to the DOM', () => {
      Overlay.applyStyles({
        fontSize: 2,
        fontColor: 'rgb(255, 0, 0)',
        bgOpacity: 0.5,
        posBottom: 30,
      });
      const container = document.getElementById('yousub-overlay');
      const translated = document.getElementById('yousub-text-translated');
      const original = document.getElementById('yousub-text-original');
      expect(translated.style.fontSize).toBe('2em');
      // original is scaled to 0.7x.
      expect(original.style.fontSize).toBe('1.4em');
      expect(translated.style.color).toBe('rgb(255, 0, 0)');
      expect(container.style.backgroundColor).toBe('rgba(0, 0, 0, 0.5)');
      expect(container.style.getPropertyValue('--yousub-pos-bottom')).toBe('30px');
    });

    test('is a no-op when styles is null', () => {
      const translated = document.getElementById('yousub-text-translated');
      translated.style.fontSize = '9em';
      Overlay.applyStyles(null);
      expect(translated.style.fontSize).toBe('9em');
    });
  });

  describe('refreshStyles', () => {
    test('reads yousub_appearance from storage and applies it', async () => {
      chrome.storage.local.store = {
        yousub_appearance: { fontSize: 3, fontColor: 'blue' },
      };
      Overlay.show();
      Overlay.refreshStyles();
      await flushMicrotasks();
      const translated = document.getElementById('yousub-text-translated');
      expect(translated.style.fontSize).toBe('3em');
    });
  });

  describe('resize/move handles (Phase 62)', () => {
    test('creates six handle elements', () => {
      Overlay.show();
      const handles = document.getElementById('yousub-overlay').querySelectorAll('.yousub-handle');
      expect(handles.length).toBe(6);
      // Specific handle types exist.
      ['nw', 'ne', 'sw', 'se', 'move', 'reset'].forEach((type) => {
        expect(document.querySelector('.yousub-handle-' + type)).not.toBeNull();
      });
    });

    test('loadLayout migrates a legacy stored custom-mode layout to bottom-anchored fit-content', async () => {
      chrome.storage.local.store = {
        yousub_overlay_layout: {
          regular: { customMode: true, leftPct: 10, topPct: 20, widthPct: 30, minHeightPx: null },
        },
      };
      Overlay.show();
      await flushMicrotasks();
      const container = document.getElementById('yousub-overlay');
      expect(container.classList.contains('yousub-custom-position')).toBe(true);
      expect(container.style.left).toBe('25%'); // centerX = 10 + 30/2
      expect(container.style.top).toBe('auto');
      expect(container.style.width).toBe(''); // auto-fit width via CSS fit-content
      expect(container.style.maxWidth).toBe('30%');
      expect(container.style.getPropertyValue('--yousub-custom-bottom')).toBe('68%');
    });

    test('loadLayout with no stored layout leaves the overlay in default position', async () => {
      Overlay.show();
      await flushMicrotasks();
      const container = document.getElementById('yousub-overlay');
      expect(container.classList.contains('yousub-custom-position')).toBe(false);
      expect(container.style.left).toBe('');
    });

    test('reset handle exits custom mode and persists customMode=false', async () => {
      // Seed a custom layout so the overlay starts in custom-position mode.
      chrome.storage.local.store = {
        yousub_overlay_layout: {
          regular: { customMode: true, leftPct: 10, topPct: 20, widthPct: 30, minHeightPx: null },
        },
      };
      Overlay.show();
      await flushMicrotasks();
      const container = document.getElementById('yousub-overlay');
      expect(container.classList.contains('yousub-custom-position')).toBe(true);

      // The reset handler's pointerdown does not use setPointerCapture, so a
      // plain Event suffices to drive exitCustomMode() + saveLayout().
      const reset = container.querySelector('.yousub-handle-reset');
      reset.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));

      expect(container.classList.contains('yousub-custom-position')).toBe(false);
      expect(container.style.left).toBe('');
      expect(container.style.width).toBe('');

      await flushMicrotasks();
      // saveLayout wrote the cleared layout back to storage.
      const stored = chrome.storage.local.store.yousub_overlay_layout;
      expect(stored.regular.customMode).toBe(false);
    });
  });

  describe('destroy', () => {
    test('removes the container from the DOM and detaches the storage listener', () => {
      Overlay.show();
      expect(document.getElementById('yousub-overlay')).not.toBeNull();

      Overlay.destroy();
      expect(document.getElementById('yousub-overlay')).toBeNull();
      // Storage onChanged listener was registered on create and removed here.
      expect(chrome.storage.onChanged.removeListener).toHaveBeenCalled();
    });

    test('is safe to call when nothing was created', () => {
      Overlay.destroy(); // from beforeEach a player exists but no container
      expect(() => Overlay.destroy()).not.toThrow();
    });

    test('after destroy, a fresh container can be created again', () => {
      Overlay.show();
      Overlay.destroy();
      // Player was removed by destroy()? No — destroy only nulls the cached ref.
      // Re-create the player and re-show.
      createPlayer();
      Overlay.show();
      expect(document.getElementById('yousub-overlay')).not.toBeNull();
    });
  });

  describe('drag move, corner resize, Shorts & ResizeObserver clamping (T9)', () => {
    function setupPlayerMetrics(player, { left = 0, top = 0, width = 1000, height = 500 } = {}) {
      Object.defineProperty(player, 'clientWidth', { configurable: true, value: width });
      Object.defineProperty(player, 'clientHeight', { configurable: true, value: height });
      player.getBoundingClientRect = () => ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      });
    }

    function setupContainerMetrics(
      container,
      { left = 200, top = 350, width = 600, height = 80 } = {}
    ) {
      Object.defineProperty(container, 'offsetWidth', { configurable: true, value: width });
      Object.defineProperty(container, 'offsetHeight', { configurable: true, value: height });
      container.getBoundingClientRect = () => ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      });
    }

    function attachPointerCaptureStubs(el) {
      el.setPointerCapture = jest.fn();
      el.releasePointerCapture = jest.fn();
    }

    function firePointer(el, type, { clientX = 0, clientY = 0, pointerId = 1 } = {}) {
      const evt = new window.Event(type, { bubbles: true, cancelable: true });
      evt.clientX = clientX;
      evt.clientY = clientY;
      evt.pointerId = pointerId;
      el.dispatchEvent(evt);
    }

    test('move handle drags overlay, anchors bottom edge, clamps bounds, and preserves auto-fit maxWidth', async () => {
      const player = document.getElementById('movie_player');
      setupPlayerMetrics(player, { left: 0, top: 0, width: 1000, height: 500 });
      Overlay.show();
      await flushMicrotasks();

      const container = document.getElementById('yousub-overlay');
      setupContainerMetrics(container, { left: 200, top: 300, width: 400, height: 60 });
      const moveHandle = container.querySelector('.yousub-handle-move');
      attachPointerCaptureStubs(moveHandle);

      // Start drag at (250, 320), move way beyond right/bottom edge to test clamping
      firePointer(moveHandle, 'pointerdown', { clientX: 250, clientY: 320, pointerId: 7 });
      expect(container.classList.contains('yousub-dragging')).toBe(true);
      expect(container.classList.contains('yousub-custom-position')).toBe(true);
      // Moving short cue preserves 80% max-width ceiling instead of locking to current cue width
      expect(container.style.width).toBe('');
      expect(container.style.maxWidth).toBe('80%');

      firePointer(moveHandle, 'pointermove', { clientX: 1500, clientY: 900, pointerId: 7 });
      // Clamped max left = 1000 - 400 = 600 -> centerX = 800 (80%), bottom = 0%
      expect(container.style.left).toBe('80%');
      expect(container.style.top).toBe('auto');
      expect(container.style.getPropertyValue('--yousub-custom-bottom')).toBe('0%');

      firePointer(moveHandle, 'pointerup', { clientX: 1500, clientY: 900, pointerId: 7 });
      expect(container.classList.contains('yousub-dragging')).toBe(false);
      await flushMicrotasks();
      expect(chrome.storage.local.store.yousub_overlay_layout.regular).toMatchObject({
        customMode: true,
        centerXPct: 80,
        bottomPct: 0,
        maxWidthPct: 80,
      });
    });

    test('nw and se resize handles adjust maxWidth ceiling + bottom anchor and toggle resizing preview', async () => {
      const player = document.getElementById('movie_player');
      setupPlayerMetrics(player, { left: 0, top: 0, width: 1000, height: 500 });
      Overlay.show();
      await flushMicrotasks();

      const container = document.getElementById('yousub-overlay');
      setupContainerMetrics(container, { left: 200, top: 200, width: 300, height: 80 });

      // NW handle shrink past minimum (200x40)
      const nw = container.querySelector('.yousub-handle-nw');
      attachPointerCaptureStubs(nw);
      firePointer(nw, 'pointerdown', { clientX: 200, clientY: 200, pointerId: 1 });
      expect(container.classList.contains('yousub-resizing')).toBe(true);
      firePointer(nw, 'pointermove', { clientX: 450, clientY: 270, pointerId: 1 });
      expect(container.style.maxWidth).toBe('20%'); // min 200 / 1000 = 20%
      expect(container.style.minHeight).toBe('40px'); // min height 40px
      expect(container.style.left).toBe('40%'); // box [300..500] -> center = 400 (40%)
      expect(container.style.getPropertyValue('--yousub-custom-bottom')).toBe('44%'); // (500 - 280) / 500 = 44%
      firePointer(nw, 'pointerup', { clientX: 450, clientY: 270, pointerId: 1 });
      expect(container.classList.contains('yousub-resizing')).toBe(false);

      // SE handle expand
      setupContainerMetrics(container, { left: 200, top: 200, width: 300, height: 80 });
      const se = container.querySelector('.yousub-handle-se');
      attachPointerCaptureStubs(se);
      firePointer(se, 'pointerdown', { clientX: 500, clientY: 280, pointerId: 2 });
      firePointer(se, 'pointermove', { clientX: 700, clientY: 380, pointerId: 2 });
      expect(container.style.maxWidth).toBe('50%'); // 500 / 1000 = 50%
      expect(container.style.minHeight).toBe('180px');
      expect(container.style.getPropertyValue('--yousub-custom-bottom')).toBe('24%'); // (500 - 380) / 500
      firePointer(se, 'pointercancel', { clientX: 700, clientY: 380, pointerId: 2 });
      expect(container.classList.contains('yousub-dragging')).toBe(false);
      expect(container.classList.contains('yousub-resizing')).toBe(false);
    });

    test('ResizeObserver reclamps stored custom layout and storage onChanged updates styles', async () => {
      chrome.storage.local.store = {
        yousub_overlay_layout: {
          regular: {
            customMode: true,
            centerXPct: 95,
            bottomPct: 92,
            maxWidthPct: 40,
            minHeightPx: 60,
          },
        },
      };
      const player = document.getElementById('movie_player');
      setupPlayerMetrics(player, { width: 1000, height: 500 });
      Overlay.show();

      const container = document.getElementById('yousub-overlay');
      setupContainerMetrics(container, { width: 400, height: 100 });
      await flushMicrotasks();

      // reclampToPlayer ran on loadLayout + runs again when ResizeObserver fires
      expect(container.style.left).toBe('80%'); // clamped so halfW (20%) keeps right <= 100%
      expect(container.style.getPropertyValue('--yousub-custom-bottom')).toBe('80%'); // (500 - 100) / 500
      expect(container.style.getPropertyValue('--yousub-max-bottom')).toBe('400px');

      lastResizeObserver.cb();
      expect(container.style.left).toBe('80%');

      // Storage onChanged live style update
      const onChangedFn = chrome.storage.onChanged._listeners.at(-1);
      onChangedFn(
        { yousub_appearance: { newValue: { fontColor: 'green', posBottom: 45 } } },
        'local'
      );
      expect(document.getElementById('yousub-text-translated').style.color).toBe('green');
      expect(container.style.getPropertyValue('--yousub-pos-bottom')).toBe('45px');
    });

    test('status auto-remove timer removes status message and stale player destroys overlay', () => {
      jest.useFakeTimers();
      Overlay.showStatus('Temp', 'info', 1000);
      expect(document.querySelectorAll('.yousub-status-msg')).toHaveLength(1);
      jest.advanceTimersByTime(1000);
      expect(document.querySelectorAll('.yousub-status-msg')).toHaveLength(0);

      // Detach player -> stale check destroys and recreates on show()
      const oldPlayer = document.getElementById('movie_player');
      oldPlayer.remove();
      createPlayer();
      Overlay.show();
      expect(document.getElementById('yousub-overlay')).not.toBeNull();
      jest.useRealTimers();
    });

    test('Shorts #shorts-player persists without destroying overlay when [is-active] attribute is absent', () => {
      window.history.pushState({}, '', '/shorts/ALWp-RMMP5k');
      document.body.innerHTML = `
        <ytd-shorts>
          <ytd-reel-video-renderer></ytd-reel-video-renderer>
          <div id="shorts-player" class="html5-video-player"></div>
        </ytd-shorts>
      `;

      Overlay.show();
      const firstContainer = document.getElementById('yousub-overlay');
      expect(firstContainer).not.toBeNull();
      expect(firstContainer.classList.contains('yousub-shorts')).toBe(true);
      expect(firstContainer.parentElement.id).toBe('shorts-player');

      // Calling show() again must reuse the same overlay container (not tear down & recreate)
      Overlay.show();
      expect(document.getElementById('yousub-overlay')).toBe(firstContainer);
      window.history.pushState({}, '', '/');
    });

    test('showStatus interactive SRT/VTT import button, drag-drop, sticky close, and hide() guard', async () => {
      const onImport = jest.fn();
      const onRetry = jest.fn();

      Overlay.showStatus('Could not find subtitles', 'warning', 0, {
        id: 'no-subtitles',
        dismissible: true,
        importLabel: 'Import .srt / .vtt',
        onImportSubtitleFile: onImport,
        actions: [{ label: 'Retry AI', onClick: onRetry }],
      });

      const container = document.getElementById('yousub-overlay');
      const msg = document.querySelector('[data-status-id="no-subtitles"]');
      expect(msg).not.toBeNull();
      expect(msg.querySelector('.yousub-status-close')).not.toBeNull();

      // Overlay.hide() must NOT hide container while a sticky/status toast is visible
      Overlay.hide();
      expect(container.classList.contains('yousub-visible')).toBe(true);

      // File input change delivers file contents to callback
      const input = msg.querySelector('input[type="file"]');
      const file = {
        name: 'demo.srt',
        size: 32,
        text: async () => '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
      };
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await flushMicrotasks();
      expect(onImport).toHaveBeenCalledWith(
        '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
        'demo.srt',
        expect.any(Function)
      );

      // Drag & drop also triggers import
      onImport.mockClear();
      const dropEvt = new window.Event('drop', { bubbles: true, cancelable: true });
      dropEvt.dataTransfer = {
        files: [{ name: 'drop.vtt', size: 20, text: async () => 'WEBVTT\n' }],
      };
      msg.dispatchEvent(dropEvt);
      await flushMicrotasks();
      expect(onImport).toHaveBeenCalledWith('WEBVTT\n', 'drop.vtt', expect.any(Function));

      // Extra action button + close button
      const retryBtn = [...msg.querySelectorAll('.yousub-status-btn')].find(
        (b) => b.textContent === 'Retry AI'
      );
      retryBtn.click();
      expect(onRetry).toHaveBeenCalled();

      msg.querySelector('.yousub-status-close').click();
      expect(document.querySelector('[data-status-id="no-subtitles"]')).toBeNull();
      expect(container.classList.contains('yousub-visible')).toBe(false);
    });

    test('updateStagePill renders Past/Present/Future chips and auto-hides after COMPLETE', () => {
      jest.useFakeTimers();

      Overlay.updateStagePill({
        mode: 'transcript',
        stage: 'ROUTE',
        coalescer: { rawCount: 310, coalescedCount: 142 },
        router: { activeProvider: 'google', activeModel: 'gemini-2.5-flash' },
        batches: [
          { batchIndex: 0, status: 'IN_FLIGHT', isSeekTarget: true },
          { batchIndex: 1, status: 'PREFETCH' },
        ],
      });

      const pill = document.getElementById('yousub-stage-pill');
      expect(pill.classList.contains('hidden')).toBe(false);
      expect(pill.textContent).toContain('310→142');
      expect(pill.textContent).toContain('gemini-2.5-flash');
      expect(pill.textContent).toContain('⚡Seek');
      expect(pill.textContent).toContain('Next #2');

      Overlay.updateStagePill({
        mode: 'transcript',
        stage: 'COMPLETE',
        coalescer: { rawCount: 310, coalescedCount: 142 },
        sink: { syncedCues: 142, totalCues: 142, cached: true },
        batches: [{ batchIndex: 0, status: 'DONE' }],
      });
      expect(pill.textContent).toContain('Synced 142');
      expect(pill.textContent).toContain('Cached ✓');

      jest.advanceTimersByTime(2500);
      expect(pill.classList.contains('hidden')).toBe(true);
      jest.useRealTimers();
    });

    test('updateStagePill uses friendly cues/stage labels, omits empty Next chip, and respects showStagePill setting', () => {
      Overlay.updateStagePill({
        mode: 'transcript',
        stage: 'COALESCE',
        coalescer: { rawCount: 229, coalescedCount: 229 },
        batches: [],
      });

      const pill = document.getElementById('yousub-stage-pill');
      expect(pill.classList.contains('hidden')).toBe(false);
      expect(pill.textContent).toContain('Extract ✓ 229 cues');
      expect(pill.textContent).toContain('Merging cues...');
      expect(pill.textContent).not.toContain('COALESCE');
      expect(pill.textContent).not.toContain('229c');
      expect(pill.textContent).not.toContain('Next');
      expect(pill.querySelectorAll('.yousub-pill-chip')).toHaveLength(2);
      expect(pill.querySelectorAll('.yousub-pill-arrow')).toHaveLength(1);

      // Disabling showStagePill hides active pill immediately and suppresses future updates
      Overlay.applyStyles({ showStagePill: false });
      expect(pill.classList.contains('hidden')).toBe(true);

      Overlay.updateStagePill({
        mode: 'transcript',
        stage: 'ROUTE',
        coalescer: { rawCount: 229, coalescedCount: 229 },
        batches: [{ batchIndex: 0, status: 'IN_FLIGHT' }],
      });
      expect(pill.classList.contains('hidden')).toBe(true);

      // Re-enabling restores pill rendering
      Overlay.applyStyles({ showStagePill: true });
      Overlay.updateStagePill({
        mode: 'transcript',
        stage: 'ROUTE',
        router: { activeProvider: 'google', activeModel: 'gemini-2.5-flash' },
        batches: [{ batchIndex: 0, status: 'IN_FLIGHT' }],
      });
      expect(pill.classList.contains('hidden')).toBe(false);
    });

    test('tracks live .ytp-chrome-bottom control bar height and suspends dodge during drag', async () => {
      const player = document.getElementById('movie_player');
      setupPlayerMetrics(player, { left: 0, top: 0, width: 1000, height: 500 });

      const chromeBottom = document.createElement('div');
      chromeBottom.className = 'ytp-chrome-bottom';
      let barTop = 448;
      let barHeight = 52;
      chromeBottom.getBoundingClientRect = () => ({
        left: 12,
        top: barTop,
        width: 976,
        height: barHeight,
        right: 988,
        bottom: barTop + barHeight,
      });
      player.appendChild(chromeBottom);

      Overlay.show();
      await flushMicrotasks();

      const container = document.getElementById('yousub-overlay');
      setupContainerMetrics(container, { left: 300, top: 380, width: 400, height: 50 });

      // Controls visible initially (no ytp-autohide): 500 - 448 + 10 = 62px
      expect(container.style.getPropertyValue('--yousub-bar-clearance')).toBe('62px');

      // Player enters ytp-autohide -> MutationObserver sets clearance to 0px
      player.classList.add('ytp-autohide');
      await flushMicrotasks();
      expect(container.style.getPropertyValue('--yousub-bar-clearance')).toBe('0px');

      // Player shows fullscreen taller bar (Delhi/big mode 76px) -> clearance tracks 86px
      barTop = 424;
      barHeight = 76;
      player.classList.remove('ytp-autohide');
      await flushMicrotasks();
      expect(container.style.getPropertyValue('--yousub-bar-clearance')).toBe('86px');

      // Dragging suspends bar dodge so user can drop overlay down near bottom, then restores on pointerup
      const moveHandle = container.querySelector('.yousub-handle-move');
      attachPointerCaptureStubs(moveHandle);
      firePointer(moveHandle, 'pointerdown', { clientX: 350, clientY: 400, pointerId: 3 });
      expect(container.style.getPropertyValue('--yousub-bar-clearance')).toBe('0px');
      firePointer(moveHandle, 'pointerup', { clientX: 350, clientY: 460, pointerId: 3 });
      expect(container.style.getPropertyValue('--yousub-bar-clearance')).toBe('86px');
    });

    test('clamps edge horizontal center dynamically as cues expand and shrink around centerXPct', async () => {
      chrome.storage.local.store = {
        yousub_overlay_layout: {
          regular: {
            customMode: true,
            centerXPct: 12,
            bottomPct: 10,
            maxWidthPct: 60,
            minHeightPx: null,
          },
        },
      };
      const player = document.getElementById('movie_player');
      setupPlayerMetrics(player, { left: 0, top: 0, width: 1000, height: 500 });

      Overlay.show();
      const container = document.getElementById('yousub-overlay');
      setupContainerMetrics(container, { width: 100, height: 40 });
      await flushMicrotasks();

      // Short cue (halfW = 50px <= 120px) stays at user's preferred 12%
      expect(container.style.left).toBe('12%');
      expect(container.style.getPropertyValue('--yousub-max-bottom')).toBe('460px');

      // Long cue widens box to 500px (halfW = 250px > 120px) -> clamped to 25% so left >= 0
      setupContainerMetrics(container, { width: 500, height: 110 });
      Overlay.renderSubtitles('Longer translated line', 'Original', true);
      expect(container.style.left).toBe('25%');
      expect(container.style.getPropertyValue('--yousub-max-bottom')).toBe('390px');

      // Subsequent short cue returns smoothly to user's preferred 12%
      setupContainerMetrics(container, { width: 80, height: 40 });
      Overlay.renderSubtitles('OK', '', false);
      expect(container.style.left).toBe('12%');
    });

    test('finds m.youtube.com #player-container-id and measures visible .player-controls-bottom clearance (Phase 81)', async () => {
      Overlay.destroy();
      document.body.innerHTML = '';

      const mobileContainer = document.createElement('div');
      mobileContainer.id = 'player-container-id';
      setupPlayerMetrics(mobileContainer, { left: 0, top: 0, width: 390, height: 220 });

      const mobileControlOverlay = document.createElement('div');
      mobileControlOverlay.id = 'player-control-overlay';
      const bottomBar = document.createElement('div');
      bottomBar.className = 'player-controls-bottom';
      bottomBar.getBoundingClientRect = () => ({
        left: 0,
        top: 176,
        width: 390,
        height: 44,
        right: 390,
        bottom: 220,
      });
      mobileControlOverlay.appendChild(bottomBar);
      mobileContainer.appendChild(mobileControlOverlay);
      document.body.appendChild(mobileContainer);

      Overlay.show();
      await flushMicrotasks();

      const container = document.getElementById('yousub-overlay');
      expect(container).not.toBeNull();
      expect(container.parentElement).toBe(mobileContainer);
      // 220 - 176 + 10 = 54px
      expect(container.style.getPropertyValue('--yousub-bar-clearance')).toBe('54px');

      // When #player-control-overlay hides controls (aria-hidden="true"), clearance drops to 0px
      mobileControlOverlay.setAttribute('aria-hidden', 'true');
      mobileContainer.classList.add('ytm-trigger-observer');
      await flushMicrotasks();
      expect(container.style.getPropertyValue('--yousub-bar-clearance')).toBe('0px');
    });

    test('showStatus queues pending toast when player container is not mounted yet and replays once mounted (Phase 84)', () => {
      jest.useFakeTimers();
      Overlay.destroy();
      document.body.innerHTML = '';

      // Calling showStatus before #movie_player exists queues cleanly without throwing
      Overlay.showStatus('⏱ Resumed at 10:00', 'info', 4000, { id: 'playback-resume' });
      expect(document.getElementById('yousub-overlay')).toBeNull();

      // Mount player and advance 500ms retry timer -> queued toast renders automatically
      createPlayer();
      jest.advanceTimersByTime(500);
      const status = document.querySelector('[data-status-id="playback-resume"]');
      expect(status).not.toBeNull();
      expect(status.textContent).toContain('Resumed at 10:00');
      jest.useRealTimers();
    });
  });
});
