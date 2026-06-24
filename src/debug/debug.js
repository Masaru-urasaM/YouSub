document.addEventListener('DOMContentLoaded', async () => {
  const debugList = document.getElementById('debug-list');
  const clearBtn = document.getElementById('clear-debug-btn');
  const refreshBtn = document.getElementById('refresh-debug-btn');

  async function loadLogs() {
    const data = await browser.storage.local.get('yousub_debug_history');
    const logs = data.yousub_debug_history || [];

    if (logs.length === 0) {
      debugList.innerHTML =
        '<div class="empty-state">No batches recorded yet. Start a translation to see data here.</div>';
      return;
    }

    debugList.innerHTML = logs
      .map(
        (log) => `
      <div class="batch-card">
        <div class="batch-header">
          <div class="batch-info">
            <span class="timestamp">${new Date(log.timestamp).toLocaleString()}</span>
            <span class="model-info">${log.provider} (${log.model})</span>
            <span class="timestamp">Duration: ${log.duration || 'N/A'}</span>
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
            <div class="code-block">${escapeHtml(log.input)}</div>
          </div>
          <div class="section">
            <div class="section-title">
              OUTPUT (RESPONSE)
              <button class="copy-btn">Copy</button>
            </div>
            <div class="code-block">${escapeHtml(log.output)}</div>
          </div>
        </div>
        
        <div class="section" style="margin-top: 16px;">
          <div class="section-title">System Prompt</div>
          <div class="code-block" style="max-height: 100px; font-size: 11px; opacity: 0.7;">${escapeHtml(log.systemPrompt)}</div>
        </div>
      </div>
    `
      )
      .join('');
  }

  // Copy All button
  const copyAllBtn = document.getElementById('copy-all-btn');
  copyAllBtn.addEventListener('click', async () => {
    const data = await browser.storage.local.get('yousub_debug_history');
    const logs = data.yousub_debug_history || [];
    if (logs.length === 0) return;

    const text = formatAllLogs(logs);
    navigator.clipboard.writeText(text).then(() => {
      const orig = copyAllBtn.textContent;
      copyAllBtn.textContent = 'Copied!';
      copyAllBtn.style.backgroundColor = '#10b981';
      setTimeout(() => {
        copyAllBtn.textContent = orig;
        copyAllBtn.style.backgroundColor = '';
      }, 2000);
    });
  });

  // Event Delegation for Copy Buttons
  debugList.addEventListener('click', (e) => {
    if (e.target.classList.contains('copy-btn')) {
      const btn = e.target;
      const block = btn.parentElement.nextElementSibling;
      const text = block.textContent;

      navigator.clipboard.writeText(text).then(() => {
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.backgroundColor = '#10b981';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.backgroundColor = '';
        }, 2000);
      });
    }
  });

  clearBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all debug logs?')) {
      await browser.storage.local.remove('yousub_debug_history');
      loadLogs();
    }
  });

  refreshBtn.addEventListener('click', loadLogs);

  // Initial load
  loadLogs();
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
    lines.push(`Provider: ${log.provider} | Model: ${log.model}`);
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

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
