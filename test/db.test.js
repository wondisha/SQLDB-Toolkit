const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyDbError, getDbConfig } = require('../src/lib/db');

test('classifyDbError normalizes auth failures', () => {
    const err = new Error("Login failed for user 'sa'.");
    err.number = 18456;

    assert.deepEqual(classifyDbError(err), {
        code: 'AUTH_FAILED',
        message: 'Authentication failed. Check DB_USER/DB_PASSWORD.'
    });
});

test('classifyDbError normalizes unreachable servers', () => {
    const err = new Error('Failed to connect to localhost');
    err.code = 'ESOCKET';

    assert.deepEqual(classifyDbError(err), {
        code: 'DB_UNREACHABLE',
        message: 'Database server unreachable. Check DB_SERVER/port/service.'
    });
});

test('classifyDbError normalizes timeouts', () => {
    const err = new Error('Connection timeout expired');
    err.code = 'ETIMEOUT';

    assert.deepEqual(classifyDbError(err), {
        code: 'TIMEOUT',
        message: 'Connection timed out. Verify network/firewall and retry.'
    });
});

test('classifyDbError falls back to unknown database errors', () => {
    const err = new Error('Something unexpected happened');

    assert.deepEqual(classifyDbError(err), {
        code: 'UNKNOWN_DB_ERROR',
        message: 'Database request failed. Review server logs and retry.'
    });
});

test('getDbConfig reads connection pool settings from env', () => {
    const config = getDbConfig({
        DB_SERVER: 'localhost',
        DB_NAME: 'master',
        DB_POOL_MAX_SIZE: '25',
        DB_POOL_MIN_SIZE: '2',
        DB_POOL_IDLE_TIMEOUT_MS: '45000'
    });

    assert.equal(config.pool.max, 25);
    assert.equal(config.pool.min, 2);
    assert.equal(config.pool.idleTimeoutMillis, 45000);
});
