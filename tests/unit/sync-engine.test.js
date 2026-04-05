import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('SyncEngine Module', () => {
  let YS;
  let mockVideo;
  let mockOverlay;
  const scriptPath = path.resolve(__dirname, '../../src/content/sync-engine.js');
  const scriptContent = fs.readFileSync(scriptPath, 'utf8');

  beforeEach(() => {
    // Setup JSDOM globals
    document.body.innerHTML = '';
    window.YouSub = {};
    YS = window.YouSub;
    
    // Mock Overlay
    mockOverlay = {
      renderSubtitles: jest.fn(),
      show: jest.fn(),
      hide: jest.fn()
    };
    YS.Overlay = mockOverlay;

    // Mock Video Element
    mockVideo = {
      currentTime: 0,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn()
    };

    // Execute the script in global context (JSDOM window)
    eval(scriptContent);
  });

  const subs = [
    { startMs: 1000, endMs: 2000, text: 'Hello' },
    { startMs: 3000, endMs: 4000, text: 'World' },
    { startMs: 5000, endMs: 6000, text: 'Foo' }
  ];

  test('should bind timeupdate listener on start', async () => {
    await YS.SyncEngine.start(subs, mockVideo);
    expect(mockVideo.addEventListener).toHaveBeenCalledWith('timeupdate', expect.any(Function));
  });

  test('should render correct subtitle at specific time (Binary Search)', async () => {
    await YS.SyncEngine.start(subs, mockVideo);
    const onTimeUpdate = mockVideo.addEventListener.mock.calls[0][1];

    // Case 1: 1500ms -> Hello
    mockVideo.currentTime = 1.5;
    onTimeUpdate();
    expect(mockOverlay.renderSubtitles).toHaveBeenCalledWith('Hello', undefined, false);

    // Case 2: 3500ms -> World
    mockVideo.currentTime = 3.5;
    onTimeUpdate();
    expect(mockOverlay.renderSubtitles).toHaveBeenCalledWith('World', undefined, false);
  });

  test('should hide overlay when no subtitle matches', async () => {
    await YS.SyncEngine.start(subs, mockVideo);
    const onTimeUpdate = mockVideo.addEventListener.mock.calls[0][1];

    mockVideo.currentTime = 2.5; // Gap between 2000 and 3000
    onTimeUpdate();
    expect(mockOverlay.hide).toHaveBeenCalled();
  });

  test('should optimize with temporal locality', async () => {
    await YS.SyncEngine.start(subs, mockVideo);
    const onTimeUpdate = mockVideo.addEventListener.mock.calls[0][1];

    // First lookup (Hello)
    mockVideo.currentTime = 1.5;
    onTimeUpdate();
    expect(mockOverlay.renderSubtitles).toHaveBeenCalledTimes(1);

    // Stay in current (1.8s) -> Should still be Hello, no redundant render if same
    // Wait, SyncEngine only renders on change.
    mockVideo.currentTime = 1.8;
    onTimeUpdate();
    expect(mockOverlay.renderSubtitles).toHaveBeenCalledTimes(1);

    // Move to NEXT (3.1s) -> World (Temporal Locality: currentIndex + 1)
    mockVideo.currentTime = 3.1;
    onTimeUpdate();
    expect(mockOverlay.renderSubtitles).toHaveBeenLastCalledWith('World', undefined, false);
  });

  test('should stop and unbind listeners', async () => {
    await YS.SyncEngine.start(subs, mockVideo);
    YS.SyncEngine.stop();
    expect(mockVideo.removeEventListener).toHaveBeenCalled();
  });
});
