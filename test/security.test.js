const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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

test('static assets are served with browser cache headers', async (t) => {
    const server = await startApp({
        withRequest: async (operation) => operation({
            query: async () => ({ recordset: [{ status: 1 }] })
        })
    });
    t.after(() => server.close());

    const builtIndex = fs.readFileSync(
        path.join(process.cwd(), 'dist', 'index.html'),
        'utf8'
    );
    const assetPath = builtIndex.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${assetPath}`);

    assert.ok(assetPath);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') || '', /max-age=300/);
});

test('API rate limiting returns a normalized error payload', async (t) => {
    const originalWindow = process.env.RATE_LIMIT_WINDOW_MS;
    const originalMax = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    process.env.RATE_LIMIT_MAX = '1';

    const server = await startApp({
        withRequest: async (operation) => operation({
            query: async () => ({ recordset: [{ sql_version: 'SQL Server' }] })
        })
    });

    t.after(() => {
        server.close();
        if (originalWindow === undefined) {
            delete process.env.RATE_LIMIT_WINDOW_MS;
        } else {
            process.env.RATE_LIMIT_WINDOW_MS = originalWindow;
        }
        if (originalMax === undefined) {
            delete process.env.RATE_LIMIT_MAX;
        } else {
            process.env.RATE_LIMIT_MAX = originalMax;
        }
    });

    const { port } = server.address();
    const first = await fetch(`http://127.0.0.1:${port}/api/health`);
    const second = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await second.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(body.code, 'RATE_LIMITED');
    assert.equal(body.ok, false);
});
