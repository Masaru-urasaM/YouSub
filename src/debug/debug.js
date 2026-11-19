import { escapeHtml as esc } from '../shared/utils.js';
import { PipelineTelemetry, PIPELINE_KEY_PREFIX } from '../shared/pipeline-telemetry.js';
import { PipelineFlowView } from '../popup/pipeline-flow-view.js';

document.addEventListener('DOMContentLoaded', async () => {
  const inspectorEl = document.getElementById('pipeline-inspector');
  const debugList = document.getElementById('debug-list');
  const clearBtn = document.getElementById('clear-debug-btn');
  const refreshBtn = document.getElementById('refresh-debug-btn');
  const copyAllBtn = document.getElementById('copy-all-btn');

  let selectedBatchIndex = null;
  let latestSnapshot = null;

  async function loadInspector() {
    if (!inspectorEl) return;
    try {
      latestSnapshot = await PipelineTelemetry.getLatestSnapshot();
      PipelineFlowView.renderInspectorFlow(inspectorEl, latestSnapshot, null, {
        selectedBatch: selectedBatchIndex,
      });
    } catch {
      PipelineFlowView.renderInspectorFlow(inspectorEl, null, null);
    }
  }

  async function loadLogs() {
    const data = await browser.storage.local.get('yousub_debug_history');
    const logs = data.yousub_debug_history || [];

    if (logs.length === 0) {
      debugList.innerHTML =
        '<div class="empty-state">No batches recorded yet. Start a translation to see data here.</div>';
      return;
    }

    let visibleLogs = logs;
    if (selectedBatchIndex !== null && latestSnapshot && Array.isArray(latestSnapshot.batches)) {
      const targetBatch = latestSnapshot.batches[selectedBatchIndex];
      if (targetBatch) {
        const filtered = logs.filter((log) => {
          if (log.windowRange && targetBatch.startMs != null && targetBatch.endMs != null) {
            const expectedStart = `${Math.floor(targetBatch.startMs / 1000)}s-`;
            return log.windowRange.startsWith(expectedStart);
          }
          if (targetBatch.model && log.model) {
            return log.model === targetBatch.model;
          }
          return true;
        });
        if (filtered.length > 0) visibleLogs = filtered;
      }
    }

    debugList.innerHTML = visibleLogs
      .map(
        (log) => `
      <div class="batch-card">
        <div class="batch-header">
          <div class="batch-info">
            <span class="timestamp">${esc(new Date(log.timestamp).toLocaleString())}</span>
            <span class="model-info">${esc(log.provider)} (${esc(log.model)})${log.windowRange ? ` · [${esc(log.windowRange)}]` : ''}</span>
            <span class="timestamp">Duration: ${esc(log.duration || 'N/A')}</span>
          </div>
          <span class="status-badge ${log.success ? '' : 'failed'}">
            ${log.success ? 'SUCCESS' : 'FAILED'}
          </span>
        </div>

        <div class="batch-details">
          <div class="section">
            <div class="section-title">
              INPUT (PROMPT)
              <button class="copy-btn">Copy</button>
            </div>
            <div class="code-block">${esc(log.input)}</div>
          </div>
          <div class="section">
            <div class="section-title">
              OUTPUT (RESPONSE)
              <button class="copy-btn">Copy</button>
            </div>
            <div class="code-block">${esc(log.output)}</div>
          </div>
        </div>

        <div class="section" style="margin-top: 16px;">
          <div class="section-title">System Prompt</div>
          <div class="code-block" style="max-height: 100px; font-size: 11px; opacity: 0.7;">${esc(log.systemPrompt)}</div>
        </div>
      </div>
    `
      )
      .join('');
  }

  async function refreshAll() {
    await loadInspector();
    await loadLogs();
  }

  if (inspectorEl) {
    inspectorEl.addEventListener('click', (e) => {
      const resetBtn = e.target.closest('[data-batch-reset]');
      if (resetBtn) {
        selectedBatchIndex = null;
        refreshAll();
        return;
      }
      const batchBtn = e.target.closest('[data-batch-index]');
      if (batchBtn) {
        const idx = Number(batchBtn.getAttribute('data-batch-index'));
        selectedBatchIndex = selectedBatchIndex === idx ? null : idx;
        refreshAll();
      }
    });
  }

  copyAllBtn.addEventListener('click', async () => {
    const data = await browser.storage.local.get('yousub_debug_history');
    const logs = data.yousub_debug_history || [];
    if (logs.length === 0) return;

    const text = formatAllLogs(logs);
    navigator.clipboard.writeText(text).then(() => {
      const orig = copyAllBtn.textContent;
      copyAllBtn.textContent = 'Copied!';
      copyAllBtn.style.backgroundColor = '#2dd4bf';
      copyAllBtn.style.color = '#0f172a';
      setTimeout(() => {
        copyAllBtn.textContent = orig;
        copyAllBtn.style.backgroundColor = '';
        copyAllBtn.style.color = '';
      }, 2000);
    });
  });

  debugList.addEventListener('click', (e) => {
    if (e.target.classList.contains('copy-btn')) {
      const btn = e.target;
      const block = btn.parentElement.nextElementSibling;
      const text = block.textContent;

      navigator.clipboard.writeText(text).then(() => {
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.backgroundColor = '#2dd4bf';
        btn.style.color = '#0f172a';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.backgroundColor = '';
          btn.style.color = '';
        }, 2000);
      });
    }
  });

  clearBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all debug logs?')) {
      await browser.storage.local.remove('yousub_debug_history');
      await PipelineTelemetry.clear();
      selectedBatchIndex = null;
      refreshAll();
    }
  });

  refreshBtn.addEventListener('click', refreshAll);

  if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes) => {
      const keys = Object.keys(changes || {});
      if (
        keys.includes('yousub_debug_history') ||
        keys.some((k) => k.startsWith(PIPELINE_KEY_PREFIX))
      ) {
        refreshAll();
      }
    });
  }

  await refreshAll();
});

function formatAllLogs(logs) {
  const lines = [
    '=== YouSub Batch Debug Log ===',
    `Exported: ${new Date().toISOString()}`,
    `Total entries: ${logs.length}`,
    '',
  ];

  logs.forEach((log, i) => {
    lines.push(`--- Entry ${i + 1}/${logs.length} ---`);
    lines.push(`Timestamp: ${log.timestamp}`);
    lines.push(
      `Provider: ${log.provider} | Model: ${log.model}${log.windowRange ? ` | Window: ${log.windowRange}` : ''}`
    );
    lines.push(
      `Status: ${log.success ? 'SUCCESS' : 'FAILED'} | Duration: ${log.duration || 'N/A'}`
    );
    lines.push('');
    lines.push('[INPUT]');
    lines.push(log.input || '');
    lines.push('');
    lines.push('[OUTPUT]');
    lines.push(log.output || '');
    lines.push('');
    lines.push('[SYSTEM PROMPT]');
    lines.push(log.systemPrompt || '');
    lines.push('');
  });

  return lines.join('\n');
}
