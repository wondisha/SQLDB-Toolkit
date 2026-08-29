// Point this at wherever backend/src/server.js is running.
const API_BASE = window.SQLDB_API_BASE || 'http://localhost:4000';

const state = {
  catalog: [],
  servers: [],
  databases: [],
  activeCategory: null,
  serverId: null,
  database: null,
  refreshSeconds: 15,
  timers: [],
  panelData: new Map() // Cache for instant CSV exports
};

const els = {
  sidebar: document.getElementById('sidebar'),
  content: document.getElementById('content'),
  serverSelect: document.getElementById('serverSelect'),
  databaseControl: document.getElementById('databaseControl'),
  databaseSelect: document.getElementById('databaseSelect'),
  refreshSelect: document.getElementById('refreshSelect'),
  refreshNowBtn: document.getElementById('refreshNowBtn'),
  connDot: document.getElementById('connDot'),
  connLabel: document.getElementById('connLabel'),
};

let currentChart = null;

// ---------------------------------------------------------------- helpers

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatCell(val) {
  if (val === null || val === undefined) return '<span class="cell-null">—</span>';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return Number.isInteger(val) ? val.toLocaleString() : val.toFixed(2);
  return escapeHtml(val);
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(`${API_BASE}${url}`, opts);
  if (!res.ok) {
    let errBody;
    try { errBody = await res.json(); } catch (_) {}
    throw new Error((errBody && errBody.error) || `HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function exportPanelToCsv(queryId, label) {
  const rows = state.panelData.get(queryId);
  if (!rows || rows.length === 0) {
    alert('No data available to export.');
    return;
  }
  const headers = Object.keys(rows[0]);
  const csvContent = [
    headers.join(','),
    ...rows.map(r => headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','))
  ].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_export.csv`;
  link.click();
}

// ---------------------------------------------------------------- bootstrap

async function init() {
  try {
    const [catalog, servers] = await Promise.all([
      fetchJSON('/api/catalog'),
      fetchJSON('/api/servers'),
    ]);
    state.catalog = catalog;
    state.servers = servers;

    if (servers.length === 0) {
      renderFatal('No servers configured in servers.csv.');
      return;
    }

    renderServerSelect();
    renderSidebar();

    state.serverId = servers[0].id;
    state.database = servers[0].database || servers[0].defaultDatabase || null;

    await onServerChanged();
    setActiveCategory(catalog[0].id);
    testConnection();
  } catch (err) {
    renderFatal(`Could not reach dashboard API at ${API_BASE}. (${err.message})`);
  }
}

function renderFatal(message) {
  els.content.innerHTML = `<div class="panel"><div class="panel-error">${escapeHtml(message)}</div></div>`;
  setConn(false, 'offline');
}

// ---------------------------------------------------------------- top controls

function renderServerSelect() {
  if (els.serverSelect.tagName === 'INPUT') {
    if (state.servers.length > 0 && !els.serverSelect.value) {
      els.serverSelect.value = state.servers[0].label || state.servers[0].name || state.servers[0].id;
      state.serverId = state.servers[0].id;
    }
  } else {
    els.serverSelect.innerHTML = state.servers
      .map((s) => `<option value="${s.id}">${escapeHtml(s.label || s.name || s.id)}</option>`)
      .join('');
    if (state.servers.length > 0) {
      state.serverId = state.servers[0].id;
      els.serverSelect.value = state.serverId;
    }
  }
}

if (els.serverSelect.tagName === 'INPUT') {
  els.serverSelect.addEventListener('input', async (e) => {
    state.serverId = e.target.value.trim();
    await onServerChanged();
    testConnection();
    renderActivePanels();
  });
} else {
  els.serverSelect.addEventListener('change', async () => {
    state.serverId = els.serverSelect.value;
    const srv = state.servers.find((s) => s.id === state.serverId);
    state.database = srv ? (srv.database || srv.defaultDatabase) : null;
    await onServerChanged();
    testConnection();
    renderActivePanels();
  });
}

els.databaseSelect.addEventListener('change', () => {
  state.database = els.databaseSelect.value;
  renderActivePanels();
});

els.refreshSelect.addEventListener('change', () => {
  state.refreshSeconds = Number(els.refreshSelect.value);
  renderActivePanels();
});

els.refreshNowBtn.addEventListener('click', () => renderActivePanels());

async function onServerChanged() {
  try {
    const dbs = await fetchJSON(`/api/servers/${state.serverId}/databases`);
    state.databases = dbs;
    els.databaseSelect.innerHTML = dbs
      .map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`)
      .join('');
    if (state.database && dbs.some((d) => d.name === state.database)) {
      els.databaseSelect.value = state.database;
    } else if (dbs.length) {
      state.database = dbs[0].name;
      els.databaseSelect.value = state.database;
    }
  } catch (err) {
    state.databases = [];
    els.databaseSelect.innerHTML = '<option value="">(unavailable)</option>';
  }
}

async function testConnection() {
  setConn(null, 'connecting…');
  try {
    await fetchJSON(`/api/servers/${state.serverId}/test`);
    setConn(true, `connected — ${state.serverId}`);
  } catch (err) {
    setConn(false, `connection failed: ${err.message}`);
  }
}

function setConn(ok, label) {
  els.connDot.className = 'conn-dot' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  els.connLabel.textContent = label;
}

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  els.sidebar.innerHTML = `
    <div class="nav-group-title">Categories</div>
    ${state.catalog
      .map(
        (cat) => `
      <div class="nav-item" data-cat="${cat.id}">
        <span class="nav-item-label">${escapeHtml(cat.label)}</span>
        <span class="nav-item-desc">${escapeHtml(cat.description)}</span>
      </div>`
      )
      .join('')}
  `;
  els.sidebar.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', () => setActiveCategory(el.dataset.cat));
  });
}

function setActiveCategory(catId) {
  state.activeCategory = catId;
  els.sidebar.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.cat === catId);
  });
  renderActivePanels();
}

// ---------------------------------------------------------------- panels

function clearTimers() {
  state.timers.forEach((t) => clearInterval(t));
  state.timers = [];
}

function renderActivePanels() {
  clearTimers();
  const cat = state.catalog.find((c) => c.id === state.activeCategory);
  if (!cat) return;

  els.databaseControl.style.display = 'flex';

  const chartSection = document.getElementById('chart-section');
  if (chartSection) chartSection.style.display = 'none';
  if (currentChart) {
    currentChart.destroy();
    currentChart = null;
  }

  els.content.innerHTML = `
    <section id="chart-section" style="display: none; margin-bottom: 24px;">
      <div style="max-width: 800px; height: 320px; background: rgba(255, 255, 255, 0.02); padding: 16px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.08);">
        <canvas id="queryChart"></canvas>
      </div>
    </section>
    <div class="content-header">
      <div class="content-title">${escapeHtml(cat.label)}</div>
      <div class="content-desc">${escapeHtml(cat.description)}</div>
    </div>
    <div id="panelStack"></div>
  `;
  const stack = document.getElementById('panelStack');

  if (!cat.queries || cat.queries.length === 0) {
    stack.innerHTML = '<div class="panel"><div class="panel-empty">No queries defined for this category yet.</div></div>';
    return;
  }

  cat.queries.forEach((q) => {
    const panelEl = document.createElement('div');
    panelEl.className = 'panel';
    panelEl.id = `panel-${q.id}`;
    panelEl.innerHTML = panelShell(q);
    stack.appendChild(panelEl);

    const run = () => loadPanel(cat.id, q, panelEl);
    run();

    if (state.refreshSeconds > 0) {
      const timer = setInterval(run, state.refreshSeconds * 1000);
      state.timers.push(timer);
    }

    const runBtn = panelEl.querySelector('[data-action="run"]');
    const exportBtn = panelEl.querySelector('[data-action="export"]');
    if (runBtn) runBtn.addEventListener('click', run);
    if (exportBtn) exportBtn.addEventListener('click', () => exportPanelToCsv(q.id, q.label));
  });
}

function panelShell(q) {
  return `
    <div class="panel-header">
      <div class="panel-heading">
        <span class="panel-eyebrow">${escapeHtml(q.script || '')}</span>
        <span class="panel-title">${escapeHtml(q.label)}</span>
      </div>
      <div class="panel-meta">
        ${q.requiresPermission ? `<span class="perm-badge">${escapeHtml(q.requiresPermission)}</span>` : ''}
        <span class="elapsed" data-role="elapsed"></span>
        <button class="panel-run-btn" data-action="export" type="button" title="Export as CSV">export csv</button>
        <button class="panel-run-btn" data-action="run" type="button">run</button>
      </div>
    </div>
    <div class="scope-hint">targeting database: <strong>${escapeHtml(state.database || '(none selected)')}</strong></div>
    <div class="panel-body" data-role="body">
      <div class="panel-loading">loading…</div>
    </div>
  `;
}

async function loadPanel(categoryId, q, panelEl) {
  const bodyEl = panelEl.querySelector('[data-role="body"]');
  const elapsedEl = panelEl.querySelector('[data-role="elapsed"]');

  if (!state.database) {
    bodyEl.innerHTML = '<div class="panel-empty">Select a database above to run this panel.</div>';
    return;
  }

  const params = new URLSearchParams({ server: state.serverId, database: state.database });

  try {
    const data = await fetchJSON(`/api/query/${categoryId}/${q.id}?${params.toString()}`);
    elapsedEl.textContent = `${data.elapsedMs || 0} ms`;
    bodyEl.innerHTML = '';

    const firstRows = data.recordsets && data.recordsets[0] ? data.recordsets[0] : (data.rows || []);
    state.panelData.set(q.id, firstRows);

    if (q.chartConfig && firstRows.length > 0 && typeof Chart !== 'undefined') {
      renderChart(firstRows, q.chartConfig);
    }

    if (data.recordsets) {
      data.recordsets.forEach((rs) => bodyEl.appendChild(renderRecordset(q, rs)));
    } else if (data.rows) {
      bodyEl.appendChild(renderRecordset(q, data.rows));
    }

    const totalRows = data.recordsets ? data.recordsets.reduce((acc, rs) => acc + rs.length, 0) : (data.rows ? data.rows.length : 0);
    if (totalRows === 0) {
      bodyEl.innerHTML = '<div class="panel-empty">No rows returned — nothing to report right now.</div>';
    }
  } catch (err) {
    bodyEl.innerHTML = `<div class="panel-error">${escapeHtml(err.message)}</div>`;
    elapsedEl.textContent = '';
  }
}

// ---------------------------------------------------------------- Chart.js integration

function renderChart(data, chartConfig) {
  const chartSection = document.getElementById('chart-section');
  const canvas = document.getElementById('queryChart');
  if (!chartSection || !canvas) return;

  if (!chartConfig || !data || data.length === 0) {
    chartSection.style.display = 'none';
    if (currentChart) {
      currentChart.destroy();
      currentChart = null;
    }
    return;
  }

  chartSection.style.display = 'block';

  if (currentChart) {
    currentChart.destroy();
  }

  const ctx = canvas.getContext('2d');
  const xAxisKey = chartConfig.xAxisKey || chartConfig.nameKey;
  const yAxisKey = chartConfig.yAxisKey || chartConfig.dataKey;

  const labels = data.map((item) => item[xAxisKey] ?? 'N/A');
  const values = data.map((item) => item[yAxisKey] ?? 0);

  const defaultColors = [
    '#3182ce', '#dd6b20', '#38a169', '#e53e3e', '#805ad5',
    '#d69e2e', '#319795', '#b83280', '#4a5568', '#00b5d8'
  ];

  const isPie = chartConfig.type === 'pie';

  currentChart = new Chart(ctx, {
    type: isPie ? 'pie' : 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: chartConfig.label || 'Value',
        data: values,
        backgroundColor: isPie ? defaultColors : '#3182ce',
        borderColor: isPie ? '#1a202c' : '#2b6cb0',
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: isPie, position: 'bottom' }
      },
      scales: isPie ? {} : { y: { beginAtZero: true } }
    }
  });
}

// ---------------------------------------------------------------- rendering: recordsets

const STATUS_COLUMNS = new Set([
  'status', 'role_desc', 'connected_state_desc', 'recovery_health_desc',
  'synchronization_health_desc', 'synchronization_state_desc', 'database_state_desc',
  'failover_readiness', 'recommendation', 'db_sync_health', 'state_desc',
  'backup_health', 'volume_health', 'vlf_health', 'evaluation', 'cache_health'
]);

function badgeClassFor(col, value) {
  const v = String(value || '').toUpperCase();
  if (['READY', 'HEALTHY', 'CONNECTED', 'ONLINE', 'SYNCHRONIZED', 'OK'].some((s) => v.includes(s))) return 'badge-ok';
  if (['NOT_READY', 'DISCONNECTED', 'NOT_SYNCHRONIZING', 'CRITICAL', 'SUSPECT', 'RECOVERY_PENDING'].some((s) => v.includes(s))) return 'badge-crit';
  if (['PARTIALLY_HEALTHY', 'REVERTING', 'CONSIDERUPDATE', 'INITIALIZING', 'RESTORING', 'WARNING'].some((s) => v.includes(s))) return 'badge-warn';
  if (v === 'RUNNING' || v === 'SUSPENDED' || v === 'SLEEPING' || v.includes('METRIC')) return 'badge-info';
  return 'badge-neutral';
}

function renderRecordset(queryConfig, rows) {
  if (!rows || rows.length === 0) {
    return document.createElement('div');
  }
  return renderTable(rows, queryConfig.actions);
}

function renderTable(rows, actions) {
  const cols = Object.keys(rows[0] || {}).filter((c) => {
    const key = c.toUpperCase();
    return !key.includes('SQL_ACTION') && 
           !key.includes('CREATE_INDEX_DDL') && 
           !key.includes('REMEDIATION_SQL') &&
           key !== 'PLAN_ID' &&
           !key.endsWith('_DDL') &&
           !key.endsWith('_SQL');
  });

  const wrap = document.createElement('div');
  const table = document.createElement('table');
  table.className = 'data-table';

  const hasExecutableAction = actions && actions.length > 0 && rows.some((row) => {
    return actions.some((action) => {
      if (action.isDownload) return Boolean(row.plan_id || row.PLAN_ID);

      const isAutoShrink = (action.label || '').toLowerCase().includes('auto-shrink');
      const shrinkVal = String(row.IS_AUTO_SHRINK_ON || row.is_auto_shrink_on || '').toLowerCase();
      if (isAutoShrink && (shrinkVal === 'false' || shrinkVal === '0')) return false;

      let fixVal = null;
      if (action.paramKeys) {
        const targetKey = action.paramKeys['sql'] || action.paramKeys['SQL'] || action.paramKeys['spid'] || action.paramKeys['SPID'];
        if (targetKey) {
          fixVal = row[targetKey] || row[targetKey.toLowerCase()] || row[targetKey.toUpperCase()];
        }
      } else {
        fixVal = true;
      }

      return fixVal !== null && fixVal !== undefined && fixVal !== '' && fixVal !== '—';
    });
  });

  const thead = document.createElement('thead');
  let headHtml = `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}`;
  if (hasExecutableAction) headHtml += '<th>Actions</th>';
  headHtml += '</tr>';
  thead.innerHTML = headHtml;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    
    let rowHtml = cols
      .map((c) => {
        const val = row[c];
        if (STATUS_COLUMNS.has(c.toLowerCase()) && val !== null && val !== undefined && val !== '') {
          return `<td><span class="badge ${badgeClassFor(c, val)}">${escapeHtml(val)}</span></td>`;
        }

        if (c.toLowerCase() === 'pct_total_wait' || c.toLowerCase() === 'frag_pct' || c.toLowerCase() === 'avg_fragmentation_in_percent') {
          const pct = Number(val) || 0;
          return `<td class="num">
            <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
              <div style="width:70px;background:rgba(255,255,255,0.08);height:6px;border-radius:3px;overflow:hidden;">
                <div style="width:${Math.min(pct, 100)}%;background:var(--accent-primary);height:100%;"></div>
              </div>
              <span>${pct.toFixed(2)}%</span>
            </div>
          </td>`;
        }

        const isNum = typeof val === 'number';
        return `<td class="${isNum ? 'num' : ''}">${formatCell(val)}</td>`;
      })
      .join('');

    tr.innerHTML = rowHtml;

    if (hasExecutableAction) {
      const actionTd = document.createElement('td');
      actionTd.className = 'action-cell';

      actions.forEach((action) => {
        let shouldRender = false;

        if (action.isDownload) {
          shouldRender = Boolean(row.plan_id || row.PLAN_ID);
        } else {
          const isAutoShrink = (action.label || '').toLowerCase().includes('auto-shrink');
          const shrinkVal = String(row.IS_AUTO_SHRINK_ON || row.is_auto_shrink_on || '').toLowerCase();
          if (isAutoShrink && (shrinkVal === 'false' || shrinkVal === '0')) return;

          let fixVal = null;
          if (action.paramKeys) {
            const targetKey = action.paramKeys['sql'] || action.paramKeys['SQL'] || action.paramKeys['spid'] || action.paramKeys['SPID'];
            if (targetKey) {
              fixVal = row[targetKey] || row[targetKey.toLowerCase()] || row[targetKey.toUpperCase()];
            }
          } else {
            fixVal = true;
          }
          shouldRender = (fixVal !== null && fixVal !== undefined && fixVal !== '' && fixVal !== '—');
        }

        if (shouldRender) {
          const btn = document.createElement('button');
          btn.textContent = action.label;
          btn.className = `btn btn-${action.variant || 'primary'}`;
          btn.addEventListener('click', () => handleActionClick(action, row));
          actionTd.appendChild(btn);
        }
      });

      tr.appendChild(actionTd);
    }

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

async function handleActionClick(action, row) {
  if (action.isDownload && action.endpoint.includes('download-plan')) {
    const planId = row.plan_id || row.PLAN_ID;
    const queryId = row.query_id || row.QUERY_ID;
    try {
      const res = await fetch(`${API_BASE}${action.endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: state.serverId, database: state.database, plan_id: planId })
      });
      const data = await res.json();
      if (data.planXml) {
        const blob = new Blob([data.planXml], { type: 'application/xml' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `Query_${queryId}_Plan_${planId}.sqlplan`;
        link.click();
      } else {
        alert(data.error || 'Execution plan not available in Query Store.');
      }
    } catch (e) {
      alert('Failed to download execution plan: ' + e.message);
    }
    return;
  }

  let promptMsg = action.confirmPrompt || 'Are you sure you want to execute this action?';
  Object.keys(row).forEach((key) => {
    promptMsg = promptMsg.replace(new RegExp(`\\{${key}\\}`, 'gi'), row[key] ?? '');
  });

  if (!confirm(promptMsg)) return;

  try {
    const payload = { server: state.serverId, database: state.database };
    if (action.paramKeys) {
      Object.keys(action.paramKeys).forEach((p) => {
        const rowCol = action.paramKeys[p];
        payload[p] = row[rowCol] ?? row[rowCol.toLowerCase()] ?? row[rowCol.toUpperCase()];
      });
    }

    const res = await fetchJSON(action.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    alert(res.message || 'Action executed successfully.');
    renderActivePanels();
  } catch (err) {
    alert(`Action failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------- run on load
init();