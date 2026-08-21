const test = require('node:test');
const assert = require('node:assert/strict');

const baseDb = require('../src/lib/db');
const { createApp } = require('../src/server');

const logger = {
    error() {}
};

async function startApp(dbOverrides = {}) {
    const db = {
        ...baseDb,
        getDbConfig: () => ({
            server: 'localhost',
            database: 'master'
        }),
        getConnectionInfo: () => ({
            server: 'localhost',
            database: 'master'
        }),
        ...dbOverrides
    };

    const app = createApp({ db, logger });

    return new Promise((resolve) => {
        const server = app.listen(0, () => resolve(server));
    });
}

async function fetchJson(server, route) {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    return {
        status: response.status,
        body: await response.json()
    };
}

test('GET /api/health/db returns success payload shape', async (t) => {
    const server = await startApp({
        runQuery: async () => ({ recordset: [{ status: 1 }] })
    });
    t.after(() => server.close());

    const { status, body } = await fetchJson(server, '/api/health/db');

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.server, 'localhost');
    assert.equal(body.database, 'master');
    assert.equal(typeof body.checkedAt, 'string');
    assert.equal(typeof body.latencyMs, 'number');
});

test('GET /api/health/db returns normalized failure payload shape', async (t) => {
    const server = await startApp({
        runQuery: async () => {
            const err = new Error("Login failed for user 'sa'.");
            err.number = 18456;
            throw err;
        }
    });
    t.after(() => server.close());

    const { status, body } = await fetchJson(server, '/api/health/db');

    assert.equal(status, 500);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'AUTH_FAILED');
    assert.equal(body.message, 'Authentication failed. Check DB_USER/DB_PASSWORD.');
    assert.equal(typeof body.checkedAt, 'string');
    assert.deepEqual(body.details, {
        server: 'localhost',
        database: 'master'
    });
    assert.equal(typeof body.traceId, 'string');
});
