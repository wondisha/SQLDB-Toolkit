require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { CATEGORIES, findQuery } = require('./queries');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));
app.use(express.json());

// ---- Catalog: what panels exist, without running anything -----------------
app.get('/api/catalog', (req, res) => {
  const catalog = Object.entries(CATEGORIES).map(([id, cat]) => ({
    id,
    label: cat.label,
    description: cat.description,
    queries: cat.queries.map((q) => ({
      id: q.id,
      label: q.label,
      script: q.script,
      scope: q.scope,
      requiresPermission: q.requiresPermission || null,
      refreshSeconds: q.refreshSeconds || 60,
    })),
  }));
  res.json(catalog);
});

// ---- Servers ----------------------------------------------------------------
app.get('/api/servers', (req, res) => {
  res.json(db.listServersPublic());
});

app.get('/api/servers/:serverId/test', async (req, res) => {
  try {
    await db.testServer(req.params.serverId);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message });
  }
});

app.get('/api/servers/:serverId/databases', async (req, res) => {
  try {
    const rows = await db.listDatabases(req.params.serverId);
    res.json(rows);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// ---- Run a panel query -------------------------------------------------------
app.get('/api/query/:categoryId/:queryId', async (req, res) => {
  const { categoryId, queryId } = req.params;
  const { server: serverId, database } = req.query;

  if (!serverId) {
    return res.status(400).json({ error: 'Missing required "server" query parameter.' });
  }

  const found = findQuery(categoryId, queryId);
  if (!found) {
    return res.status(404).json({ error: `Unknown query ${categoryId}/${queryId}.` });
  }
  const { query } = found;

  if (query.scope === 'database' && !database) {
    return res.status(400).json({
      error: `"${query.label}" runs in the context of a specific database. Pass ?database=<name>.`,
    });
  }

  try {
    const { recordsets, elapsedMs } = await db.runQuery(serverId, database, query.sql);
    res.json({
      queryId,
      categoryId,
      label: query.label,
      script: query.script,
      elapsedMs,
      recordsets: recordsets.map((rs) => ({
        rowCount: rs.length,
        rows: rs,
      })),
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, script: query.script });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, servers: db.listServersPublic().length }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`SQLDB dashboard API listening on http://localhost:${PORT}`);
  console.log(`Registered servers: ${db.listServersPublic().map((s) => s.id).join(', ')}`);
});
