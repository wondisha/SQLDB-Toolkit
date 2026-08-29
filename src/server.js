const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------- static folder auto-resolution
const frontendPath = [
    path.join(__dirname, '../public'),
    path.join(process.cwd(), 'public'),
    path.join(__dirname, '../../frontend'),
    path.join(process.cwd(), 'frontend'),
    path.join(__dirname, '../frontend')
].find(p => fs.existsSync(path.join(p, 'index.html'))) || path.join(process.cwd(), 'public');

console.log(`Serving static UI from: ${frontendPath}`);
app.use(express.static(frontendPath));

const auditLogPath = path.join(process.cwd(), 'audit_log.json');
const csvConfigPath = path.join(process.cwd(), 'servers.csv');
const jsonConfigPath = path.join(process.cwd(), 'servers.json');

// ---------------------------------------------------------------- helpers & security utilities

function quoteIdentifier(identifier) {
    if (!identifier || typeof identifier !== 'string') {
        throw new Error('Invalid database identifier.');
    }
    return `[${identifier.replace(/]/g, ']]')}]`;
}

async function getAuditLogs() {
    try {
        const data = await fsPromises.readFile(auditLogPath, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

async function logAuditEvent(actionName, targetDb, details) {
    try {
        const logs = await getAuditLogs();
        logs.unshift({
            timestamp: new Date().toISOString(),
            action: actionName,
            database: targetDb || 'Instance-Wide',
            details: details || 'Executed via Dashboard Console'
        });
        await fsPromises.writeFile(auditLogPath, JSON.stringify(logs.slice(0, 1000), null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to persist audit log:', err.message);
    }
}

function parseCsvServers(content) {
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1) return [];

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    return lines.slice(1).map(line => {
        const values = line.split(',').map(v => v.trim());
        const entry = {};
        headers.forEach((h, idx) => {
            entry[h] = values[idx] || '';
        });
        return {
            id: entry.id || entry.server || 'unnamed',
            name: entry.name || entry.id || entry.server,
            server: entry.server || 'localhost',
            database: entry.database || 'master',
            user: entry.user || process.env.DB_USER,
            password: entry.password || process.env.DB_PASSWORD,
            encrypt: String(entry.encrypt).toLowerCase() === 'true'
        };
    });
}

function getServersList() {
    try {
        if (fs.existsSync(csvConfigPath)) {
            const data = fs.readFileSync(csvConfigPath, 'utf8');
            const parsed = parseCsvServers(data);
            if (parsed.length > 0) return parsed;
        }
    } catch (e) {
        console.error('Error reading servers.csv:', e.message);
    }

    try {
        if (fs.existsSync(jsonConfigPath)) {
            const data = fs.readFileSync(jsonConfigPath, 'utf8');
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (e) {}

    return [
        {
            id: process.env.DB_SERVER || 'localhost',
            name: process.env.DB_SERVER || 'localhost',
            server: process.env.DB_SERVER || 'localhost',
            database: process.env.DB_NAME || 'master',
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            encrypt: process.env.DB_ENCRYPT === 'true' || false
        }
    ];
}

// ---------------------------------------------------------------- connection pool registry
const connectionPools = new Map();

async function getPool(serverId) {
    const servers = getServersList();
    const srv = servers.find(s => s.id === serverId) || servers[0];
    const key = srv.id;

    let pool = connectionPools.get(key);

    if (pool && pool.connected) {
        return pool;
    }

    if (pool) {
        try {
            await pool.close();
        } catch (_) {}
    }

    const config = {
        server: srv.server || srv.id,
        database: srv.database || 'master',
        user: srv.user || process.env.DB_USER,
        password: srv.password || process.env.DB_PASSWORD,
        options: {
            encrypt: srv.encrypt ?? (process.env.DB_ENCRYPT === 'true'),
            trustServerCertificate: true,
            connectTimeout: 10000,
            requestTimeout: 45000
        },
        pool: {
            max: 10,
            min: 1,
            idleTimeoutMillis: 30000
        }
    };

    pool = new sql.ConnectionPool(config);
    await pool.connect();
    connectionPools.set(key, pool);
    return pool;
}

// ==========================================
// CONFIGURATION & CATALOG ENDPOINTS
// ==========================================
app.get('/api/servers', (req, res) => {
    const list = getServersList().map(s => ({
        id: s.id,
        name: s.name || s.id,
        database: s.database || 'master'
    }));
    res.json(list);
});

app.get('/api/servers/:serverId/databases', async (req, res) => {
    try {
        const pool = await getPool(req.params.serverId);
        const result = await pool.request().query("SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name;");
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/servers/:serverId/test', async (req, res) => {
    try {
        const pool = await getPool(req.params.serverId);
        await pool.request().query('SELECT 1 AS status');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/catalog', (req, res) => {
    res.json([
        {
            id: "health-check",
            label: "Health Check",
            description: "Daily DBA/developer query pack — waits, storage, backups, agent jobs, and instance health.",
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
                },
                {
                    id: "agent-job-failures",
                    label: "SQL Server Agent Job Failures (Last 24h)",
                    script: "Job Monitoring",
                    description: "Audits failed SQL Agent jobs and step execution messages across the instance."
                },
                {
                    id: "drive-space",
                    label: "Host Storage Volume Capacity",
                    script: "Disk Utilization",
                    description: "Monitors free storage capacity across all mounted database drive volumes."
                }
            ]
        },
        {
            id: "performance",
            label: "Performance & Memory",
            description: "Workload telemetry, wait profiles, Query Store metrics, buffer pool health, and plan cache bloat.",
            queries: [
                {
                    id: "wait-stats-summary",
                    label: "Top 15 Wait Statistics Profile",
                    script: "Wait Telemetry",
                    description: "Surfaces active resource bottlenecks (CPU, Disk I/O, Lock Contention, Network)."
                },
                {
                    id: "query-store-waits",
                    label: "Query Store Top Wait Statistics (24h)",
                    script: "Query Store Waits",
                    description: "Aggregates top wait categories and impact across all Query Store queries.",
                    chartConfig: {
                        type: "bar",
                        nameKey: "wait_category_desc",
                        dataKey: "total_wait_ms",
                        label: "Total Wait Time (ms)"
                    }
                },
                {
                    id: "memory-buffer-health",
                    label: "Buffer Pool & PLE Memory Health",
                    script: "Memory Subsystem",
                    description: "Audits Page Life Expectancy and memory workspace grant pressure."
                },
                {
                    id: "plan-cache-bloat",
                    label: "Plan Cache Size & Ad-Hoc Bloat",
                    script: "Cache Telemetry",
                    description: "Measures single-use cached plans polluting instance memory."
                },
                {
                    id: "query-store-insights",
                    label: "Query Store Top CPU Consumers",
                    script: "Query Store Telemetry",
                    description: "Analyzes active Query Store runtime stats for high CPU usage queries.",
                    actions: [
                        {
                            label: "Download .sqlplan",
                            variant: "primary",
                            endpoint: "/api/actions/download-plan",
                            isDownload: true,
                            paramKeys: { plan_id: "plan_id", query_id: "query_id" }
                        }
                    ]
                }
            ]
        },
        {
            id: "index-maintenance",
            label: "Index Maintenance",
            description: "Index health, missing index suggestions, and physical fragmentation remediation.",
            queries: [
                {
                    id: "missing-indexes",
                    label: "Missing Index Recommendations",
                    script: "Performance Tuning",
                    description: "High-impact index recommendations surfaced by SQL Server query optimizer with auto-generated DDL.",
                    actions: [
                        {
                            label: "Create Index",
                            variant: "primary",
                            endpoint: "/api/actions/execute-ddl",
                            confirmPrompt: "Execute CREATE INDEX DDL on {database_name}?",
                            paramKeys: { database: "database_name", sql: "CREATE_INDEX_DDL" }
                        }
                    ]
                },
                {
                    id: "index-fragmentation",
                    label: "High Fragmentation Indexes (>10%)",
                    script: "Index Health",
                    description: "Scans physical fragmentation levels across database indexes with Rebuild/Reorganize actions.",
                    actions: [
                        {
                            label: "Rebuild / Reorg Index",
                            variant: "warning",
                            endpoint: "/api/actions/execute-ddl",
                            confirmPrompt: "Execute index maintenance on {table_name} ([{index_name}]) in {database_name}?\n\nCommand: {REMEDIATION_SQL}",
                            paramKeys: { database: "database_name", sql: "REMEDIATION_SQL" }
                        }
                    ]
                }
            ]
        },
        {
            id: "blocking-deadlocks",
            label: "Blocking & Deadlocks",
            description: "Real-time active workload, blocking chains, and session termination controls.",
            queries: [
                {
                    id: "active-blockers",
                    label: "Active Blocking Sessions",
                    script: "Blocking Chains",
                    description: "Identifies active sessions currently blocking other worker requests.",
                    actions: [
                        {
                            label: "Kill SPID",
                            variant: "danger",
                            endpoint: "/api/actions/kill-session",
                            confirmPrompt: "WARNING: Terminate blocking session SPID {blocking_session_id}?",
                            paramKeys: { spid: "blocking_session_id" }
                        }
                    ]
                },
                {
                    id: "long-running-transactions",
                    label: "Active Running Queries & Workload",
                    script: "Request Monitor",
                    description: "Tracks active executing queries, elapsed times, statement text, and session controls.",
                    actions: [
                        {
                            label: "Kill Session",
                            variant: "danger",
                            endpoint: "/api/actions/kill-session",
                            confirmPrompt: "WARNING: Terminate running SPID {session_id}?",
                            paramKeys: { spid: "session_id" }
                        }
                    ]
                }
            ]
        },
        {
            id: "storage-vlf",
            label: "Storage & VLF Health",
            description: "Transaction log fragmentation, file sizing, and tempdb allocation contention.",
            queries: [
                {
                    id: "vlf-health",
                    label: "Virtual Log File (VLF) Fragmentation",
                    script: "Log Fragmentation",
                    description: "Audits transaction log VLF counts to detect log performance degradation."
                },
                {
                    id: "tempdb-contention",
                    label: "TempDB Allocation Contention (PFS / GAM / SGAM)",
                    script: "TempDB Latch Audit",
                    description: "Monitors active page latch wait contention on TempDB allocation bitmap pages."
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
            id: "ag-health",
            label: "AG Health",
            description: "Always On Availability Group replica and sync status checks.",
            queries: [
                {
                    id: "ag-replica-states",
                    label: "Availability Group Replica Status & Sync Health",
                    script: "sys.dm_hadr_replica_states",
                    description: "Monitors synchronization, operational states, and commit timestamps for Availability Groups."
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
                            paramKeys: { database: "name", sql: "SQL_ACTION" }
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
// REMEDIATION & ADMINISTRATIVE ENDPOINTS
// ==========================================

app.post('/api/actions/execute-ddl', async (req, res) => {
    const { server, database, sql: ddlSql } = req.body;
    if (!ddlSql || typeof ddlSql !== 'string') {
        return res.status(400).json({ error: "No valid DDL statement supplied." });
    }

    const cleanSql = ddlSql.trim().toUpperCase();
    const isAllowed = cleanSql.startsWith('CREATE NONCLUSTERED INDEX') || 
                      cleanSql.startsWith('CREATE INDEX') || 
                      cleanSql.startsWith('ALTER INDEX');

    if (!isAllowed) {
        return res.status(403).json({ error: "Statement rejected: only verified index maintenance commands are allowed." });
    }

    try {
        const pool = await getPool(server);
        const request = pool.request();
        
        if (database) {
            await request.query(`USE ${quoteIdentifier(database)};`);
        }

        request.timeout = 120000;
        await request.query(ddlSql);

        await logAuditEvent('EXECUTE_DDL', database, ddlSql);
        res.json({ success: true, message: `Command executed successfully on ${database || 'target'}.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/actions/kill-session', async (req, res) => {
    const { server, spid } = req.body;
    const sessionInt = parseInt(spid, 10);
    if (isNaN(sessionInt) || sessionInt <= 50) {
        return res.status(400).json({ error: "Invalid SPID. System sessions (<= 50) cannot be terminated." });
    }

    try {
        const pool = await getPool(server);
        const request = pool.request();
        await request.query(`KILL ${sessionInt};`);
        await logAuditEvent('KILL_SESSION', 'Instance-Wide', `Terminated SPID ${sessionInt}`);
        res.json({ success: true, message: `Session SPID ${sessionInt} was successfully terminated.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/actions/disable-autoshrink', async (req, res) => {
    const { server, database } = req.body;
    if (!database) return res.status(400).json({ error: "Database name required." });

    try {
        const pool = await getPool(server);
        const request = pool.request();
        await request.query(`ALTER DATABASE ${quoteIdentifier(database)} SET AUTO_SHRINK OFF;`);
        await logAuditEvent('DISABLE_AUTO_SHRINK', database, 'Disabled AUTO_SHRINK successfully.');
        res.json({ success: true, message: `AUTO_SHRINK disabled on ${database}.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/actions/download-plan', async (req, res) => {
    const { server, database, plan_id } = req.body;
    const planIdInt = parseInt(plan_id, 10);
    if (isNaN(planIdInt)) {
        return res.status(400).json({ error: "Invalid Plan ID." });
    }

    try {
        const pool = await getPool(server);
        const request = pool.request();
        if (database) {
            await request.query(`USE ${quoteIdentifier(database)};`);
        }
        
        request.input('planId', sql.BigInt, planIdInt);
        const r = await request.query(`
            SELECT query_plan 
            FROM sys.query_store_plan 
            WHERE plan_id = @planId;
        `);

        if (r.recordset.length && r.recordset[0].query_plan) {
            res.json({ success: true, planXml: r.recordset[0].query_plan });
        } else {
            res.status(404).json({ error: "Execution plan not found or not in Query Store." });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// DYNAMIC QUERY DISPATCHER
// ==========================================
app.get('/api/query/:categoryId/:queryId', async (req, res) => {
    const { categoryId, queryId } = req.params;
    const serverId = req.query.server;
    const targetDb = req.query.database;
    const startTime = Date.now();

    try {
        const pool = await getPool(serverId);
        const request = pool.request();

        if (targetDb && categoryId !== 'remediation-audit-log') {
            await request.query(`USE ${quoteIdentifier(targetDb)};`);
            request.input('targetDb', sql.NVarChar, targetDb);
        }

        let recordset = [];

        // 1. Health Check Queries
        if (categoryId === 'health-check' && queryId === 'server-uptime') {
            const r = await request.query(`SELECT sqlserver_start_time, @@VERSION AS version FROM sys.dm_os_sys_info;`);
            recordset = r.recordset;
        } else if (categoryId === 'health-check' && queryId === 'backup-history') {
            const r = await request.query(`
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
                WHERE d.state_desc = 'ONLINE' AND d.name <> 'tempdb' AND d.name = @targetDb
                GROUP BY d.name;
            `);
            recordset = r.recordset;
        } else if (categoryId === 'health-check' && queryId === 'agent-job-failures') {
            const r = await request.query(`
                SELECT TOP 25
                    j.name AS job_name,
                    s.step_name,
                    msdb.dbo.agent_datetime(h.run_date, h.run_time) AS failure_time,
                    h.run_duration,
                    h.message AS error_message,
                    'CRITICAL' AS status
                FROM msdb.dbo.sysjobhistory h
                JOIN msdb.dbo.sysjobs j ON h.job_id = j.job_id
                JOIN msdb.dbo.sysjobsteps s ON h.job_id = s.job_id AND h.step_id = s.step_id
                WHERE h.run_status = 0
                  AND msdb.dbo.agent_datetime(h.run_date, h.run_time) >= DATEADD(hour, -24, GETDATE())
                ORDER BY failure_time DESC;
            `);
            recordset = r.recordset;
        } else if (categoryId === 'health-check' && queryId === 'drive-space') {
            const r = await request.query(`
                SELECT DISTINCT 
                    vs.volume_mount_point, 
                    vs.logical_volume_name,
                    CAST(vs.total_bytes / 1073741824.0 AS DECIMAL(10,2)) AS total_gb,
                    CAST(vs.available_bytes / 1073741824.0 AS DECIMAL(10,2)) AS free_gb,
                    CAST((CAST(vs.available_bytes AS FLOAT) / vs.total_bytes) * 100 AS DECIMAL(5,2)) AS pct_free,
                    CASE 
                        WHEN (CAST(vs.available_bytes AS FLOAT) / vs.total_bytes) * 100 < 10 THEN 'CRITICAL: Under 10% Free Space'
                        WHEN (CAST(vs.available_bytes AS FLOAT) / vs.total_bytes) * 100 < 20 THEN 'WARNING: Under 20% Free Space'
                        ELSE 'HEALTHY'
                    END AS volume_health
                FROM sys.master_files f
                CROSS APPLY sys.dm_os_volume_stats(f.database_id, f.file_id) vs;
            `);
            recordset = r.recordset;

        // 2. Performance & Memory Queries
        } else if (categoryId === 'performance' && queryId === 'wait-stats-summary') {
            const r = await request.query(`
                WITH FilteredWaits AS (
                    SELECT 
                        wait_type, 
                        wait_time_ms / 1000.0 AS wait_time_s,
                        100.0 * wait_time_ms / NULLIF(SUM(wait_time_ms) OVER(), 0) AS pct,
                        ROW_NUMBER() OVER(ORDER BY wait_time_ms DESC) AS rn
                    FROM sys.dm_os_wait_stats
                    WHERE wait_type NOT IN (
                        'CLR_SEMAPHORE','LAZYWRITER_SLEEP','RESOURCE_QUEUE','SLEEP_TASK',
                        'SLEEP_SYSTEMTASK','SQLTRACE_BUFFER_FLUSH','WAITFOR', 'LOGMGR_QUEUE',
                        'CHECKPOINT_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH','XE_TIMER_EVENT',
                        'BROKER_TO_FLUSH','BROKER_TASK_STOP','CLR_MANUAL_EVENT','CLR_AUTO_EVENT',
                        'DIRTY_PAGE_POLL','HADR_FILESTREAM_IOMGR_IOCOMPLETION','SP_SERVER_DIAGNOSTICS_SLEEP',
                        'SOS_WORK_DISPATCHER','XE_DISPATCHER_WAIT','XE_DISPATCHER_JOIN','FT_IFTS_SCHEDULER_IDLE_WAIT',
                        'PREEMPTIVE_XE_DISPATCHER','DISPATCHER_QUEUE_SEMAPHORE','SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
                        'PWAIT_EXTENSIBILITY_CLEANUP_TASK','QDS_ASYNC_QUEUE','ONDEMAND_TASK_QUEUE',
                        'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP','PVS_PREALLOCATE','MEMORY_ALLOCATION_EXT',
                        'BROKER_EVENTHANDLER','BROKER_RECEIVE_WAITFOR','BROKER_TRANSMITTER'
                    ) AND wait_time_ms > 0
                )
                SELECT 
                    wait_type, 
                    CAST(wait_time_s AS DECIMAL(12,2)) AS wait_time_seconds,
                    CAST(pct AS DECIMAL(5,2)) AS pct_total_wait,
                    CASE 
                        WHEN wait_type LIKE 'PAGEIOLATCH%' OR wait_type = 'WRITELOG' OR wait_type LIKE 'IO_COMPLETION%' THEN 'Disk / Storage I/O'
                        WHEN wait_type LIKE 'LCK%' THEN 'Locking & Concurrency'
                        WHEN wait_type LIKE 'LATCH%' THEN 'Internal Latch Contention (Memory/TempDB)'
                        WHEN wait_type IN ('SOS_SCHEDULER_YIELD', 'THREADPOOL', 'CXPACKET', 'CXCONSUMER') THEN 'CPU & Parallelism'
                        WHEN wait_type LIKE 'ASYNC_NETWORK_IO' THEN 'Client Fetch / Network Latency'
                        ELSE 'General Engine Wait'
                    END AS wait_category
                FROM FilteredWaits
                WHERE rn <= 15;
            `);
            recordset = r.recordset;
        } else if (categoryId === 'performance' && queryId === 'query-store-waits') {
            const r = await request.query(`
                SELECT TOP 10
                    ws.wait_category_desc,
                    SUM(ws.total_query_wait_time_ms) / 1000.0 AS total_wait_s,
                    SUM(ws.total_query_wait_time_ms) AS total_wait_ms,
                    AVG(ws.avg_query_wait_time_ms) AS avg_wait_ms,
                    COUNT(DISTINCT q.query_id) AS distinct_queries
                FROM sys.query_store_wait_stats ws
                JOIN sys.query_store_plan p ON ws.plan_id = p.plan_id
                JOIN sys.query_store_query q ON p.query_id = q.query_id
                JOIN sys.query_store_runtime_stats_interval rsi ON ws.runtime_stats_interval_id = rsi.runtime_stats_interval_id
                WHERE rsi.start_time >= DATEADD(HOUR, -24, GETUTCDATE())
                GROUP BY ws.wait_category_desc
                ORDER BY total_wait_ms DESC;
            `);
            recordset = r.recordset;
        } else if (categoryId === 'performance' && queryId === 'memory-buffer-health') {
            const r = await request.query(`
                SELECT 
                    counter_name, 
                    cntr_value AS raw_value,
                    CASE 
                        WHEN counter_name = 'Page life expectancy' AND cntr_value < 300 THEN 'CRITICAL: Severe Buffer Pool Pressure (< 300s)'
                        WHEN counter_name = 'Page life expectancy' AND cntr_value < 600 THEN 'WARNING: Moderate Memory Churn (< 600s)'
                        WHEN counter_name = 'Page life expectancy' THEN 'HEALTHY: Stable Buffer Life'
                        ELSE 'METRIC'
                    END AS evaluation
                FROM sys.dm_os_performance_counters
                WHERE object_name LIKE '%Buffer Manager%'
                  AND counter_name IN ('Page life expectancy', 'Buffer cache hit ratio', 'Page reads/sec', 'Page writes/sec')
                UNION ALL
                SELECT 
                    'Active Memory Grants Outstanding' AS counter_name,
                    COUNT(*) AS raw_value,
                    CASE WHEN COUNT(*) > 5 THEN 'WARNING: High Concurrent Grants' ELSE 'HEALTHY' END AS evaluation
                FROM sys.dm_exec_query_memory_grants;
            `);
            recordset = r.recordset;
        } else if (categoryId === 'performance' && queryId === 'plan-cache-bloat') {
            const r = await request.query(`
                SELECT 
                    objtype AS cache_object_type,
                    COUNT_BIG(*) AS total_plans,
                    CAST(SUM(CAST(size_in_bytes AS BIGINT)) / 1048576.0 AS DECIMAL(10,2)) AS total_size_mb,
                    AVG(usecounts) AS avg_execution_count,
                    CASE 
                        WHEN objtype = 'Adhoc' AND SUM(CAST(size_in_bytes AS BIGINT)) / 1048576.0 > 500 
                            THEN 'CRITICAL: High Ad-Hoc Plan Bloat (Enable optimize for ad hoc workloads)'
                        ELSE 'OK'
                    END AS cache_health
                FROM sys.dm_exec_cached_plans
                GROUP BY objtype
                ORDER BY total_size_mb DESC;
            `);
            recordset = r.recordset;
        } else if (categoryId === 'performance' && queryId === 'query-store-insights') {
            const r = await request.query(`
                SELECT TOP 20
                    q.query_id,
                    p.plan_id,
                    qt.query_sql_text AS query_text,
                    SUM(rs.count_executions) AS total_executions,
                    SUM(rs.avg_cpu_time * rs.count_executions) / 1000.0 AS total_cpu_ms,
                    (SUM(rs.avg_cpu_time * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0)) / 1000.0 AS avg_cpu_ms,
                    MAX(rs.max_cpu_time) / 1000.0 AS max_cpu_ms,
                    SUM(rs.avg_logical_io_reads * rs.count_executions) AS total_logical_reads,
                    @targetDb AS database_name
                FROM sys.query_store_query_text AS qt
                JOIN sys.query_store_query AS q ON qt.query_text_id = q.query_text_id
                JOIN sys.query_store_plan AS p ON q.query_id = p.query_id
                JOIN sys.query_store_runtime_stats AS rs ON p.plan_id = rs.plan_id
                GROUP BY q.query_id, p.plan_id, qt.query_sql_text
                ORDER BY total_cpu_ms DESC;
            `);
            recordset = r.recordset;

        // 3. Index Maintenance Queries
        } else if (categoryId === 'index-maintenance' && queryId === 'missing-indexes') {
            const r = await request.query(`
                SELECT TOP 20
                    CAST(migs.avg_user_impact AS DECIMAL(5,2)) AS avg_user_impact_pct,
                    migs.user_seeks,
                    migs.user_scans,
                    @targetDb AS database_name,
                    OBJECT_NAME(mid.object_id, mid.database_id) AS table_name,
                    'CREATE NONCLUSTERED INDEX [IX_' + REPLACE(REPLACE(REPLACE(ISNULL(OBJECT_NAME(mid.object_id, mid.database_id),''), '[', ''), ']', ''), ' ', '_') 
                     + '_' + CAST(mid.index_handle AS VARCHAR(10)) + '] ON ' + mid.statement + ' (' + ISNULL(mid.equality_columns, '') 
                     + CASE WHEN mid.equality_columns IS NOT NULL AND mid.inequality_columns IS NOT NULL THEN ', ' ELSE '' END 
                     + ISNULL(mid.inequality_columns, '') + ')' 
                     + ISNULL(' INCLUDE (' + mid.included_columns + ')', '') + ';' AS CREATE_INDEX_DDL
                FROM sys.dm_db_missing_index_group_stats migs
                JOIN sys.dm_db_missing_index_groups mig ON migs.group_handle = mig.index_group_handle
                JOIN sys.dm_db_missing_index_details mid ON mig.index_handle = mid.index_handle
                WHERE mid.database_id = DB_ID(@targetDb)
                ORDER BY migs.avg_user_impact * (migs.user_seeks + migs.user_scans) DESC;
            `);
            recordset = r.recordset;
        } else if (categoryId === 'index-maintenance' && queryId === 'index-fragmentation') {
            const r = await request.query(`
                SELECT TOP 25
                    @targetDb AS database_name,
                    OBJECT_SCHEMA_NAME(ips.object_id, ips.database_id) + '.' + OBJECT_NAME(ips.object_id, ips.database_id) AS table_name,
                    ISNULL(i.name, '(Heap)') AS index_name,
                    CAST(ips.avg_fragmentation_in_percent AS DECIMAL(5,2)) AS avg_fragmentation_pct,
                    ips.page_count,
                    CASE 
                        WHEN i.index_id = 0 THEN 'HEAP: Table without clustered index'
                        WHEN ips.avg_fragmentation_in_percent > 30 THEN 'CRITICAL: Rebuild Recommended (>30%)'
                        WHEN ips.avg_fragmentation_in_percent >= 10 THEN 'WARNING: Reorganize Recommended (10-30%)'
                        ELSE 'HEALTHY'
                    END AS recommendation,
                    CASE 
                        WHEN i.index_id = 0 THEN NULL
                        WHEN ips.avg_fragmentation_in_percent > 30 
                            THEN 'ALTER INDEX [' + i.name + '] ON [' + OBJECT_SCHEMA_NAME(ips.object_id, ips.database_id) + '].[' + OBJECT_NAME(ips.object_id, ips.database_id) + '] REBUILD;'
                        WHEN ips.avg_fragmentation_in_percent >= 10 
                            THEN 'ALTER INDEX [' + i.name + '] ON [' + OBJECT_SCHEMA_NAME(ips.object_id, ips.database_id) + '].[' + OBJECT_NAME(ips.object_id, ips.database_id) + '] REORGANIZE;'
                        ELSE NULL 
                    END AS REMEDIATION_SQL
                FROM sys.dm_db_index_physical_stats(DB_ID(@targetDb), NULL, NULL, NULL, 'LIMITED') ips
                JOIN sys.indexes i ON ips.object_id = i.object_id AND ips.index_id = i.index_id
                WHERE ips.avg_fragmentation_in_percent > 10 
                  AND ips.page_count > 50
                  AND ips.index_id IS NOT NULL
                ORDER BY ips.avg_fragmentation_in_percent DESC;
            `);
            recordset = r.recordset;

        // 4. Blocking & Deadlocks Queries
        } else if (categoryId === 'blocking-deadlocks' && queryId === 'active-blockers') {
            const r = await request.query(`
                SELECT 
                    r.session_id, 
                    r.blocking_session_id, 
                    r.wait_type, 
                    r.wait_time, 
                    r.status, 
                    r.cpu_time
                FROM sys.dm_exec_requests r
                WHERE r.blocking_session_id <> 0;
            `);
            recordset = r.recordset;
        } else if (categoryId === 'blocking-deadlocks' && queryId === 'long-running-transactions') {
            const r = await request.query(`
                SELECT 
                    r.session_id,
                    s.login_name,
                    s.host_name,
                    s.program_name,
                    r.status,
                    r.command,
                    r.wait_type,
                    CAST(r.total_elapsed_time / 1000.0 AS DECIMAL(10,2)) AS elapsed_sec,
                    CAST(r.cpu_time / 1000.0 AS DECIMAL(10,2)) AS cpu_sec,
                    r.logical_reads,
                    SUBSTRING(
                        t.text, 
                        (r.statement_start_offset / 2) + 1,
                        ((CASE r.statement_end_offset 
                            WHEN -1 THEN DATALENGTH(t.text) 
                            ELSE r.statement_end_offset 
                          END - r.statement_start_offset) / 2) + 1
                    ) AS running_statement,
                    DB_NAME(r.database_id) AS database_name
                FROM sys.dm_exec_requests r
                JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
                CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
                WHERE s.is_user_process = 1
                  AND r.session_id <> @@SPID
                  AND (DB_NAME(r.database_id) = @targetDb OR DB_NAME(s.database_id) = @targetDb)
                ORDER BY r.total_elapsed_time DESC;
            `);
            recordset = r.recordset;

        // 5. Storage & VLF Health Queries
        } else if (categoryId === 'storage-vlf' && queryId === 'vlf-health') {
            const r = await request.query(`
                SELECT 
                    DB_NAME(v.database_id) AS database_name,
                    COUNT(v.vlf_sequence_number) AS total_vlfs,
                    SUM(CAST(v.vlf_size_mb AS DECIMAL(10,2))) AS total_log_size_mb,
                    SUM(CASE WHEN v.vlf_active = 1 THEN 1 ELSE 0 END) AS active_vlfs,
                    CASE 
                        WHEN COUNT(v.vlf_sequence_number) > 1000 THEN 'CRITICAL: > 1000 VLFs (High Fragmentation)'
                        WHEN COUNT(v.vlf_sequence_number) > 500 THEN 'WARNING: > 500 VLFs'
                        ELSE 'HEALTHY'
                    END AS vlf_health
                FROM sys.databases d
                CROSS APPLY sys.dm_db_log_info(d.database_id) v
                WHERE d.name = @targetDb
                GROUP BY v.database_id;
            `);
            recordset = r.recordset;
        } else if (categoryId === 'storage-vlf' && queryId === 'tempdb-contention') {
            const r = await request.query(`
                SELECT 
                    session_id, 
                    wait_type, 
                    wait_duration_ms, 
                    resource_description,
                    CASE 
                        WHEN resource_description LIKE '2:%:1' OR resource_description LIKE '2:%:3' THEN 'PFS Allocation Page Contention'
                        WHEN resource_description LIKE '2:%:2' THEN 'GAM Allocation Page Contention'
                        WHEN resource_description LIKE '2:%:6' THEN 'SGAM Allocation Page Contention'
                        ELSE 'Data Page Latch Contention'
                    END AS contention_type,
                    'CRITICAL: Add TempDB data files with equal sizing' AS recommendation
                FROM sys.dm_os_waiting_tasks
                WHERE wait_type LIKE 'PAGELATCH%' AND resource_description LIKE '2:%';
            `);
            recordset = r.recordset;
        } else if (categoryId === 'storage-vlf' && queryId === 'file-growth-config') {
            const r = await request.query(`
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
            `);
            recordset = r.recordset;
        } else if (categoryId === 'storage-vlf' && queryId === 'tempdb-config') {
            const r = await request.query(`
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
            `);
            recordset = r.recordset;

        // 6. Availability Group Queries
       // 6. Availability Group Queries
        } else if (categoryId === 'ag-health' && queryId === 'ag-replica-states') {
            const r = await request.query(`
                IF CAST(SERVERPROPERTY('IsHadrEnabled') AS INT) = 1
                BEGIN
                    SELECT 
                        ISNULL(ag.name, 'N/A') AS ag_name,
                        ar.replica_server_name,
                        ars.role_desc,
                        ars.operational_state_desc,
                        ars.connected_state_desc,
                        ars.synchronization_health_desc,
                        ISNULL(hdrs.synchronization_state_desc, 'N/A') AS synchronization_state_desc,
                        CONVERT(VARCHAR(19), hdrs.last_sent_time, 120) AS last_sent_time,
                        CONVERT(VARCHAR(19), hdrs.last_received_time, 120) AS last_received_time,
                        CONVERT(VARCHAR(19), hdrs.last_hardened_time, 120) AS last_hardened_time,
                        CONVERT(VARCHAR(19), hdrs.last_redone_time, 120) AS last_redone_time
                    FROM sys.availability_groups ag
                    INNER JOIN sys.availability_replicas ar ON ag.group_id = ar.group_id
                    INNER JOIN sys.dm_hadr_availability_replica_states ars ON ar.replica_id = ars.replica_id
                    LEFT JOIN sys.dm_hadr_database_replica_states hdrs ON ar.replica_id = hdrs.replica_id;
                END
                ELSE
                BEGIN
                    SELECT 
                        '(None - Standalone)' AS ag_name,
                        CAST(SERVERPROPERTY('ServerName') AS VARCHAR(100)) AS replica_server_name,
                        'STANDALONE' AS role_desc,
                        'ONLINE' AS operational_state_desc,
                        'CONNECTED' AS connected_state_desc,
                        'HEALTHY' AS synchronization_health_desc,
                        'STANDALONE_INSTANCE' AS synchronization_state_desc;
                END
            `);
            recordset = r.recordset;

        // 7. Security Audit Queries
        } else if (categoryId === 'security-audit' && queryId === 'orphan-users') {
            const r = await request.query(`SELECT name, principal_id, type_desc FROM sys.database_principals WHERE type IN ('S', 'U', 'G') AND sid NOT IN (SELECT sid FROM sys.server_principals);`);
            recordset = r.recordset;

        // 8. Best Practices & Baselines Queries
        } else if (categoryId === 'best-practices' && queryId === 'db-configurations') {
            const r = await request.query(`
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
                    END AS recommendation,
                    CASE 
                        WHEN is_auto_shrink_on = 1 THEN 'ALTER DATABASE [' + name + '] SET AUTO_SHRINK OFF;'
                        ELSE NULL 
                    END AS SQL_ACTION
                FROM sys.databases 
                WHERE name = @targetDb;
            `);
            recordset = r.recordset;
        } else if (categoryId === 'best-practices' && queryId === 'compatibility-level') {
            const r = await request.query(`
                SELECT 
                    name,
                    compatibility_level,
                    CASE compatibility_level
                        WHEN 170 THEN 'SQL Server 2025 (v17.0)'
                        WHEN 160 THEN 'SQL Server 2022 (v16.0)'
                        WHEN 150 THEN 'SQL Server 2019 (v15.0)'
                        WHEN 140 THEN 'SQL Server 2017 (v14.0)'
                        WHEN 130 THEN 'SQL Server 2016 (v13.0)'
                        ELSE 'Legacy Compatibility Level'
                    END AS engine_target_version,
                    is_read_committed_snapshot_on,
                    snapshot_isolation_state_desc
                FROM sys.databases 
                WHERE name = @targetDb;
            `);
            recordset = r.recordset;
        } else if (categoryId === 'best-practices' && queryId === 'isolation-levels') {
            const r = await request.query(`
                SELECT 
                    name AS database_name,
                    is_read_committed_snapshot_on AS rcsi_enabled,
                    snapshot_isolation_state_desc,
                    CASE 
                        WHEN is_read_committed_snapshot_on = 1 THEN 'RECOMMENDED: RCSI is Enabled (Reduces blocking)'
                        ELSE 'INFO: RCSI is Disabled (Standard locking behavior)'
                    END AS concurrency_recommendation
                FROM sys.databases 
                WHERE name = @targetDb;
            `);
            recordset = r.recordset;

        // 9. Remediation Audit Log
        } else if (categoryId === 'remediation-audit-log' && queryId === 'audit-history') {
            recordset = await getAuditLogs();
            if (recordset.length === 0) {
                recordset = [{ status: 'No remediation actions logged to audit_log.json yet.' }];
            }
        } else {
            throw new Error(`Unknown query definition: ${categoryId}/${queryId}`);
        }

        const elapsedMs = Date.now() - startTime;
        res.json({
            success: true,
            elapsedMs,
            recordsets: [recordset]
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`SQLDB Toolkit backend running on port ${PORT}`);
    console.log(`==================================================\n`);
    if (process.env.AUTO_OPEN_BROWSER === 'true') {
        exec(`start http://localhost:${PORT}`);
    }
});