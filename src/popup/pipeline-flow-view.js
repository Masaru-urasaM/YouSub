import { escapeHtml as esc } from '../shared/utils.js';
import { computeHorizons, formatTimeShort } from '../shared/pipeline-telemetry.js';

function t(i18nFn, key, fallback, substitutions) {
  if (typeof i18nFn === 'function') {
    return i18nFn(key, fallback, substitutions);
  }
  return fallback;
}

const STAGE_RANK = Object.freeze({
  IDLE: -1,
  EXTRACT: 0,
  COALESCE: 0,
  ROUTE: 1,
  VERIFY: 2,
  SYNC_CACHE: 3,
  COMPLETE: 4,
});

const EXTRACT_FAILURE_REASONS = new Set([
  'NO_SUBTITLES',
  'LIVE_STREAM_DETECTED',
  'EXTRACTION_FAILED',
]);

const STEPPER_STEPS = [
  { id: 'extract', labelKey: 'pipelineStageExtract', fallback: '1. Extract', stepRank: 0 },
  { id: 'route', labelKey: 'pipelineStageRoute', fallback: '2. Route', stepRank: 1 },
  { id: 'verify', labelKey: 'pipelineStageVerify', fallback: '3. Verify', stepRank: 2 },
  { id: 'sync', labelKey: 'pipelineStageSync', fallback: '4. Sync', stepRank: 3 },
];

function inferErrorRank(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 1;
  const reason = snapshot.error?.failureReason || '';
  if (EXTRACT_FAILURE_REASONS.has(reason)) return 0;
  return 1;
}

function getStageStatusList(stageOrSnapshot) {
  const snapshot = stageOrSnapshot && typeof stageOrSnapshot === 'object' ? stageOrSnapshot : null;
  const s = (snapshot ? snapshot.stage : stageOrSnapshot) || 'IDLE';
  const isErr = s === 'ERROR';
  const rank = STAGE_RANK[s] ?? (isErr ? inferErrorRank(snapshot) : -1);

  return STEPPER_STEPS.map(({ id, labelKey, fallback, stepRank }) => {
    let state = 'pending';
    if (isErr && rank === stepRank) state = 'error';
    else if (rank > stepRank) state = 'done';
    else if (rank === stepRank) state = 'active';
    return { id, labelKey, fallback, state };
  });
}

export function renderStepperHtml(snapshot, i18nFn) {
  const steps = getStageStatusList(snapshot);
  return `
    <div class="flow-stepper" role="list">
      ${steps
        .map((st, idx) => {
          const icon =
            st.state === 'done'
              ? '✓'
              : st.state === 'active'
                ? '●'
                : st.state === 'error'
                  ? '!'
                  : '○';
          const connector =
            idx < steps.length - 1
              ? `<span class="stepper-arrow ${st.state === 'done' ? 'is-done' : ''}">→</span>`
              : '';
          return `<span class="stepper-step is-${st.state}" role="listitem"><span class="stepper-icon">${icon}</span>${esc(t(i18nFn, st.labelKey, st.fallback))}</span>${connector}`;
        })
        .join('')}
    </div>
  `;
}

function resolveActiveRouteIndex(routes) {
  const activeIdx = routes.findIndex((r) => r.status === 'active');
  if (activeIdx >= 0) return activeIdx;
  const doneIdx = routes.findIndex((r) => r.status === 'done');
  if (doneIdx >= 0) return doneIdx;
  const nonStandbyIdx = routes.findIndex((r) => r.status !== 'standby' && r.status !== 'failover');
  return nonStandbyIdx >= 0 ? nonStandbyIdx : 0;
}

function deriveRouteVisualState(route, ctx) {
  if (ctx.rank < 1) {
    return { nodeTone: 'node-standby', inPipeClass: 'flow-pipe flow-pipe-standby' };
  }
  const isImplicitRouteFail =
    ctx.isErr && ctx.rank === 1 && route.status === 'active' && !ctx.anyExplicitFailedRoute;
  if (route.status === 'failed' || isImplicitRouteFail) {
    return { nodeTone: 'node-error', inPipeClass: 'flow-pipe flow-pipe-error' };
  }
  const isFailedOver =
    route.status === 'failover' || ctx.failovers.some((f) => f.fromModel === route.model);
  if (isFailedOver) {
    return { nodeTone: 'node-warn', inPipeClass: 'flow-pipe flow-pipe-failover' };
  }
  if (route.status === 'standby') {
    return { nodeTone: 'node-standby', inPipeClass: 'flow-pipe flow-pipe-standby' };
  }
  if (ctx.rank >= 2 || route.status === 'done') {
    return { nodeTone: 'node-done', inPipeClass: 'flow-pipe flow-pipe-done' };
  }
  return { nodeTone: 'node-active', inPipeClass: 'flow-pipe flow-pipe-active' };
}

function deriveFlowVisualState(snapshot) {
  const stage = snapshot?.stage || 'IDLE';
  const isCache = snapshot?.mode === 'cache';
  const isGemini = snapshot?.mode === 'gemini-video';
  const isErr = stage === 'ERROR';
  const isDone = stage === 'COMPLETE';
  const rank = STAGE_RANK[stage] ?? (isErr ? inferErrorRank(snapshot) : -1);

  const batches = Array.isArray(snapshot?.batches) ? snapshot.batches : [];
  const hasDoneBatch = batches.some((b) => b?.status === 'DONE');
  const verFixes =
    (snapshot?.verification?.mergeFixes || 0) +
    (snapshot?.verification?.foreignScriptFixes || 0) +
    (snapshot?.verification?.untranslatedFixes || 0);
  const syncedCues = snapshot?.sink?.syncedCues || 0;
  const totalCues = snapshot?.sink?.totalCues || 0;
  const hasSynced = syncedCues > 0;

  // Step 1a: Extract node
  let extractTone = 'node-done';
  if (isErr && rank === 0) extractTone = 'node-error';
  else if (stage === 'EXTRACT') extractTone = 'node-active';
  else if (stage === 'IDLE') extractTone = 'node-standby';

  // Step 1b: Extract -> Coalescer pipe & Coalescer node
  let extractToCoalPipe = 'flow-pipe flow-pipe-done';
  let coalesceTone = 'node-done';
  if (stage === 'IDLE' || stage === 'EXTRACT' || (isErr && rank === 0)) {
    extractToCoalPipe = 'flow-pipe flow-pipe-standby';
    coalesceTone = 'node-standby';
  } else if (stage === 'COALESCE') {
    extractToCoalPipe = 'flow-pipe flow-pipe-active';
    coalesceTone = 'node-active';
  }

  // Labels for Extract & Coalescer
  const sourceTitle = isCache
    ? 'LRU Cache'
    : isGemini
      ? 'Gemini URL'
      : snapshot?.extraction?.source === 'srt-import'
        ? 'SRT / VTT'
        : snapshot?.extraction?.source === 'timedtext'
          ? 'Timedtext'
          : 'DOM Transcript';

  const rawCount = snapshot?.coalescer?.rawCount || 0;
  const coalCount = snapshot?.coalescer?.coalescedCount || 0;
  let coalesceLabel;
  if (isCache) coalesceLabel = 'Direct Load';
  else if (isGemini) coalesceLabel = stage === 'EXTRACT' ? 'Waiting...' : '240s Window';
  else if (rawCount > 0) coalesceLabel = `${rawCount}→${coalCount} cues`;
  else coalesceLabel = stage === 'EXTRACT' || stage === 'IDLE' ? 'Waiting...' : 'Coalescer';

  // Step 2: Router -> Verify pipe (single linear transition, never fan-split to Sync)
  let routeToVerifyPipe = 'flow-pipe flow-pipe-standby';
  if (isDone || rank >= 3) routeToVerifyPipe = 'flow-pipe flow-pipe-done';
  else if (stage === 'VERIFY') routeToVerifyPipe = 'flow-pipe flow-pipe-active';
  else if ((stage === 'ROUTE' || isErr) && (hasDoneBatch || hasSynced)) {
    routeToVerifyPipe = 'flow-pipe flow-pipe-done';
  }

  // Step 3: Verify / Fix node
  let verifyTone = 'node-standby';
  if (isDone || rank >= 3 || ((stage === 'ROUTE' || isErr) && (hasDoneBatch || verFixes > 0))) {
    verifyTone = 'node-done';
  } else if (stage === 'VERIFY') {
    verifyTone = 'node-active';
  }

  let verifyLabel;
  if (isCache) verifyLabel = 'Bypass';
  else if (verFixes > 0) verifyLabel = `Fixed (${verFixes})`;
  else if (stage === 'VERIFY') verifyLabel = 'Checking...';
  else if (isDone || rank >= 3 || hasDoneBatch) verifyLabel = 'Verify Clean';
  else if (isErr) verifyLabel = 'Skipped';
  else verifyLabel = 'Waiting...';

  // Step 4: Verify -> Sync & Cache pipe and node
  let verifyToSinkPipe = 'flow-pipe flow-pipe-standby';
  if (isDone) verifyToSinkPipe = 'flow-pipe flow-pipe-done';
  else if (stage === 'SYNC_CACHE') verifyToSinkPipe = 'flow-pipe flow-pipe-active';
  else if ((stage === 'ROUTE' || stage === 'VERIFY' || isErr) && hasSynced) {
    verifyToSinkPipe = 'flow-pipe flow-pipe-done';
  }

  let sinkTone = 'node-standby';
  if (isDone) sinkTone = 'node-done';
  else if (stage === 'SYNC_CACHE') sinkTone = 'node-active';
  else if ((stage === 'ROUTE' || stage === 'VERIFY' || isErr) && hasSynced) sinkTone = 'node-done';

  let sinkLabel;
  if (totalCues > 0) sinkLabel = `${syncedCues}/${totalCues} cues`;
  else if (syncedCues > 0) sinkLabel = `${syncedCues} cues`;
  else if (isDone) sinkLabel = '0 cues';
  else if (isErr) sinkLabel = 'No cues';
  else sinkLabel = 'Waiting...';

  return {
    stage,
    isCache,
    isGemini,
    isErr,
    isDone,
    rank,
    sourceTitle,
    coalesceLabel,
    extractTone,
    extractToCoalPipe,
    coalesceTone,
    routeToVerifyPipe,
    verifyTone,
    verifyLabel,
    verifyToSinkPipe,
    sinkTone,
    sinkLabel,
  };
}

export function renderFlowSvg(snapshot, { compact = true } = {}) {
  const width = compact ? 286 : 740;
  const height = compact ? 116 : 186;
  const vis = deriveFlowVisualState(snapshot);

  const defaultRouteStatus = vis.isDone
    ? 'done'
    : vis.isErr && vis.rank >= 1
      ? 'failed'
      : vis.rank >= 1
        ? 'active'
        : 'standby';

  const routes =
    Array.isArray(snapshot?.router?.routes) && snapshot.router.routes.length > 0
      ? snapshot.router.routes.slice(0, 3)
      : [
          {
            provider: snapshot?.router?.activeProvider || (vis.isCache ? 'cache' : 'llm'),
            model: snapshot?.router?.activeModel || (vis.isCache ? 'cached' : 'waiting...'),
            keyMask: snapshot?.router?.keyMask || '',
            status: defaultRouteStatus,
          },
        ];

  const activeRouteIdx = resolveActiveRouteIndex(routes);
  const failovers = snapshot?.router?.failovers || [];
  const routeCtx = {
    rank: vis.rank,
    isErr: vis.isErr,
    failovers,
    anyExplicitFailedRoute: routes.some((rt) => rt.status === 'failed'),
  };

  // Geometry calibrated for both compact Popup (286x116) and Debug DAG (740x186)
  const inX = compact ? 4 : 16;
  const inW = compact ? 68 : 166;
  const midX = compact ? 88 : 266;
  const midW = compact ? 104 : 216;
  const outX = compact ? 208 : 560;
  const outW = compact ? 74 : 164;

  const boxH = compact ? 32 : 42;
  const smallBoxH = compact ? 26 : 34;

  const input1Y = compact ? 14 : 26;
  const input2Y = compact ? 64 : 104;
  const out1Y = compact ? 14 : 26;
  const out2Y = compact ? 64 : 104;

  const routeGap = compact ? 34 : 50;
  const routeTop =
    routes.length === 1
      ? compact
        ? 40
        : 68
      : routes.length === 2
        ? compact
          ? 20
          : 40
        : compact
          ? 8
          : 18;

  const inOutPortX = inX + inW;
  const midInPortX = midX;
  const midOutPortX = midX + midW;
  const outInPortX = outX;

  const coalCenterY = input2Y + boxH / 2;
  const out1CenterY = out1Y + boxH / 2;

  const bezier = (x1, y1, x2, y2) => {
    const c1x = x1 + Math.round((x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${c1x} ${y1}, ${c1x} ${y2}, ${x2} ${y2}`;
  };

  const pipesSvg = [];
  const routeNodesSvg = [];

  routes.forEach((r, idx) => {
    const ry = routeTop + idx * routeGap;
    const rcy = ry + smallBoxH / 2;
    const { nodeTone, inPipeClass } = deriveRouteVisualState(r, routeCtx);

    // Coalescer feeds directly into each router candidate; active route continues to Verify / Fix
    pipesSvg.push(
      `<path class="${inPipeClass}" d="${bezier(inOutPortX, coalCenterY, midInPortX, rcy)}" />`
    );
    if (idx === activeRouteIdx) {
      pipesSvg.push(
        `<path class="${vis.routeToVerifyPipe}" d="${bezier(midOutPortX, rcy, outInPortX, out1CenterY)}" />`
      );
    }

    const cleanModel = String(r.model || r.provider || 'Model').replace(/^models\//, '');
    const maxChars = compact ? 22 : 30;
    const modelShort =
      cleanModel.length > maxChars ? cleanModel.slice(0, maxChars - 1) + '…' : cleanModel;
    const provTag = `${r.provider || 'llm'}${r.keyMask ? ` ${r.keyMask}` : ''}`;
    const titleCls =
      compact && modelShort.length > 16 ? 'flow-node-title is-compact-long' : 'flow-node-title';
    const textPadX = compact ? 5 : 6;

    routeNodesSvg.push(`
      <g class="flow-node ${nodeTone}">
        <title>${esc(cleanModel)} (${esc(provTag)})</title>
        <rect x="${midX}" y="${ry}" width="${midW}" height="${smallBoxH}" rx="6" />
        <text x="${midX + textPadX}" y="${ry + (compact ? 11 : 14)}" class="${titleCls}">${esc(modelShort)}</text>
        <text x="${midX + textPadX}" y="${ry + (compact ? 21 : 27)}" class="flow-node-sub">${esc(provTag)}</text>
      </g>
    `);
  });

  // Vertical pipe from Input 1 -> Input 2 (Extract -> Coalescer)
  pipesSvg.unshift(
    `<path class="${vis.extractToCoalPipe}" d="M ${inX + inW / 2} ${input1Y + boxH} L ${inX + inW / 2} ${input2Y}" />`
  );

  // Vertical pipe from Output 1 -> Output 2 (Verify / Fix -> Sync & Cache)
  pipesSvg.push(
    `<path class="${vis.verifyToSinkPipe}" d="M ${outX + outW / 2} ${out1Y + boxH} L ${outX + outW / 2} ${out2Y}" />`
  );

  const srcMax = compact ? 11 : 20;
  const srcShort =
    vis.sourceTitle.length > srcMax ? vis.sourceTitle.slice(0, srcMax - 1) + '…' : vis.sourceTitle;
  const padX = compact ? 5 : 6;

  return `
    <svg class="sparrow-flow-svg ${compact ? 'is-compact' : 'is-full'}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pipeline execution graph">
      <g class="flow-pipes">${pipesSvg.join('')}</g>
      <g class="flow-nodes">
        <g class="flow-node ${vis.extractTone}">
          <title>${esc(vis.sourceTitle)}</title>
          <rect x="${inX}" y="${input1Y}" width="${inW}" height="${boxH}" rx="6" />
          <text x="${inX + padX}" y="${input1Y + (compact ? 13 : 17)}" class="flow-node-title">${esc(srcShort)}</text>
          <text x="${inX + padX}" y="${input1Y + (compact ? 25 : 32)}" class="flow-node-sub">${esc(snapshot?.extraction?.sourceLang || 'auto')} → ${esc(snapshot?.extraction?.targetLang || 'vi')}</text>
        </g>
        <g class="flow-node ${vis.coalesceTone}">
          <rect x="${inX}" y="${input2Y}" width="${inW}" height="${boxH}" rx="6" />
          <text x="${inX + padX}" y="${input2Y + (compact ? 13 : 17)}" class="flow-node-title">Coalescer</text>
          <text x="${inX + padX}" y="${input2Y + (compact ? 25 : 32)}" class="flow-node-sub">${esc(vis.coalesceLabel)}</text>
        </g>
        ${routeNodesSvg.join('')}
        <g class="flow-node ${vis.verifyTone}">
          <rect x="${outX}" y="${out1Y}" width="${outW}" height="${boxH}" rx="6" />
          <text x="${outX + padX}" y="${out1Y + (compact ? 13 : 17)}" class="flow-node-title">Verify / Fix</text>
          <text x="${outX + padX}" y="${out1Y + (compact ? 25 : 32)}" class="flow-node-sub">${esc(vis.verifyLabel)}</text>
        </g>
        <g class="flow-node ${vis.sinkTone}">
          <rect x="${outX}" y="${out2Y}" width="${outW}" height="${boxH}" rx="6" />
          <text x="${outX + padX}" y="${out2Y + (compact ? 13 : 17)}" class="flow-node-title">Sync &amp; Cache</text>
          <text x="${outX + padX}" y="${out2Y + (compact ? 25 : 32)}" class="flow-node-sub">${esc(vis.sinkLabel)}</text>
        </g>
      </g>
    </svg>
  `;
}

export function renderBatchTimelineHtml(snapshot, { selectedBatch = null } = {}) {
  const batches = Array.isArray(snapshot?.batches) ? snapshot.batches : [];
  if (batches.length === 0) return '';

  const playheadIdx = snapshot?.playheadBatchIndex ?? 0;

  return `
    <div class="batch-timeline-wrap">
      <div class="batch-timeline-bar" role="list" aria-label="Translation batches">
        ${batches
          .map((b) => {
            const st = (b.status || 'PENDING').toLowerCase();
            const isSelected = selectedBatch !== null && Number(selectedBatch) === b.batchIndex;
            const isPlayhead = b.batchIndex === playheadIdx;
            const cls = [
              'batch-seg',
              `is-${st.replace('_', '-')}`,
              b.isSeekTarget ? 'is-seek' : '',
              isPlayhead ? 'is-playhead' : '',
              isSelected ? 'is-selected' : '',
            ]
              .filter(Boolean)
              .join(' ');
            const timeRange =
              typeof b.startMs === 'number' && typeof b.endMs === 'number'
                ? `${formatTimeShort(b.startMs)}–${formatTimeShort(b.endMs)}`
                : `Lines ${b.startLine}-${b.endLine}`;
            const tip = `Batch #${b.batchIndex + 1} (${timeRange}) · ${b.status}${b.model ? ` · ${b.model}` : ''}`;
            const marker = isPlayhead ? '<span class="playhead-pin">▼</span>' : '';
            const label = b.isSeekTarget ? `⚡${b.batchIndex + 1}` : `#${b.batchIndex + 1}`;
            return `<button type="button" class="${cls}" data-batch-index="${b.batchIndex}" title="${esc(tip)}">${marker}${esc(label)}</button>`;
          })
          .join('')}
      </div>
    </div>
  `;
}

export function renderHorizonsHtml(snapshot, i18nFn) {
  const horizons = snapshot?.horizons || computeHorizons(snapshot);
  const pastLabel = t(i18nFn, 'pipelineHorizonPast', 'Past');
  const presentLabel = t(i18nFn, 'pipelineHorizonPresent', 'Now');
  const futureLabel = t(i18nFn, 'pipelineHorizonFuture', 'Next');

  return `
    <div class="horizons-list">
      <div class="horizon-row horizon-past">
        <span class="horizon-badge">${esc(pastLabel)}</span>
        <span class="horizon-text" title="${esc(horizons.past)}">${esc(horizons.past)}</span>
      </div>
      <div class="horizon-row horizon-present">
        <span class="horizon-badge">${esc(presentLabel)}</span>
        <span class="horizon-text" title="${esc(horizons.present)}">${esc(horizons.present)}</span>
      </div>
      <div class="horizon-row horizon-future">
        <span class="horizon-badge">${esc(futureLabel)}</span>
        <span class="horizon-text" title="${esc(horizons.future)}">${esc(horizons.future)}</span>
      </div>
    </div>
  `;
}

export const PipelineFlowView = {
  renderStepperHtml,
  renderFlowSvg,
  renderBatchTimelineHtml,
  renderHorizonsHtml,

  renderPopupFlow(containerEl, snapshot, i18nFn) {
    if (!containerEl) return;
    if (!snapshot) {
      containerEl.classList.add('hidden');
      containerEl.innerHTML = '';
      return;
    }

    containerEl.classList.remove('hidden');
    containerEl.innerHTML = `
      <div class="flow-card">
        ${renderStepperHtml(snapshot, i18nFn)}
        <div class="flow-svg-wrap">${renderFlowSvg(snapshot, { compact: true })}</div>
        ${renderBatchTimelineHtml(snapshot)}
        ${renderHorizonsHtml(snapshot, i18nFn)}
      </div>
    `;
  },

  renderInspectorFlow(containerEl, snapshot, i18nFn, { selectedBatch = null } = {}) {
    if (!containerEl) return;
    if (!snapshot) {
      containerEl.innerHTML = `
        <div class="inspector-empty">
          <strong>No live pipeline telemetry yet.</strong>
          <span>Start translating a video to inspect the live Extraction → Coalescer → Router → Verification → Sync flow.</span>
        </div>
      `;
      return;
    }

    const failovers = snapshot.router?.failovers || [];
    const failoverHtml =
      failovers.length > 0
        ? `<div class="inspector-failovers">${failovers
            .slice(-4)
            .map(
              (f) =>
                `<span class="failover-chip">↷ ${esc(f.fromProvider)}/${esc(f.fromModel)} (${esc(f.reason)}) → ${esc(f.toProvider || '?')}/${esc(f.toModel || '?')}</span>`
            )
            .join('')}</div>`
        : '';

    const resetBtn =
      selectedBatch !== null
        ? `<button type="button" class="batch-filter-reset" data-batch-reset="true">Show All Batches</button>`
        : '';

    containerEl.innerHTML = `
      <div class="inspector-card">
        <div class="inspector-header">
          <div class="inspector-title">
            <span class="inspector-vid">${esc(snapshot.videoId || 'Pipeline')}</span>
            <span class="inspector-mode-badge">${esc(snapshot.mode || 'transcript')}</span>
          </div>
          ${resetBtn}
        </div>
        ${renderStepperHtml(snapshot, i18nFn)}
        <div class="inspector-svg-wrap">${renderFlowSvg(snapshot, { compact: false })}</div>
        ${failoverHtml}
        ${renderBatchTimelineHtml(snapshot, { selectedBatch })}
        ${renderHorizonsHtml(snapshot, i18nFn)}
      </div>
    `;
  },
};
