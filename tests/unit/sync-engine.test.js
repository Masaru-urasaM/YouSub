import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Phase 68: replaced the old eval(scriptContent) loader (which threw
 * "Cannot use import statement outside a module" on this ESM file) with a
 * direct ESM import. SyncEngine calls the imported Overlay binding directly,
 * so the Overlay module is mocked via jest.unstable_mockModule (same pattern
 * as logger.test.js) — assigning window.YouSub.Overlay would not intercept it.
 */
const mockOverlay = {
  renderSubtitles: jest.fn(),
  show: jest.fn(),
  hide: jest.fn(),
};

jest.unstable_mockModule('../../src/content/overlay.js', () => ({
  Overlay: mockOverlay,
}));

const { SyncEngine } = await import('../../src/content/sync-engine.js');

// start() arms the timeupdate listener inside chrome.storage.local.get().then();
// flush two microtasks so the resolved-promise callback runs before we assert.
const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('SyncEngine Module', () => {
  let mockVideo;

  beforeEach(() => {
    SyncEngine.stop(); // reset module-level state (and Overlay.hide call) first
    jest.clearAllMocks(); // then wipe mockOverlay + chrome mock call counts
    chrome.storage.local.store = {};
    document.body.innerHTML = '';

    mockVideo = {
      currentTime: 0,
      // Non-zero size so onTimeUpdate() does not early-return on the Shorts
      // hidden-video guard.
      offsetWidth: 100,
      offsetHeight: 100,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
  });

  const subs = [
    { startMs: 1000, endMs: 2000, text: 'Hello' },
    { startMs: 3000, endMs: 4000, text: 'World' },
    { startMs: 5000, endMs: 6000, text: 'Foo' },
  ];

  test('should bind timeupdate listener on start', async () => {
    SyncEngine.start(subs, mockVideo);
    await flushMicrotasks();
    expect(mockVideo.addEventListener).toHaveBeenCalledWith('timeupdate', expect.any(Function));
  });

  test('should render correct subtitle at specific time (Binary Search)', async () => {
    SyncEngine.start(subs, mockVideo);
    await flushMicrotasks();
    const onTimeUpdate = mockVideo.addEventListener.mock.calls[0][1];

    // Case 1: 1500ms -> Hello
    mockVideo.currentTime = 1.5;
    onTimeUpdate();
    expect(mockOverlay.renderSubtitles).toHaveBeenCalledWith('Hello', undefined, false, false);

    // Case 2: 3500ms -> World
    mockVideo.currentTime = 3.5;
    onTimeUpdate();
    expect(mockOverlay.renderSubtitles).toHaveBeenCalledWith('World', undefined, false, false);
  });

  test('should hide overlay when moving from a subtitle into a gap', async () => {
    SyncEngine.start(subs, mockVideo);
    await flushMicrotasks();
    const onTimeUpdate = mockVideo.addEventListener.mock.calls[0][1];

    // Enter a subtitle first so currentIndex becomes valid...
    mockVideo.currentTime = 1.5; // Hello
    onTimeUpdate();
    // ...then move into the gap between 2000 and 3000 -> overlay hides.
    mockVideo.currentTime = 2.5;
    onTimeUpdate();
    expect(mockOverlay.hide).toHaveBeenCalled();
  });

  test('should optimize with temporal locality', async () => {
    SyncEngine.start(subs, mockVideo);
    await flushMicrotasks();
    const onTimeUpdate = mockVideo.addEventListener.mock.calls[0][1];

    // First lookup (Hello)
    mockVideo.currentTime = 1.5;
    onTimeUpdate();
    expect(mockOverlay.renderSubtitles).toHaveBeenCalledTimes(1);

    // Stay in current (1.8s) -> still Hello, no redundant render.
    mockVideo.currentTime = 1.8;
    onTimeUpdate();
    expect(mockOverlay.renderSubtitles).toHaveBeenCalledTimes(1);

    // Move to NEXT (3.1s) -> World (Temporal Locality: currentIndex + 1)
    mockVideo.currentTime = 3.1;
    onTimeUpdate();
    expect(mockOverlay.renderSubtitles).toHaveBeenLastCalledWith('World', undefined, false, false);
  });

  test('should stop and unbind listeners', async () => {
    SyncEngine.start(subs, mockVideo);
    await flushMicrotasks();
    SyncEngine.stop();
    expect(mockVideo.removeEventListener).toHaveBeenCalled();
  });
});
