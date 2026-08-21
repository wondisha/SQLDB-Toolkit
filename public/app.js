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
  databaseUnavailableReason: '',
  lastHealthCheckAt: null,
  lastSuccessfulRefreshAt: null,
};

const els = {
  sidebar: document.getElementById('sidebar'),
  content: document.getElementById('content'),
  serverSelect: document.getElementById('serverSelect'),
  databaseControl: document.getElementById('databaseControl'),
  databaseSelect: document.getElementById('databaseSelect'),
  databaseHint: document.getElementById('databaseHint'),
  refreshSelect: document.getElementById('refreshSelect'),
  refreshNowBtn: document.getElementById('refreshNowBtn'),
  connDot: document.getElementById('connDot'),
  connLabel: document.getElementById('connLabel'),
  connMeta: document.getElementById('connMeta'),
};

let currentChart = null;
const DB_ERROR_DISPLAY = {
  AUTH_FAILED: 'Authentication failed. Check DB_USER/DB_PASSWORD.',
  DB_UNREACHABLE: 'Database server unreachable. Check DB_SERVER/port/service.',
  TIMEOUT: 'Connection timed out. Verify network/firewall and retry.',
};

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
      renderFatal('No servers configured.');
      return;
    }

    renderServerSelect();
    renderSidebar();

    state.serverId = servers[0].id;
    state.database = servers[0].database || servers[0].defaultDatabase || null;

    await onServerChanged();
    await testConnection();
    setActiveCategory(catalog[0].id);
  } catch (err) {
    renderFatal(`Could not reach dashboard API at ${API_BASE}. (${err.message})`);
  }
}

function renderFatal(message) {
  els.content.innerHTML = `<div class="panel"><div class="panel-error">${escapeHtml(message)}</div></div>`;
  setConn(false, 'Dashboard API unavailable.');
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
    await testConnection();
    renderActivePanels();
  });
} else {
  els.serverSelect.addEventListener('change', async () => {
    state.serverId = els.serverSelect.value;
    const srv = state.servers.find((s) => s.id === state.serverId);
    state.database = srv ? (srv.database || srv.defaultDatabase) : null;
    await onServerChanged();
    await testConnection();
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

els.refreshNowBtn.addEventListener('click', async () => {
  await onServerChanged();
  await testConnection();
  renderActivePanels();
});

async function onServerChanged() {
  try {
    const dbs = await fetchJSON(`/api/servers/${state.serverId}/databases`);
    state.databases = dbs;
    state.databaseUnavailableReason = '';
    if (!state.database || !dbs.some((d) => d.name === state.database)) {
      state.database = dbs.length ? dbs[0].name : null;
    }
  } catch (err) {
    state.databases = [];
    state.databaseUnavailableReason = getDbErrorDisplay(err);
  }

  renderDatabaseSelect();
}

async function testConnection() {
  setConn(null, 'Checking database connection…');
  try {
    const health = await fetchJSON('/api/health/db');
    state.lastHealthCheckAt = health.checkedAt || new Date().toISOString();
    markLastSuccessfulRefresh(health.checkedAt);
    setConn(true, `Connected to ${health.server}/${health.database}`);
  } catch (err) {
    state.lastHealthCheckAt = err.checkedAt || new Date().toISOString();
    setConn(false, getDbErrorDisplay(err), err.code);
  }
}

function renderDatabaseSelect() {
  els.databaseSelect.disabled = state.databases.length === 0;

  if (state.databases.length > 0) {
    els.databaseSelect.innerHTML = state.databases
      .map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`)
      .join('');
    if (state.database) {
      els.databaseSelect.value = state.database;
    }
    els.databaseSelect.title = '';
    els.databaseHint.textContent = '';
    return;
  }

  const optionValue = state.database || '';
  const optionLabel = state.database ? `${state.database} (last selected)` : '(unavailable)';
  els.databaseSelect.innerHTML = `<option value="${escapeHtml(optionValue)}">${escapeHtml(optionLabel)}</option>`;
  els.databaseSelect.value = optionValue;
  els.databaseSelect.title = state.databaseUnavailableReason || 'Database list unavailable.';
  els.databaseHint.textContent = state.databaseUnavailableReason || 'Database list unavailable.';
}

function markLastSuccessfulRefresh(value) {
  state.lastSuccessfulRefreshAt = value || new Date().toISOString();
}

function setConn(ok, label, code) {
  els.connDot.className = 'conn-dot' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  els.connLabel.textContent = label;
  const meta = [];
  if (code) meta.push(code);
  if (state.lastHealthCheckAt) meta.push(`checked ${formatTimestamp(state.lastHealthCheckAt)}`);
  if (state.lastSuccessfulRefreshAt) meta.push(`last successful refresh ${formatTimestamp(state.lastSuccessfulRefreshAt)}`);
  els.connMeta.textContent = meta.join(' · ');
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

    panelEl.querySelector('.panel-run-btn').addEventListener('click', run);
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
        <button class="panel-run-btn" type="button">run</button>
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
    markLastSuccessfulRefresh();
    elapsedEl.textContent = `${data.elapsedMs || 0} ms`;
    bodyEl.innerHTML = '';

    const firstRows = data.recordsets && data.recordsets[0] ? data.recordsets[0] : [];

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
]);

function badgeClassFor(col, value) {
  const v = String(value || '').toUpperCase();
  if (['READY', 'HEALTHY', 'CONNECTED', 'ONLINE', 'SYNCHRONIZED', 'OK'].some((s) => v.includes(s))) return 'badge-ok';
  if (['NOT_READY', 'DISCONNECTED', 'NOT_SYNCHRONIZING', 'CRITICAL', 'SUSPECT', 'RECOVERY_PENDING'].some((s) => v.includes(s))) return 'badge-crit';
  if (['PARTIALLY_HEALTHY', 'REVERTING', 'CONSIDERUPDATE', 'INITIALIZING', 'RESTORING'].some((s) => v.includes(s))) return 'badge-warn';
  if (v === 'RUNNING' || v === 'SUSPENDED' || v === 'SLEEPING') return 'badge-info';
  return 'badge-neutral';
}

function renderRecordset(queryConfig, rows) {
  if (!rows || rows.length === 0) {
    return document.createElement('div');
  }

  const queryId = queryConfig.id;
  if (queryId === 'wait-profile' || queryId === 'wait-stats-snapshot') {
    return renderWaitBars(rows);
  }
  if (queryId === 'active-blockers' || queryId === 'current-blocking-chains') {
    return renderBlockingTree(rows);
  }
  return renderTable(rows, queryConfig.actions);
}

function renderTable(rows, actions) {
  const cols = Object.keys(rows[0] || {});
  const wrap = document.createElement('div');
  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  let headHtml = `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}`;
  if (actions && actions.length > 0) headHtml += '<th>Actions</th>';
  headHtml += '</tr>';
  thead.innerHTML = headHtml;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    
    let rowHtml = cols
      .map((c) => {
        const val = row[c];
        if (STATUS_COLUMNS.has(c) && val !== null && val !== undefined && val !== '') {
          return `<td><span class="badge ${badgeClassFor(c, val)}">${escapeHtml(val)}</span></td>`;
        }
        const isNum = typeof val === 'number';
        return `<td class="${isNum ? 'num' : ''}">${formatCell(val)}</td>`;
      })
      .join('');

    tr.innerHTML = rowHtml;

    if (actions && actions.length > 0) {
      const actionTd = document.createElement('td');
      actionTd.className = 'action-cell';

      actions.forEach((action) => {
        const paramKey = action.paramKeys ? action.paramKeys['sql'] : null;
        const fixValue = paramKey ? row[paramKey] : true;

        if (fixValue !== null && fixValue !== undefined && fixValue !== '' && fixValue !== '—') {
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
  let promptMsg = action.confirmPrompt || 'Are you sure you want to execute this action?';

  Object.keys(row).forEach((key) => {
    promptMsg = promptMsg.replace(new RegExp(`\\{${key}\\}`, 'g'), row[key]);
  });

  if (!confirm(promptMsg)) return;

  const payload = { server: state.serverId };
  if (state.database) payload.database = state.database;

  if (action.paramKeys) {
    Object.entries(action.paramKeys).forEach(([param, rowKey]) => {
      payload[param] = row[rowKey];
    });
  }

  try {
    const result = await fetchJSON(action.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    markLastSuccessfulRefresh();
    alert(result.message || 'Action executed successfully.');
    renderActivePanels();
  } catch (err) {
    alert('Action failed: ' + getDbErrorDisplay(err));
  }
}

function formatCell(val) {
  if (val === null || val === undefined) return '<span style="color:var(--text-faint)">—</span>';
  if (val instanceof Object && val.toISOString) return escapeHtml(new Date(val).toLocaleString());
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
    const d = new Date(val);
    return escapeHtml(isNaN(d) ? val : d.toLocaleString());
  }
  return escapeHtml(String(val));
}

function waitColor(waitType) {
  const t = (waitType || '').toUpperCase();
  if (t.startsWith('LCK_') || t.includes('LATCH')) return 'var(--accent-crit)';
  if (t.startsWith('PAGEIOLATCH') || t.startsWith('IO_') || t.startsWith('WRITELOG') || t.startsWith('ASYNC_IO')) return 'var(--accent-info)';
  if (t.startsWith('CXPACKET') || t.startsWith('SOS_SCHEDULER') || t.startsWith('THREADPOOL')) return 'var(--accent-warn)';
  return 'var(--accent-ok)';
}

function renderWaitBars(rows) {
  const max = Math.max(...rows.map((r) => Number(r.pct_total_wait) || 0), 1);
  const wrap = document.createElement('div');
  wrap.className = 'waitbar-list';
  rows.forEach((r) => {
    const pct = Number(r.pct_total_wait) || 0;
    const widthPct = Math.max((pct / max) * 100, 2);
    const row = document.createElement('div');
    row.className = 'waitbar-row';
    row.innerHTML = `
      <span class="waitbar-type" title="${escapeHtml(r.wait_type)}">${escapeHtml(r.wait_type)}</span>
      <span class="waitbar-track"><span class="waitbar-fill" style="width:${widthPct}%;background:${waitColor(r.wait_type)}"></span></span>
      <span class="waitbar-pct">${pct.toFixed(1)}%</span>
    `;
    wrap.appendChild(row);
  });
  return wrap;
}

function renderBlockingTree(rows) {
  const bySession = new Map(rows.map((r) => [r.session_id, r]));
  const childrenOf = new Map();
  rows.forEach((r) => {
    if (r.blocking_session_id) {
      if (!childrenOf.has(r.blocking_session_id)) childrenOf.set(r.blocking_session_id, []);
      childrenOf.get(r.blocking_session_id).push(r);
    }
  });

  const roots = rows.filter((r) => (!r.blocking_session_id || r.blocking_session_id === 0) && childrenOf.has(r.session_id));
  const rootIds = new Set(roots.map((r) => r.session_id));
  const orphanBlockers = [...childrenOf.keys()].filter((sid) => !rootIds.has(sid) && !bySession.has(sid));

  const wrap = document.createElement('div');
  wrap.className = 'blocktree';

  function nodeHtml(r, isRoot) {
    const meta = [
      r.database_name ? `db: ${r.database_name}` : null,
      r.wait_type ? `wait: ${r.wait_type}` : null,
      r.status ? `status: ${r.status}` : null,
      r.login_name ? `login: ${r.login_name}` : null,
    ].filter(Boolean).join(' · ');
    return `<div class="blocktree-node">
      <span class="sid">${isRoot ? '⛔' : '↳'} SPID ${escapeHtml(r.session_id)}</span>
      <span class="meta">${escapeHtml(meta)}</span>
    </div>`;
  }

  function renderChain(r, isRoot) {
    const container = document.createElement('div');
    container.innerHTML = nodeHtml(r, isRoot);
    const kids = childrenOf.get(r.session_id) || [];
    kids.forEach((k) => {
      const childWrap = document.createElement('div');
      childWrap.className = 'blocktree-child';
      childWrap.appendChild(renderChain(k, false));
      container.appendChild(childWrap);
    });
    return container;
  }

  if (roots.length === 0 && orphanBlockers.length === 0) {
    wrap.innerHTML = '<div class="panel-empty">No active blocking right now.</div>';
    return wrap;
  }

  roots.forEach((r) => {
    const rootEl = document.createElement('div');
    rootEl.className = 'blocktree-root';
    rootEl.appendChild(renderChain(r, true));
    wrap.appendChild(rootEl);
  });

  orphanBlockers.forEach((sid) => {
    const rootEl = document.createElement('div');
    rootEl.className = 'blocktree-root';
    const container = document.createElement('div');
    container.innerHTML = `<div class="blocktree-node"><span class="sid">⛔ SPID ${escapeHtml(sid)}</span><span class="meta">not currently running a request</span></div>`;
    (childrenOf.get(sid) || []).forEach((k) => {
      const childWrap = document.createElement('div');
      childWrap.className = 'blocktree-child';
      childWrap.appendChild(renderChain(k, false));
      container.appendChild(childWrap);
    });
    rootEl.appendChild(container);
    wrap.appendChild(rootEl);
  });

  return wrap;
}

// ---------------------------------------------------------------- utils

async function fetchJSON(path, options) {
  const res = await fetch(`${API_BASE}${path}`, options);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    if (body && (body.message || body.error)) msg = body.message || body.error;
    const err = new Error(msg);
    err.code = body && body.code ? body.code : null;
    err.checkedAt = body && body.checkedAt ? body.checkedAt : null;
    err.traceId = body && body.traceId ? body.traceId : null;
    err.details = body && body.details ? body.details : null;
    throw err;
  }
  if (!body) {
    throw new Error('Invalid server response.');
  }
  return body;
}

function getDbErrorDisplay(err) {
  return DB_ERROR_DISPLAY[err && err.code] || err.message || 'Database request failed. Review server logs and retry.';
}

function formatTimestamp(value) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

init();