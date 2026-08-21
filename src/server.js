const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const defaultDb = require('./lib/db');
require('dotenv').config();

const auditLogPath = path.join(process.cwd(), 'audit_log.json');

// Helper to read audit log
function getAuditLogs() {
    try {
        if (fs.existsSync(auditLogPath)) {
            const data = fs.readFileSync(auditLogPath, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {}
    return [];
}

// Helper to write audit log
function logAuditEvent(actionName, targetDb, details) {
    const logs = getAuditLogs();
    logs.unshift({
        timestamp: new Date().toISOString(),
        action: actionName,
        database: targetDb || 'Instance-Wide',
        details: details || 'Executed via Dashboard Console'
    });
    try {
        fs.writeFileSync(auditLogPath, JSON.stringify(logs, null, 2));
    } catch (e) {}
}

function createTraceId() {
    return crypto.randomUUID();
}

function sendDbError(res, logger, db, err, context, options = {}) {
    const normalized = db.createNormalizedDbError
        ? db.createNormalizedDbError(err)
        : err;
    const traceId = createTraceId();
    const rawError = normalized && normalized.cause ? normalized.cause : err;

    logger.error(`[${traceId}] ${context}`, rawError);

    const body = {
        ok: false,
        code: normalized.code || 'UNKNOWN_DB_ERROR',
        message: normalized.message || 'Database request failed.',
        traceId,
        ...options.body
    };

    return res.status(options.status || 500).json(body);
}

function createApp({ db = defaultDb, logger = console } = {}) {
    const app = express();
    const dbConfig = db.getDbConfig();

    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(process.cwd(), 'public')));

// ==========================================
// CONFIGURATION & CATALOG ENDPOINTS
// ==========================================
app.get('/api/servers', (req, res) => {
    res.json([
        {
            id: dbConfig.server,
            name: dbConfig.server,
            database: dbConfig.database
        }
    ]);
});

app.get('/api/servers/:serverId/databases', async (req, res) => {
    try {
        const result = await db.runQuery("SELECT name FROM sys.databases WHERE state_desc = 'ONLINE'");
        res.json(result.recordset);
    } catch (err) {
        sendDbError(res, logger, db, err, 'Failed to load database list');
    }
});

app.get('/api/servers/:serverId/test', async (req, res) => {
    try {
        await db.runQuery('SELECT 1 AS status');
        res.json({ ok: true, success: true });
    } catch (err) {
        sendDbError(res, logger, db, err, 'Failed to test database connection');
    }
});

app.get('/api/catalog', (req, res) => {
    res.json([
        {
            id: "health-check",
            label: "Health Check",
            description: "Daily DBA/developer query pack — waits, blocking, backups, jobs, tempdb.",
            queries: [
                {
                    id: "server-uptime",
                    label: "SQL Server Uptime & Version",
                    script: "Health Telemetry",
                    description: "Checks underlying engine version and last startup time."
                },
                {
                    id: "backup-history",
                    label: "Database Backup RPO History",
                    script: "Backup Compliance",
                    description: "Tracks the last successful full backup timestamp for disaster recovery."
                }
            ]
        },
        {
            id: "performance",
            label: "Performance",
            description: "Plan-cache workload analysis, Query Store insights, missing indexes, and execution plans.",
            queries: [
                {
                    id: "query-store-insights",
                    label: "Query Store Top CPU Consumers",
                    script: "Query Store Telemetry",
                    description: "Analyzes active Query Store runtime stats for high CPU usage queries.",
                    actions: [
                        {
                            label: "Enable Query Store",
                            variant: "primary",
                            endpoint: "/api/actions/enable-querystore",
                            confirmPrompt: "Enable Query Store on database {database}?",
                            paramKeys: { database: "database_name" }
                        }
                    ]
                }
            ]
        },
        {
            id: "index-maintenance",
            label: "Index Maintenance",
            description: "Index health, physical fragmentation, and REORGANIZE/REBUILD recommendations.",
            queries: [
                {
                    id: "index-fragmentation",
                    label: "High Fragmentation Indexes",
                    script: "Index Health",
                    description: "Scans physical fragmentation levels across database indexes."
                }
            ]
        },
        {
            id: "blocking-deadlocks",
            label: "Blocking & Deadlocks",
            description: "Real-time blocking chains and wait statistics.",
            queries: [
                {
                    id: "active-blockers",
                    label: "Active Blocking Sessions",
                    script: "Blocking Chains",
                    description: "Identifies active sessions currently blocking other worker requests."
                },
                {
                    id: "long-running-transactions",
                    label: "Active Long-Running Transactions",
                    script: "Transaction Monitor",
                    description: "Tracks open transactions holding locks for extended durations."
                }
            ]
        },
        {
            id: "ag-health",
            label: "AG Health",
            description: "Always On Availability Group replica and sync status checks.",
            queries: [
                {
                    id: "ag-replica-states",
                    label: "Availability Group Replica Status",
                    script: "AG Health",
                    description: "Monitors synchronization and connectivity state of Availability Group replicas."
                }
            ]
        },
        {
            id: "security-audit",
            label: "Security & Audit",
            description: "Login and user SID mismatches with remediation.",
            queries: [
                {
                    id: "orphan-users",
                    label: "Orphaned Database Users",
                    script: "Security Audit",
                    description: "Finds database users that no longer map cleanly to a server login."
                }
            ]
        },
        {
            id: "best-practices",
            label: "Best Practices & Compliance",
            description: "Audits instance and database configurations against Microsoft recommended baselines.",
            queries: [
                {
                    id: "db-configurations",
                    label: "Database Configuration Baselines",
                    script: "Compliance Audit",
                    description: "Audits Auto-Close, Auto-Shrink, Page Verify, and Statistics settings.",
                    actions: [
                        {
                            label: "Disable Auto-Shrink",
                            variant: "warning",
                            endpoint: "/api/actions/disable-autoshrink",
                            confirmPrompt: "Disable AUTO_SHRINK on database {name}?",
                            paramKeys: { database: "name" }
                        }
                    ]
                },
                {
                    id: "compatibility-level",
                    label: "Database Compatibility Level",
                    script: "Version Audit",
                    description: "Audits current database compatibility target versus engine version."
                },
                {
                    id: "isolation-levels",
                    label: "Database Isolation Level Settings",
                    script: "Concurrency Audit",
                    description: "Checks Read Committed Snapshot and Snapshot Isolation options."
                },
                {
                    id: "file-growth-config",
                    label: "Detailed File Growth & Autogrowth Config",
                    script: "Storage Audit",
                    description: "Audits file properties, sizes, max sizes, and growth configurations."
                },
                {
                    id: "tempdb-config",
                    label: "TempDB Configuration & File Sizing",
                    script: "TempDB Baseline",
                    description: "Audits TempDB file counts and equal sizing allocation compliance."
                }
            ]
        },
        {
            id: "remediation-audit-log",
            label: "Remediation Audit Log",
            description: "Permanent log of all DDL and configuration changes executed through the console.",
            queries: [
                {
                    id: "audit-history",
                    label: "Console Action Log",
                    script: "Audit Log",
                    description: "Tracks executed configuration actions and remediation changes."
                }
            ]
        }
    ]);
});

// ==========================================
// HEALTH CHECK ENDPOINT
// ==========================================
app.get('/api/health', async (req, res) => {
    try {
        const result = await db.runQuery('SELECT @@VERSION AS sql_version');
        res.json({ ok: true, success: true, version: result.recordset[0].sql_version });
    } catch (err) {
        sendDbError(res, logger, db, err, 'Failed to load SQL Server health');
    }
});

app.get('/api/health/db', async (req, res) => {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();

    try {
        await db.runQuery('SELECT 1 AS status');
        const connection = db.getConnectionInfo(dbConfig);
        res.json({
            ok: true,
            server: connection.server,
            database: connection.database,
            checkedAt,
            latencyMs: Date.now() - startedAt
        });
    } catch (err) {
        const connection = db.getConnectionInfo(dbConfig);
        sendDbError(res, logger, db, err, 'Failed database health check', {
            body: {
                checkedAt,
                details: connection
            }
        });
    }
});

// ==========================================
// REMEDIATION ACTION ENDPOINTS
// ==========================================
app.post('/api/actions/enable-querystore', async (req, res) => {
    const targetDb = req.body.database || dbConfig.database;
    try {
        await db.runQuery(`ALTER DATABASE ${db.escapeSqlIdentifier(targetDb)} SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE);`);
        logAuditEvent('ENABLE_QUERY_STORE', targetDb, 'Enabled Query Store successfully via dashboard action.');
        res.json({ ok: true, success: true, message: `Query Store successfully enabled on ${targetDb}.` });
    } catch (err) {
        sendDbError(res, logger, db, err, 'Failed to enable Query Store');
    }
});

app.post('/api/actions/disable-autoshrink', async (req, res) => {
    const targetDb = req.body.database || dbConfig.database;
    try {
        await db.runQuery(`ALTER DATABASE ${db.escapeSqlIdentifier(targetDb)} SET AUTO_SHRINK OFF;`);
        logAuditEvent('DISABLE_AUTO_SHRINK', targetDb, 'Disabled AUTO_SHRINK successfully via dashboard action.');
        res.json({ ok: true, success: true, message: `AUTO_SHRINK disabled on ${targetDb}.` });
    } catch (err) {
        sendDbError(res, logger, db, err, 'Failed to disable AUTO_SHRINK');
    }
});

// ==========================================
// DIRECT QUERY STORE ENDPOINT
// ==========================================
app.get('/api/performance/querystore', async (req, res) => {
    try {
        const targetDb = req.query.database || dbConfig.database;
        const targetDbLiteral = db.escapeSqlLiteral(targetDb);
        const result = await db.runQuery(`
            SELECT TOP 20
                q.query_id,
                qt.query_sql_text AS query_text,
                SUM(rs.count_executions) AS total_executions,
                SUM(rs.avg_cpu_time * rs.count_executions) / 1000.0 AS total_cpu_ms,
                (SUM(rs.avg_cpu_time * rs.count_executions) / SUM(rs.count_executions)) / 1000.0 AS avg_cpu_ms,
                MAX(rs.max_cpu_time) / 1000.0 AS max_cpu_ms,
                SUM(rs.avg_logical_io_reads * rs.count_executions) AS total_logical_reads,
                ${targetDbLiteral} AS database_name
            FROM sys.query_store_query_text AS qt
            JOIN sys.query_store_query AS q ON qt.query_text_id = q.query_text_id
            JOIN sys.query_store_plan AS p ON q.query_id = p.query_id
            JOIN sys.query_store_runtime_stats AS rs ON p.plan_id = rs.plan_id
            GROUP BY q.query_id, qt.query_sql_text
            ORDER BY total_cpu_ms DESC;
        `, { database: targetDb });

        res.json({ ok: true, success: true, data: result.recordset });
    } catch (err) {
        sendDbError(res, logger, db, err, 'Failed to load Query Store insights');
    }
});

// ==========================================
// DYNAMIC PANEL QUERY RUNNER (Used by app.js)
// ==========================================
app.get('/api/query/:categoryId/:queryId', async (req, res) => {
    const { categoryId, queryId } = req.params;
    const targetDb = req.query.database || dbConfig.database;
    const targetDbLiteral = db.escapeSqlLiteral(targetDb);
    const startTime = Date.now();

    try {
        let recordset = [];

        if (categoryId === 'performance' && (queryId === 'query-store-insights' || queryId === 'querystore')) {
            const r = await db.runQuery(`
                SELECT TOP 20
                    q.query_id,
                    qt.query_sql_text AS query_text,
                    SUM(rs.count_executions) AS total_executions,
                    SUM(rs.avg_cpu_time * rs.count_executions) / 1000.0 AS total_cpu_ms,
                    (SUM(rs.avg_cpu_time * rs.count_executions) / SUM(rs.count_executions)) / 1000.0 AS avg_cpu_ms,
                    MAX(rs.max_cpu_time) / 1000.0 AS max_cpu_ms,
                    SUM(rs.avg_logical_io_reads * rs.count_executions) AS total_logical_reads,
                    ${targetDbLiteral} AS database_name
                FROM sys.query_store_query_text AS qt
                JOIN sys.query_store_query AS q ON qt.query_text_id = q.query_text_id
                JOIN sys.query_store_plan AS p ON q.query_id = p.query_id
                JOIN sys.query_store_runtime_stats AS rs ON p.plan_id = rs.plan_id
                GROUP BY q.query_id, qt.query_sql_text
                ORDER BY total_cpu_ms DESC;
            `, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'health-check' && queryId === 'server-uptime') {
            const r = await db.runQuery(`SELECT sqlserver_start_time, @@VERSION AS version FROM sys.dm_os_sys_info;`, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'health-check' && queryId === 'backup-history') {
            const r = await db.runQuery(`
                SELECT 
                    d.name AS database_name,
                    MAX(b.backup_finish_date) AS last_backup_date,
                    DATEDIFF(hour, MAX(b.backup_finish_date), GETDATE()) AS hours_since_last_backup,
                    CASE 
                        WHEN MAX(b.backup_finish_date) IS NULL THEN 'CRITICAL: Never Backed Up'
                        WHEN DATEDIFF(hour, MAX(b.backup_finish_date), GETDATE()) > 24 THEN 'WARNING: Backup older than 24 hours'
                        ELSE 'OK: Recent Backup Found'
                    END AS backup_health
                FROM sys.databases d
                LEFT JOIN msdb.dbo.backupset b ON d.name = b.database_name AND b.type = 'D'
                WHERE d.state_desc = 'ONLINE' AND d.name <> 'tempdb' AND d.name = ${targetDbLiteral}
                GROUP BY d.name;
            `, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'index-maintenance' && queryId === 'index-fragmentation') {
            const r = await db.runQuery(`
                SELECT TOP 25
                    OBJECT_NAME(ips.object_id) AS table_name,
                    i.name AS index_name,
                    ips.avg_fragmentation_in_percent,
                    ips.page_count
                FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ips
                JOIN sys.indexes i ON ips.object_id = i.object_id AND ips.index_id = i.index_id
                WHERE ips.avg_fragmentation_in_percent > 10 AND ips.page_count > 50
                ORDER BY ips.avg_fragmentation_in_percent DESC;
            `, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'blocking-deadlocks' && queryId === 'active-blockers') {
            const r = await db.runQuery(`
                SELECT 
                    session_id, blocking_session_id, wait_type, wait_time, status, cpu_time
                FROM sys.dm_exec_requests
                WHERE blocking_session_id <> 0;
            `, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'blocking-deadlocks' && queryId === 'long-running-transactions') {
            const r = await db.runQuery(`
                SELECT 
                    s.session_id,
                    s.login_name,
                    t.transaction_begin_time,
                    DATEDIFF(second, t.transaction_begin_time, GETDATE()) AS duration_seconds,
                    db_name(dt.database_id) AS database_name
                FROM sys.dm_tran_active_transactions t
                JOIN sys.dm_tran_session_transactions st ON t.transaction_id = st.transaction_id
                JOIN sys.dm_exec_sessions s ON st.session_id = s.session_id
                JOIN sys.dm_tran_database_transactions dt ON t.transaction_id = dt.transaction_id
                WHERE db_name(dt.database_id) = ${targetDbLiteral};
            `, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'ag-health' && queryId === 'ag-replica-states') {
            const r = await db.runQuery(`
                SELECT 
                    ar.replica_server_name, ars.role_desc, ars.operational_state_desc, ars.synchronization_health_desc
                FROM sys.dm_hadr_availability_replica_states ars
                JOIN sys.availability_replicas ar ON ars.replica_id = ar.replica_id;
            `, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'security-audit' && queryId === 'orphan-users') {
            const r = await db.runQuery(`SELECT name, principal_id, type_desc FROM sys.database_principals WHERE type IN ('S', 'U', 'G') AND sid NOT IN (SELECT sid FROM sys.server_principals);`, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'best-practices' && queryId === 'db-configurations') {
            const r = await db.runQuery(`
                SELECT 
                    name,
                    recovery_model_desc,
                    page_verify_option_desc,
                    is_auto_close_on,
                    is_auto_shrink_on,
                    is_auto_create_stats_on,
                    is_auto_update_stats_on,
                    target_recovery_time_in_seconds,
                    CASE 
                        WHEN is_auto_close_on = 1 THEN 'CRITICAL: Disable AUTO_CLOSE'
                        WHEN is_auto_shrink_on = 1 THEN 'CRITICAL: Disable AUTO_SHRINK'
                        WHEN page_verify_option_desc <> 'CHECKSUM' THEN 'WARNING: Set Page Verify to CHECKSUM'
                        WHEN is_auto_create_stats_on = 0 THEN 'WARNING: Enable AUTO_CREATE_STATISTICS'
                        WHEN is_auto_update_stats_on = 0 THEN 'WARNING: Enable AUTO_UPDATE_STATISTICS'
                        ELSE 'HEALTHY: Follows MS Baselines'
                    END AS recommendation
                FROM sys.databases 
                WHERE name = ${targetDbLiteral};
            `, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'best-practices' && queryId === 'compatibility-level') {
            const r = await db.runQuery(`
                SELECT 
                    name,
                    compatibility_level,
                    CASE compatibility_level
                        WHEN 160 THEN 'SQL Server 2022 (v16.0)'
                        WHEN 150 THEN 'SQL Server 2019 (v15.0)'
                        WHEN 140 THEN 'SQL Server 2017 (v14.0)'
                        WHEN 130 THEN 'SQL Server 2016 (v13.0)'
                        ELSE 'Legacy Compatibility Level'
                    END AS engine_target_version,
                    is_read_committed_snapshot_on,
                    snapshot_isolation_state_desc
                FROM sys.databases 
                WHERE name = ${targetDbLiteral};
            `, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'best-practices' && queryId === 'isolation-levels') {
            const r = await db.runQuery(`
                SELECT 
                    name AS database_name,
                    is_read_committed_snapshot_on AS rcsi_enabled,
                    snapshot_isolation_state_desc,
                    CASE 
                        WHEN is_read_committed_snapshot_on = 1 THEN 'RECOMMENDED: RCSI is Enabled (Reduces blocking)'
                        ELSE 'INFO: RCSI is Disabled (Standard locking behavior)'
                    END AS concurrency_recommendation
                FROM sys.databases 
                WHERE name = ${targetDbLiteral};
            `, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'best-practices' && queryId === 'file-growth-config') {
            const r = await db.runQuery(`
                SELECT 
                    f.name AS logical_file_name,
                    f.type_desc AS file_type,
                    CAST(f.size * 8.0 / 1024 AS DECIMAL(10,2)) AS current_size_mb,
                    CASE f.max_size 
                        WHEN -1 THEN 'Unrestricted' 
                        WHEN 0 THEN 'No Growth' 
                        ELSE CAST(CAST(f.max_size * 8.0 / 1024 AS DECIMAL(10,2)) AS VARCHAR(20)) + ' MB' 
                    END AS max_size_limit,
                    CASE 
                        WHEN f.is_percent_growth = 1 THEN CAST(f.growth AS VARCHAR(10)) + '%'
                        ELSE CAST(CAST(f.growth * 8.0 / 1024 AS DECIMAL(10,2)) AS VARCHAR(10)) + ' MB'
                    END AS growth_increment,
                    CASE 
                        WHEN f.is_percent_growth = 1 THEN 'CRITICAL: Change percent growth to fixed MB increments'
                        WHEN f.growth = 0 THEN 'WARNING: Autogrowth is disabled'
                        ELSE 'HEALTHY: Fixed MB growth'
                    END AS storage_recommendation,
                    f.physical_name
                FROM sys.database_files f;
            `, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'best-practices' && queryId === 'tempdb-config') {
            const r = await db.runQuery(`
                SELECT 
                    f.name AS tempdb_file,
                    f.type_desc,
                    CAST(f.size * 8.0 / 1024 AS DECIMAL(10,2)) AS size_mb,
                    CASE 
                        WHEN f.is_percent_growth = 1 THEN CAST(f.growth AS VARCHAR(10)) + '%'
                        ELSE CAST(CAST(f.growth * 8.0 / 1024 AS DECIMAL(10,2)) AS VARCHAR(10)) + ' MB'
                    END AS growth_setting
                FROM sys.master_files f
                WHERE f.database_id = DB_ID('tempdb');
            `, { database: targetDb });
            recordset = r.recordset;
        } else if (categoryId === 'remediation-audit-log' && queryId === 'audit-history') {
            recordset = getAuditLogs();
            if (recordset.length === 0) {
                recordset = [{ status: 'No remediation actions logged to audit_log.json yet.' }];
            }
        } else {
            throw new Error(`Unknown or unhandled query definition: ${categoryId}/${queryId}`);
        }

        const elapsedMs = Date.now() - startTime;

        res.json({
            ok: true,
            success: true,
            elapsedMs,
            recordsets: [recordset]
        });
    } catch (err) {
        sendDbError(res, logger, db, err, `Failed to run query ${categoryId}/${queryId}`);
    }
});

    return app;
}

function startServer(options = {}) {
    const app = createApp(options);
    const port = options.port || process.env.PORT || 4000;

    return app.listen(port, () => {
        console.log(`SQLDB Toolkit backend running on port ${port}`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = {
    createApp,
    getAuditLogs,
    logAuditEvent,
    startServer
};