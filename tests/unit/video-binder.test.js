import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// chrome mock auto-loads via jest.config.js setupFilesAfterEach.
// VideoBinder imports devLog from constants.js (IS_PRODUCTION=false) -> console.
import { VideoBinder } from '../../src/content/video-binder.js';

/**
 * VideoBinder.bind(onBound):
 *   - findVideoElement() walks VIDEO_SELECTORS, returning the first matching
 *     <video> that passes isVisible() (offsetWidth || offsetHeight ||
 *     getClientRects().length). A generic 'video' selector and an all-videos
 *     fallback follow.
 *   - If a visible video exists immediately, onVideoFound() fires the callback
 *     once (guarded by callbackFired so the observer+initial-check race can't
 *     double-fire), disconnects the observer and clears the timeout.
 *   - Otherwise it starts a MutationObserver on document.body and a 10s timeout.
 *
 * jsdom reports offsetWidth/offsetHeight = 0 and getClientRects() = [] for every
 * element, so a freshly created <video> is "invisible" to isVisible(). We make a
 * video visible by defining offsetWidth on it. The observer path is exercised by
 * appending a visible video after bind() and flushing microtasks; the timeout
 * path uses Jest fake timers.
 */
function makeVisibleVideo(extra = {}) {
  const video = document.createElement('video');
  Object.entries(extra).forEach(([k, v]) => {
    if (k === 'class') video.className = v;
    else if (k === 'id') video.id = v;
    else video.setAttribute(k, v);
  });
  Object.defineProperty(video, 'offsetWidth', { configurable: true, value: 640 });
  Object.defineProperty(video, 'offsetHeight', { configurable: true, value: 360 });
  return video;
}

async function flushObserver() {
  // MutationObserver callbacks are microtask-scheduled in jsdom.
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('VideoBinder', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    VideoBinder.unbind();
    jest.clearAllMocks();
  });

  afterEach(() => {
    VideoBinder.unbind();
    jest.useRealTimers();
  });

  describe('Immediate bind (video already in DOM)', () => {
    test('binds to a visible video.html5-main-video and fires the callback once', () => {
      const video = makeVisibleVideo({ class: 'html5-main-video' });
      document.body.appendChild(video);

      const onBound = jest.fn();
      VideoBinder.bind(onBound);

      expect(onBound).toHaveBeenCalledTimes(1);
      expect(onBound).toHaveBeenCalledWith(video);
      expect(VideoBinder.getVideo()).toBe(video);
    });

    test('binds to a Shorts active reel video', () => {
      const reel = document.createElement('ytd-reel-video-renderer');
      reel.setAttribute('is-active', '');
      const video = makeVisibleVideo();
      reel.appendChild(video);
      document.body.appendChild(reel);

      const onBound = jest.fn();
      VideoBinder.bind(onBound);

      expect(onBound).toHaveBeenCalledWith(video);
      expect(VideoBinder.getVideo()).toBe(video);
    });

    test('falls back to the generic "video" selector for an unstyled video', () => {
      const video = makeVisibleVideo(); // no class/id — only the generic selector matches
      document.body.appendChild(video);

      const onBound = jest.fn();
      VideoBinder.bind(onBound);

      expect(onBound).toHaveBeenCalledWith(video);
    });

    test('does NOT bind to an invisible video (offsetWidth/Height = 0)', async () => {
      const hidden = document.createElement('video');
      hidden.className = 'html5-main-video';
      // No offset override -> jsdom reports 0 -> isVisible() is false.
      document.body.appendChild(hidden);

      const onBound = jest.fn();
      VideoBinder.bind(onBound);

      // Not bound immediately; the observer is now waiting.
      expect(onBound).not.toHaveBeenCalled();
      expect(VideoBinder.getVideo()).toBeNull();
    });

    test('picks the first visible video via the all-videos fallback when selectors miss', () => {
      // A video that matches none of the specific selectors but is visible.
      const visible = makeVisibleVideo();
      document.body.appendChild(visible);

      const onBound = jest.fn();
      VideoBinder.bind(onBound);

      expect(onBound).toHaveBeenCalledWith(visible);
    });
  });

  describe('Observer path (video appears later)', () => {
    test('binds once a visible video is appended after bind()', async () => {
      const onBound = jest.fn();
      VideoBinder.bind(onBound); // nothing in DOM yet -> observer starts
      expect(onBound).not.toHaveBeenCalled();

      const video = makeVisibleVideo({ class: 'html5-main-video' });
      document.body.appendChild(video);
      await flushObserver();

      expect(onBound).toHaveBeenCalledTimes(1);
      expect(onBound).toHaveBeenCalledWith(video);
      expect(VideoBinder.getVideo()).toBe(video);
    });

    test('does not double-fire even if the DOM mutates again after binding', async () => {
      const onBound = jest.fn();
      VideoBinder.bind(onBound);

      const video = makeVisibleVideo({ class: 'html5-main-video' });
      document.body.appendChild(video);
      await flushObserver();

      // A second mutation must not re-fire (observer is disconnected; callbackFired guard).
      const another = makeVisibleVideo();
      document.body.appendChild(another);
      await flushObserver();

      expect(onBound).toHaveBeenCalledTimes(1);
      expect(VideoBinder.getVideo()).toBe(video);
    });
  });

  describe('Timeout path', () => {
    test('logs an error and stops observing after TIMEOUT_MS with no video', () => {
      jest.useFakeTimers();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const onBound = jest.fn();
      VideoBinder.bind(onBound); // no video -> observer + 10s timeout

      jest.advanceTimersByTime(10000);

      expect(onBound).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      const loggedTimeout = errorSpy.mock.calls.some((args) =>
        String(args[0]).includes('Timed out waiting for video element')
      );
      expect(loggedTimeout).toBe(true);

      errorSpy.mockRestore();
    });
  });

  describe('Double-fire guard (callbackFired)', () => {
    test('calling bind() twice rebinds cleanly to a present video', () => {
      const video = makeVisibleVideo({ class: 'html5-main-video' });
      document.body.appendChild(video);

      const first = jest.fn();
      VideoBinder.bind(first);
      expect(first).toHaveBeenCalledTimes(1);

      // bind() calls unbind() internally, resetting callbackFired, so a second
      // bind with a present video fires its own callback.
      const second = jest.fn();
      VideoBinder.bind(second);
      expect(second).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledWith(video);
    });

    test('bind() works without a callback (no throw)', () => {
      const video = makeVisibleVideo({ class: 'html5-main-video' });
      document.body.appendChild(video);
      expect(() => VideoBinder.bind()).not.toThrow();
      expect(VideoBinder.getVideo()).toBe(video);
    });
  });

  describe('unbind()', () => {
    test('releases the bound video and resets state', () => {
      const video = makeVisibleVideo({ class: 'html5-main-video' });
      document.body.appendChild(video);
      VideoBinder.bind(jest.fn());
      expect(VideoBinder.getVideo()).toBe(video);

      VideoBinder.unbind();
      expect(VideoBinder.getVideo()).toBeNull();
    });

    test('after unbind(), a pending observer no longer binds on new videos', async () => {
      const onBound = jest.fn();
      VideoBinder.bind(onBound); // observer waiting
      VideoBinder.unbind(); // tear it down

      const video = makeVisibleVideo({ class: 'html5-main-video' });
      document.body.appendChild(video);
      await flushObserver();

      expect(onBound).not.toHaveBeenCalled();
      expect(VideoBinder.getVideo()).toBeNull();
    });

    test('is safe to call when nothing is bound', () => {
      expect(() => VideoBinder.unbind()).not.toThrow();
    });
  });

  describe('Selector priority', () => {
    test('prefers html5-main-video over a generic visible video', () => {
      const generic = makeVisibleVideo();
      generic.id = 'generic-one';
      document.body.appendChild(generic);

      const main = makeVisibleVideo({ class: 'html5-main-video' });
      main.id = 'main-one';
      document.body.appendChild(main);

      const onBound = jest.fn();
      VideoBinder.bind(onBound);

      // VIDEO_SELECTORS lists html5-main-video before the generic 'video'.
      expect(onBound).toHaveBeenCalledWith(main);
    });

    test('binds to #shorts-player video when ytd-reel-video-renderer lacks [is-active]', () => {
      const generic = makeVisibleVideo();
      generic.id = 'generic-bg';
      document.body.appendChild(generic);

      const shortsPlayer = document.createElement('div');
      shortsPlayer.id = 'shorts-player';
      const shortsVideo = makeVisibleVideo();
      shortsPlayer.appendChild(shortsVideo);
      document.body.appendChild(shortsPlayer);

      const onBound = jest.fn();
      VideoBinder.bind(onBound);

      expect(onBound).toHaveBeenCalledWith(shortsVideo);
    });
  });
});
