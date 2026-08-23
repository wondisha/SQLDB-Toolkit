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

test('cacheable query responses are reused until bypassed', async (t) => {
    let calls = 0;
    const server = await startApp({
        withRequest: async (operation) => {
            calls += 1;
            return operation({
                query: async () => ({
                    recordset: [{ table_name: 'Orders', avg_fragmentation_in_percent: 42 }]
                })
            });
        }
    });
    t.after(() => server.close());

    const first = await fetchJson(server, '/api/query/index-maintenance/index-fragmentation?database=master');
    const second = await fetchJson(server, '/api/query/index-maintenance/index-fragmentation?database=master');
    const third = await fetchJson(server, '/api/query/index-maintenance/index-fragmentation?database=master&refresh=1');

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 200);
    assert.equal(first.body.cache.status, 'MISS');
    assert.equal(second.body.cache.status, 'HIT');
    assert.equal(third.body.cache.status, 'BYPASS');
    assert.equal(calls, 2);
});
