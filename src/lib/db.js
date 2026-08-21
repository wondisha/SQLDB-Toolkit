const sql = require('mssql');

const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

const poolPromises = new Map();

function readTimeout(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDbConfig(env = process.env) {
    return {
        server: env.DB_SERVER || 'localhost',
        database: env.DB_NAME || env.DB_DATABASE || 'AdventureWorksLT',
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        connectionTimeout: readTimeout(env.DB_CONNECTION_TIMEOUT_MS, DEFAULT_CONNECTION_TIMEOUT_MS),
        requestTimeout: readTimeout(env.DB_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
        options: {
            encrypt: env.DB_ENCRYPT === 'true',
            trustServerCertificate: env.DB_TRUST_SERVER_CERTIFICATE !== 'false'
        }
    };
}

function getConnectionInfo(config = getDbConfig()) {
    return {
        server: config.server,
        database: config.database
    };
}

function getPoolCacheKey(config) {
    return JSON.stringify({
        server: config.server,
        database: config.database,
        user: config.user,
        password: config.password,
        encrypt: config.options && config.options.encrypt,
        trustServerCertificate: config.options && config.options.trustServerCertificate
    });
}

function buildDbConfig(overrides = {}) {
    const baseConfig = getDbConfig();
    return {
        ...baseConfig,
        ...overrides,
        options: {
            ...baseConfig.options,
            ...(overrides.options || {})
        }
    };
}

async function getPool(overrides = {}) {
    const config = buildDbConfig(overrides);
    const cacheKey = getPoolCacheKey(config);

    if (!poolPromises.has(cacheKey)) {
        const pool = new sql.ConnectionPool(config);
        const connectionPromise = pool.connect().catch((err) => {
            poolPromises.delete(cacheKey);
            throw err;
        });

        poolPromises.set(cacheKey, connectionPromise);
    }

    return poolPromises.get(cacheKey);
}

async function closePool() {
    if (poolPromises.size === 0) {
        return;
    }

    const activePools = Array.from(poolPromises.values());
    poolPromises.clear();

    await Promise.all(activePools.map(async (activePool) => {
        try {
            const pool = await activePool;
            await pool.close();
        } catch (_) {}
    }));
}

function classifyDbError(err) {
    const message = String(err && err.message ? err.message : '').toLowerCase();
    const rawCode = err && err.code ? String(err.code).toUpperCase() : '';
    const rawName = err && err.name ? String(err.name).toUpperCase() : '';
    const number = err && err.number;

    if (number === 18456 || message.includes('login failed') || message.includes('authentication failed')) {
        return {
            code: 'AUTH_FAILED',
            message: 'Authentication failed. Check DB_USER/DB_PASSWORD.'
        };
    }

    if (
        rawCode === 'ETIMEOUT' ||
        rawName === 'TIMEOUTERROR' ||
        message.includes('timed out') ||
        message.includes('timeout')
    ) {
        return {
            code: 'TIMEOUT',
            message: 'Connection timed out. Verify network/firewall and retry.'
        };
    }

    if (
        ['ESOCKET', 'EINSTLOOKUP', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(rawCode) ||
        message.includes('failed to connect') ||
        message.includes('could not connect') ||
        message.includes('connection refused') ||
        message.includes('server was not found') ||
        message.includes('unreachable')
    ) {
        return {
            code: 'DB_UNREACHABLE',
            message: 'Database server unreachable. Check DB_SERVER/port/service.'
        };
    }

    return {
        code: 'UNKNOWN_DB_ERROR',
        message: 'Database request failed. Review server logs and retry.'
    };
}

function createNormalizedDbError(err) {
    if (err && err.isNormalizedDbError) {
        return err;
    }

    const normalized = classifyDbError(err);
    const wrapped = new Error(normalized.message);
    wrapped.code = normalized.code;
    wrapped.isNormalizedDbError = true;
    wrapped.cause = err;
    return wrapped;
}

async function runDbOperation(operation, options = {}) {
    try {
        const pool = await getPool(options.database ? { database: options.database } : {});
        return await operation(pool);
    } catch (err) {
        throw createNormalizedDbError(err);
    }
}

function escapeSqlIdentifier(value) {
    return `[${String(value || '').replace(/]/g, ']]')}]`;
}

async function withRequest(operation, options = {}) {
    return runDbOperation((pool) => {
        const request = pool.request();

        Object.entries(options.inputs || {}).forEach(([name, value]) => {
            request.input(name, value);
        });

        return operation(request);
    }, options);
}

module.exports = {
    DEFAULT_CONNECTION_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    classifyDbError,
    closePool,
    createNormalizedDbError,
    escapeSqlIdentifier,
    getConnectionInfo,
    getDbConfig,
    getPool,
    runDbOperation,
    withRequest
};
