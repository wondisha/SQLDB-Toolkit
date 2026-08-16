const fs = require('fs');
const path = require('path');
const sql = require('mssql');
require('dotenv').config();

// ---- Load server registry -------------------------------------------------
// Prefer servers.json (multi-instance, e.g. an AG primary + secondaries, or
// every instance central-monitor/ would otherwise collect from). Falls back
// to a single instance defined via .env.

const SERVERS_JSON_PATH = path.join(__dirname, '..', 'servers.json');

function loadServerRegistry() {
  if (fs.existsSync(SERVERS_JSON_PATH)) {
    const raw = JSON.parse(fs.readFileSync(SERVERS_JSON_PATH, 'utf8'));
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('servers.json must contain a non-empty array of server configs.');
    }
    return raw;
  }

  if (!process.env.DB_SERVER) {
    throw new Error(
      'No server configuration found. Create backend/servers.json (see servers.example.json) ' +
      'or backend/.env (see .env.example) with at least one SQL Server target.'
    );
  }

  return [
    {
      id: process.env.DB_ID || 'default',
      label: process.env.DB_LABEL || process.env.DB_SERVER,
      server: process.env.DB_SERVER,
      port: Number(process.env.DB_PORT || 1433),
      database: process.env.DB_DATABASE || 'master',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      encrypt: String(process.env.DB_ENCRYPT || 'true') === 'true',
      trustServerCertificate: String(process.env.DB_TRUST_SERVER_CERTIFICATE || 'true') === 'true',
    },
  ];
}

const SERVERS = loadServerRegistry();
const SERVER_BY_ID = new Map(SERVERS.map((s) => [s.id, s]));

// Public, credential-free view of the registry for the frontend's server picker.
function listServersPublic() {
  return SERVERS.map(({ id, label, server, database }) => ({ id, label, server, defaultDatabase: database }));
}

// ---- Pool cache -------------------------------------------------------------
// One pool per (server id, database) pair, since several panels need to run
// in the context of a specific user database (e.g. DB_ID()-scoped DMVs).

const pools = new Map();

function poolKey(serverId, database) {
  return `${serverId}::${database || '__default__'}`;
}

async function getPool(serverId, database) {
  const cfg = SERVER_BY_ID.get(serverId);
  if (!cfg) {
    const err = new Error(`Unknown server id "${serverId}".`);
    err.status = 404;
    throw err;
  }

  const key = poolKey(serverId, database);
  const cached = pools.get(key);
  if (cached) {
    if (cached.connected || cached.connecting) return cached;
    pools.delete(key);
  }

  const pool = new sql.ConnectionPool({
    server: cfg.server,
    port: cfg.port || 1433,
    database: database || cfg.database || 'master',
    user: cfg.user,
    password: cfg.password,
    connectionTimeout: 8000,
    requestTimeout: 20000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: cfg.encrypt !== false,
      trustServerCertificate: cfg.trustServerCertificate !== false,
    },
  });

  pools.set(key, pool);
  await pool.connect();
  return pool;
}

async function runQuery(serverId, database, queryText) {
  const pool = await getPool(serverId, database);
  const request = pool.request();
  const started = Date.now();
  const result = await request.query(queryText);
  const elapsedMs = Date.now() - started;

  // Multi-statement scripts (e.g. the AG listener/routing check) return
  // multiple recordsets. Expose all of them; the frontend renders each as
  // its own table.
  const recordsets = Array.isArray(result.recordsets) ? result.recordsets : [result.recordset || []];
  return { recordsets, elapsedMs };
}

async function testServer(serverId) {
  const pool = await getPool(serverId, null);
  await pool.request().query('SELECT 1 AS ok');
  return true;
}

async function listDatabases(serverId) {
  const { recordsets } = await runQuery(
    serverId,
    null,
    `SELECT name, state_desc, recovery_model_desc
     FROM sys.databases
     WHERE database_id > 4
     ORDER BY name;`
  );
  return recordsets[0];
}

module.exports = {
  listServersPublic,
  getPool,
  runQuery,
  testServer,
  listDatabases,
};
