import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { SyncEngine } from '../../src/content/sync-engine.js';

/**
 * Phase 66 (B2) — start()/stop() race regression.
 *
 * SyncEngine.start() registers the 'timeupdate' listener inside an async
 * chrome.storage.local.get(...).then() callback. If stop() runs before that
 * promise resolves (e.g. the user swipes to the next Short), videoElement is
 * already null when the callback fires. The guard added in Phase 66 must make
 * the late callback bail out — neither throwing on addEventListener(null) nor
 * re-arming a torn-down engine.
 */
describe('SyncEngine start/stop race (Phase 66 B2)', () => {
  const makeVideo = () => ({
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    // 0x0 size makes onTimeUpdate() return early, so the happy path never
    // touches the Overlay (which is not mounted in this unit test).
    offsetWidth: 0,
    offsetHeight: 0,
    currentTime: 0,
  });

  const subs = [{ startMs: 0, endMs: 1000, original: 'a', text: 'a' }];

  beforeEach(() => {
    SyncEngine.stop();
    jest.clearAllMocks();
    chrome.storage.local.store = {};
  });

  test('late storage callback bails out when stop() won the race (no throw, no listener)', async () => {
    const video = makeVideo();
    let callbackError = null;

    // Return a thenable that defers start()'s callback to a microtask, so the
    // synchronous stop() below tears the engine down before the callback runs.
    chrome.storage.local.get.mockImplementationOnce(() => ({
      then: (cb) => {
        Promise.resolve().then(() => {
          try {
            cb({ yousub_dual_mode: false });
          } catch (e) {
            callbackError = e;
          }
        });
      },
    }));

    SyncEngine.start(subs, video);
    SyncEngine.stop(); // wins the race — videoElement becomes null

    // Flush the deferred storage callback.
    await Promise.resolve();
    await Promise.resolve();

    // Without the guard this is a TypeError from videoElement.addEventListener(null).
    expect(callbackError).toBeNull();
    expect(video.addEventListener).not.toHaveBeenCalled();
    expect(SyncEngine.isActive()).toBe(false);
  });

  test('normal start() still arms the timeupdate listener once storage resolves', async () => {
    const video = makeVideo();

    SyncEngine.start(subs, video); // default mock get() resolves on a microtask
    await Promise.resolve();
    await Promise.resolve();

    expect(video.addEventListener).toHaveBeenCalledWith('timeupdate', expect.any(Function));
    expect(SyncEngine.isActive()).toBe(true);

    SyncEngine.stop();
    expect(SyncEngine.isActive()).toBe(false);
    expect(video.removeEventListener).toHaveBeenCalledWith('timeupdate', expect.any(Function));
  });
});
