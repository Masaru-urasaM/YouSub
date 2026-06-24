import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// chrome mock auto-loads via jest setupFilesAfterEach (jest.config.js).
// PageDetector imports devLog from constants.js; IS_PRODUCTION is false there,
// so devLog just forwards to console.log — no module mocking required.
import { PageDetector } from '../../src/content/page-detector.js';

/**
 * PageDetector reads window.location.pathname and window.location.search to
 * classify the current page (watch / shorts / other) and extract the video ID.
 * In jsdom, the cleanest way to drive those reads is history.pushState with a
 * path-only URL, which updates location.pathname/search in place without the
 * "Cannot redefine property: location" error that defineProperty triggers.
 */
function setUrl(pathAndQuery) {
  window.history.pushState({}, '', pathAndQuery);
}

describe('PageDetector', () => {
  beforeEach(() => {
    // Reset module-level singleton state between tests.
    PageDetector.destroy();
    setUrl('/');
    jest.clearAllMocks();
  });

  afterEach(() => {
    PageDetector.destroy();
  });

  describe('Watch page detection', () => {
    test('fires onEnter with the video ID from the ?v= query param', () => {
      setUrl('/watch?v=abc123');
      const onEnter = jest.fn();
      const onLeave = jest.fn();

      PageDetector.init(onEnter, onLeave);

      expect(onEnter).toHaveBeenCalledTimes(1);
      expect(onEnter).toHaveBeenCalledWith('abc123');
      expect(onLeave).not.toHaveBeenCalled();
      expect(PageDetector.getCurrentVideoId()).toBe('abc123');
    });

    test('handles a video ID with extra query params', () => {
      setUrl('/watch?v=dQw4w9WgXcQ&t=42s&list=PL123');
      const onEnter = jest.fn();

      PageDetector.init(onEnter, jest.fn());

      expect(onEnter).toHaveBeenCalledWith('dQw4w9WgXcQ');
      expect(PageDetector.getCurrentVideoId()).toBe('dQw4w9WgXcQ');
    });

    test('does NOT fire onEnter on /watch when the v param is missing', () => {
      setUrl('/watch?list=PL123');
      const onEnter = jest.fn();

      PageDetector.init(onEnter, jest.fn());

      expect(onEnter).not.toHaveBeenCalled();
      expect(PageDetector.getCurrentVideoId()).toBeNull();
    });
  });

  describe('Shorts page detection', () => {
    test('fires onEnter with the ID extracted from /shorts/<id>', () => {
      setUrl('/shorts/xyz789');
      const onEnter = jest.fn();

      PageDetector.init(onEnter, jest.fn());

      expect(onEnter).toHaveBeenCalledTimes(1);
      expect(onEnter).toHaveBeenCalledWith('xyz789');
      expect(PageDetector.getCurrentVideoId()).toBe('xyz789');
    });

    test('extracts only the ID segment when extra path segments follow', () => {
      setUrl('/shorts/short42/extra/segments');
      const onEnter = jest.fn();

      PageDetector.init(onEnter, jest.fn());

      expect(onEnter).toHaveBeenCalledWith('short42');
    });
  });

  describe('Non-video pages', () => {
    test('does NOT fire onEnter on the home page', () => {
      setUrl('/');
      const onEnter = jest.fn();

      PageDetector.init(onEnter, jest.fn());

      expect(onEnter).not.toHaveBeenCalled();
      expect(PageDetector.getCurrentVideoId()).toBeNull();
    });

    test('does NOT fire onEnter on a feed/results page', () => {
      setUrl('/results?search_query=cats');
      const onEnter = jest.fn();

      PageDetector.init(onEnter, jest.fn());

      expect(onEnter).not.toHaveBeenCalled();
      expect(PageDetector.getCurrentVideoId()).toBeNull();
    });
  });

  describe('Navigation transitions (yt-navigate-finish)', () => {
    test('fires onLeave then onEnter when switching from one video to another', () => {
      setUrl('/watch?v=first');
      const onEnter = jest.fn();
      const onLeave = jest.fn();
      PageDetector.init(onEnter, onLeave);

      expect(onEnter).toHaveBeenCalledWith('first');
      expect(onLeave).not.toHaveBeenCalled();

      // SPA navigation to a different video.
      setUrl('/watch?v=second');
      document.dispatchEvent(new Event('yt-navigate-finish'));

      expect(onLeave).toHaveBeenCalledTimes(1);
      expect(onEnter).toHaveBeenCalledTimes(2);
      expect(onEnter).toHaveBeenLastCalledWith('second');
      expect(PageDetector.getCurrentVideoId()).toBe('second');
    });

    test('does NOT re-fire onEnter when navigating to the same video ID', () => {
      setUrl('/watch?v=same');
      const onEnter = jest.fn();
      const onLeave = jest.fn();
      PageDetector.init(onEnter, onLeave);

      expect(onEnter).toHaveBeenCalledTimes(1);

      // Re-fire navigation event for the identical URL.
      document.dispatchEvent(new Event('yt-navigate-finish'));

      expect(onEnter).toHaveBeenCalledTimes(1);
      expect(onLeave).not.toHaveBeenCalled();
    });

    test('fires onLeave and clears the ID when leaving a video for a non-video page', () => {
      setUrl('/watch?v=leaving');
      const onEnter = jest.fn();
      const onLeave = jest.fn();
      PageDetector.init(onEnter, onLeave);
      expect(PageDetector.getCurrentVideoId()).toBe('leaving');

      // Navigate to the home page.
      setUrl('/');
      document.dispatchEvent(new Event('yt-navigate-finish'));

      expect(onLeave).toHaveBeenCalledTimes(1);
      expect(PageDetector.getCurrentVideoId()).toBeNull();
    });

    test('transitions from a watch page to a shorts page', () => {
      setUrl('/watch?v=watchid');
      const onEnter = jest.fn();
      const onLeave = jest.fn();
      PageDetector.init(onEnter, onLeave);

      setUrl('/shorts/shortid');
      document.dispatchEvent(new Event('yt-navigate-finish'));

      expect(onLeave).toHaveBeenCalledTimes(1);
      expect(onEnter).toHaveBeenLastCalledWith('shortid');
      expect(PageDetector.getCurrentVideoId()).toBe('shortid');
    });
  });

  describe('Callback robustness', () => {
    test('init works without callbacks (no throw) and still tracks the ID', () => {
      setUrl('/watch?v=nocb');
      expect(() => PageDetector.init(undefined, undefined)).not.toThrow();
      expect(PageDetector.getCurrentVideoId()).toBe('nocb');
    });

    test('leaving a non-video page without a tracked ID does nothing', () => {
      setUrl('/');
      const onLeave = jest.fn();
      PageDetector.init(jest.fn(), onLeave);

      setUrl('/results');
      document.dispatchEvent(new Event('yt-navigate-finish'));

      expect(onLeave).not.toHaveBeenCalled();
    });
  });

  describe('destroy()', () => {
    test('removes the navigation listener and resets state', () => {
      setUrl('/watch?v=destroyme');
      const onEnter = jest.fn();
      PageDetector.init(onEnter, jest.fn());
      expect(PageDetector.getCurrentVideoId()).toBe('destroyme');

      PageDetector.destroy();
      expect(PageDetector.getCurrentVideoId()).toBeNull();

      // After destroy, the listener is gone — a navigation event must not fire onEnter.
      onEnter.mockClear();
      setUrl('/watch?v=afterdestroy');
      document.dispatchEvent(new Event('yt-navigate-finish'));
      expect(onEnter).not.toHaveBeenCalled();
    });
  });
});
