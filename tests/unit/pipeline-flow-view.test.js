import { describe, test, expect } from '@jest/globals';
import { PipelineFlowView } from '../../src/popup/pipeline-flow-view.js';

function parseSvgDom(svgHtml) {
  const wrap = document.createElement('div');
  wrap.innerHTML = svgHtml;
  return wrap;
}

describe('PipelineFlowView Sparrow-style visualizer', () => {
  test('renders sequential stage states during EXTRACT (only Extract active; downstream standby)', () => {
    const html = PipelineFlowView.renderStepperHtml({ stage: 'EXTRACT' });
    expect(html).toContain('is-active');
    expect(html).not.toContain('is-done');

    const svgWrap = parseSvgDom(
      PipelineFlowView.renderFlowSvg({
        stage: 'EXTRACT',
        mode: 'transcript',
        extraction: { source: 'timedtext', sourceLang: 'ja', targetLang: 'vi' },
      })
    );

    const nodes = Array.from(svgWrap.querySelectorAll('.flow-node'));
    expect(nodes).toHaveLength(5);
    expect(nodes[0].classList.contains('node-active')).toBe(true); // Extract
    expect(nodes[1].classList.contains('node-standby')).toBe(true); // Coalescer
    expect(nodes[2].classList.contains('node-standby')).toBe(true); // Router
    expect(nodes[3].classList.contains('node-standby')).toBe(true); // Verify / Fix
    expect(nodes[4].classList.contains('node-standby')).toBe(true); // Sync & Cache
    expect(nodes[3].textContent).toContain('Waiting...');
    expect(nodes[4].textContent).toContain('Waiting...');

    const pipes = Array.from(svgWrap.querySelectorAll('.flow-pipe'));
    // Extract->Coal + Coal->Route + Route->Verify + Verify->Sync = 4 pipes (no Router->Sync fork)
    expect(pipes).toHaveLength(4);
    expect(pipes.every((p) => p.classList.contains('flow-pipe-standby'))).toBe(true);
  });

  test('renders ROUTE for gemini-video batch #1 without premature active Verify/Sync or split fork', () => {
    const snap = {
      videoId: 'vid-gemini',
      mode: 'gemini-video',
      stage: 'ROUTE',
      extraction: { source: 'gemini-url', sourceLang: 'auto', targetLang: 'vi' },
      router: {
        activeProvider: 'google',
        activeModel: 'gemini-2.5-flash-lite',
      },
      batches: [{ batchIndex: 0, startMs: 0, endMs: 240000, status: 'IN_FLIGHT' }],
      sink: { syncedCues: 0, totalCues: 0 },
    };

    const stepperWrap = parseSvgDom(PipelineFlowView.renderStepperHtml(snap));
    const steps = Array.from(stepperWrap.querySelectorAll('.stepper-step'));
    expect(steps[0].classList.contains('is-done')).toBe(true);
    expect(steps[1].classList.contains('is-active')).toBe(true);
    expect(steps[2].classList.contains('is-pending')).toBe(true);
    expect(steps[3].classList.contains('is-pending')).toBe(true);

    const svgWrap = parseSvgDom(PipelineFlowView.renderFlowSvg(snap, { compact: true }));
    const nodes = Array.from(svgWrap.querySelectorAll('.flow-node'));
    expect(nodes[0].classList.contains('node-done')).toBe(true); // Gemini URL
    expect(nodes[1].classList.contains('node-done')).toBe(true); // Coalescer (240s Window)
    expect(nodes[2].classList.contains('node-active')).toBe(true); // Router
    expect(nodes[3].classList.contains('node-standby')).toBe(true); // Verify / Fix
    expect(nodes[4].classList.contains('node-standby')).toBe(true); // Sync & Cache

    // Displays full compact model name + longer-name compact font class
    expect(nodes[2].textContent).toContain('gemini-2.5-flash-lite');
    expect(nodes[2].querySelector('.is-compact-long')).not.toBeNull();
    expect(nodes[3].textContent).toContain('Waiting...');
    expect(nodes[4].textContent).toContain('Waiting...');

    const pipes = Array.from(svgWrap.querySelectorAll('.flow-pipe'));
    expect(pipes).toHaveLength(4);
    expect(pipes[0].classList.contains('flow-pipe-done')).toBe(true); // Extract -> Coalescer
    expect(pipes[1].classList.contains('flow-pipe-active')).toBe(true); // Coalescer -> Router
    expect(pipes[2].classList.contains('flow-pipe-standby')).toBe(true); // Router -> Verify
    expect(pipes[3].classList.contains('flow-pipe-standby')).toBe(true); // Verify -> Sync
  });

  test('distinguishes streaming partial sync during ongoing ROUTE vs VERIFY and SYNC_CACHE', () => {
    const streamingSnap = {
      mode: 'gemini-video',
      stage: 'ROUTE',
      extraction: { source: 'gemini-url', sourceLang: 'auto', targetLang: 'vi' },
      router: { activeProvider: 'google', activeModel: 'gemini-2.5-flash' },
      batches: [
        { batchIndex: 0, startMs: 0, endMs: 240000, status: 'DONE' },
        { batchIndex: 1, startMs: 240000, endMs: 480000, status: 'IN_FLIGHT' },
      ],
      sink: { syncedCues: 32, totalCues: 32 },
    };

    const streamWrap = parseSvgDom(PipelineFlowView.renderFlowSvg(streamingSnap));
    const streamNodes = Array.from(streamWrap.querySelectorAll('.flow-node'));
    expect(streamNodes[2].classList.contains('node-active')).toBe(true); // Router busy with batch #2
    expect(streamNodes[3].classList.contains('node-done')).toBe(true); // Batch #1 verified clean
    expect(streamNodes[3].textContent).toContain('Verify Clean');
    expect(streamNodes[4].classList.contains('node-done')).toBe(true); // Batch #1 synced
    expect(streamNodes[4].textContent).toContain('32/32 cues');

    const verifyWrap = parseSvgDom(
      PipelineFlowView.renderFlowSvg({
        ...streamingSnap,
        stage: 'VERIFY',
        batches: [{ batchIndex: 0, status: 'IN_FLIGHT' }],
        sink: { syncedCues: 0, totalCues: 0 },
      })
    );
    const verifyNodes = Array.from(verifyWrap.querySelectorAll('.flow-node'));
    expect(verifyNodes[2].classList.contains('node-done')).toBe(true);
    expect(verifyNodes[3].classList.contains('node-active')).toBe(true);
    expect(verifyNodes[3].textContent).toContain('Checking...');
    expect(verifyNodes[4].classList.contains('node-standby')).toBe(true);

    const syncWrap = parseSvgDom(
      PipelineFlowView.renderFlowSvg({
        ...streamingSnap,
        stage: 'SYNC_CACHE',
        verification: { mergeFixes: 2, foreignScriptFixes: 1, untranslatedFixes: 0 },
        sink: { syncedCues: 40, totalCues: 40 },
      })
    );
    const syncNodes = Array.from(syncWrap.querySelectorAll('.flow-node'));
    expect(syncNodes[3].classList.contains('node-done')).toBe(true);
    expect(syncNodes[3].textContent).toContain('Fixed (3)');
    expect(syncNodes[4].classList.contains('node-active')).toBe(true);
  });

  test('localizes NO_SUBTITLES error at Extract vs router failure at Route and anchors failover output to active route', () => {
    const extractErrSnap = {
      stage: 'ERROR',
      error: { failureReason: 'NO_SUBTITLES', message: 'Could not find subtitles' },
    };
    const extractErrStepper = parseSvgDom(PipelineFlowView.renderStepperHtml(extractErrSnap));
    const exSteps = Array.from(extractErrStepper.querySelectorAll('.stepper-step'));
    expect(exSteps[0].classList.contains('is-error')).toBe(true);
    expect(exSteps[1].classList.contains('is-pending')).toBe(true);

    const extractErrSvg = parseSvgDom(PipelineFlowView.renderFlowSvg(extractErrSnap));
    const exNodes = Array.from(extractErrSvg.querySelectorAll('.flow-node'));
    expect(exNodes[0].classList.contains('node-error')).toBe(true);
    expect(exNodes[2].classList.contains('node-standby')).toBe(true);
    expect(exNodes[3].textContent).toContain('Skipped');
    expect(exNodes[4].textContent).toContain('No cues');

    const failoverDoneSnap = {
      stage: 'COMPLETE',
      mode: 'transcript',
      extraction: { source: 'timedtext', sourceLang: 'en', targetLang: 'vi' },
      coalescer: { rawCount: 80, coalescedCount: 50 },
      router: {
        routes: [
          { provider: 'google', model: 'gemini-2.5-flash', keyMask: '...1111', status: 'failover' },
          {
            provider: 'groq',
            model: 'llama-3.3-70b-versatile',
            keyMask: '...2222',
            status: 'done',
          },
        ],
        failovers: [{ fromModel: 'gemini-2.5-flash', toModel: 'llama-3.3-70b-versatile' }],
      },
      sink: { syncedCues: 50, totalCues: 50 },
    };
    const failoverSvg = parseSvgDom(PipelineFlowView.renderFlowSvg(failoverDoneSnap));
    const fNodes = Array.from(failoverSvg.querySelectorAll('.flow-node'));
    expect(fNodes).toHaveLength(6); // 2 left + 2 route + 2 right
    expect(fNodes[2].classList.contains('node-warn')).toBe(true); // Failover route
    expect(fNodes[3].classList.contains('node-done')).toBe(true); // Winning done route
  });

  test('renders cache bypass mode with all nodes completed cleanly', () => {
    const cacheSnap = {
      mode: 'cache',
      stage: 'COMPLETE',
      extraction: { source: 'cache', sourceLang: 'en', targetLang: 'vi' },
      sink: { syncedCues: 42, totalCues: 42, cached: true },
    };
    const svgWrap = parseSvgDom(PipelineFlowView.renderFlowSvg(cacheSnap, { compact: false }));
    const nodes = Array.from(svgWrap.querySelectorAll('.flow-node'));
    expect(nodes[0].textContent).toContain('LRU Cache');
    expect(nodes[1].textContent).toContain('Direct Load');
    expect(nodes[3].textContent).toContain('Bypass');
    expect(nodes[4].textContent).toContain('42/42 cues');
    expect(nodes.every((n) => n.classList.contains('node-done'))).toBe(true);
  });
});
