/*
 * Every query below is taken directly from wondisha/SQLDB. Each entry maps
 * 1:1 to a script in the repo (see `script`), so panels stay traceable back
 * to source. `scope: "server"` queries run against whatever database the
 * connection lands on (they read server-scoped DMVs/catalog views).
 * `scope: "database"` queries use DB_ID()/OBJECT_ID() and must run with a
 * specific user database selected via the dashboard's database picker.
 */

const CATEGORIES = {
  'health-check': {
    label: 'Health Check',
    description: 'Daily DBA/developer query pack — waits, blocking, backups, jobs, tempdb, transactions.',
    queries: [
      {
        id: 'wait-profile',
        label: 'Instance wait profile',
        script: 'health-check/01_dashboard_query_pack.sql',
        scope: 'server',
        refreshSeconds: 15,
        sql: `
SELECT TOP (20)
    wait_type,
    waiting_tasks_count,
    wait_time_ms,
    signal_wait_time_ms,
    CAST(100.0 * wait_time_ms / NULLIF(SUM(wait_time_ms) OVER(),0) AS DECIMAL(6,2)) AS pct_total_wait
FROM sys.dm_os_wait_stats
WHERE wait_type NOT LIKE 'SLEEP%'
ORDER BY wait_time_ms DESC;`,
      },
      {
        id: 'active-blockers',
        label: 'Active blockers',
        script: 'health-check/01_dashboard_query_pack.sql',
        scope: 'server',
        refreshSeconds: 10,
        sql: `
SELECT
    r.session_id,
    r.blocking_session_id,
    r.status,
    r.wait_type,
    r.wait_time,
    r.cpu_time,
    r.total_elapsed_time,
    DB_NAME(r.database_id) AS database_name
FROM sys.dm_exec_requests r
WHERE r.blocking_session_id <> 0
   OR r.session_id IN (SELECT blocking_session_id FROM sys.dm_exec_requests WHERE blocking_session_id <> 0)
ORDER BY r.blocking_session_id DESC, r.session_id;`,
      },
      {
        id: 'backup-freshness',
        label: 'Backup freshness',
        script: 'health-check/01_dashboard_query_pack.sql',
        scope: 'server',
        refreshSeconds: 300,
        sql: `
SELECT
    d.name AS database_name,
    MAX(CASE WHEN bs.type = 'D' THEN bs.backup_finish_date END) AS last_full_backup,
    MAX(CASE WHEN bs.type = 'I' THEN bs.backup_finish_date END) AS last_diff_backup,
    MAX(CASE WHEN bs.type = 'L' THEN bs.backup_finish_date END) AS last_log_backup
FROM sys.databases d
LEFT JOIN msdb.dbo.backupset bs
    ON d.name = bs.database_name
GROUP BY d.name
ORDER BY d.name;`,
      },
      {
        id: 'failed-jobs-24h',
        label: 'Failed jobs (last 24h)',
        script: 'health-check/01_dashboard_query_pack.sql',
        scope: 'server',
        refreshSeconds: 60,
        sql: `
SELECT
    j.name AS job_name,
    h.step_name,
    msdb.dbo.agent_datetime(h.run_date, h.run_time) AS run_datetime,
    h.message
FROM msdb.dbo.sysjobhistory h
JOIN msdb.dbo.sysjobs j ON h.job_id = j.job_id
WHERE h.run_status = 0
  AND msdb.dbo.agent_datetime(h.run_date, h.run_time) >= DATEADD(HOUR, -24, GETDATE())
ORDER BY run_datetime DESC;`,
      },
      {
        id: 'tempdb-top-sessions',
        label: 'TempDB top sessions',
        script: 'health-check/01_dashboard_query_pack.sql',
        scope: 'server',
        refreshSeconds: 30,
        sql: `
SELECT TOP (20)
    s.session_id,
    s.login_name,
    s.host_name,
    s.program_name,
    CAST((su.user_objects_alloc_page_count + su.internal_objects_alloc_page_count) * 8.0 / 1024 AS DECIMAL(18,2)) AS allocated_mb
FROM sys.dm_db_session_space_usage su
JOIN sys.dm_exec_sessions s ON su.session_id = s.session_id
ORDER BY allocated_mb DESC;`,
      },
      {
        id: 'long-running-transactions',
        label: 'Long running transactions',
        script: 'health-check/01_dashboard_query_pack.sql',
        scope: 'server',
        refreshSeconds: 15,
        sql: `
SELECT
    at.transaction_id,
    at.transaction_begin_time,
    DATEDIFF(MINUTE, at.transaction_begin_time, GETDATE()) AS open_minutes,
    st.session_id,
    es.login_name,
    es.program_name,
    er.status,
    er.command,
    er.blocking_session_id
FROM sys.dm_tran_active_transactions at
JOIN sys.dm_tran_session_transactions st ON at.transaction_id = st.transaction_id
LEFT JOIN sys.dm_exec_sessions es ON st.session_id = es.session_id
LEFT JOIN sys.dm_exec_requests er ON st.session_id = er.session_id
ORDER BY open_minutes DESC;`,
      },
    ],
  },

  performance: {
    label: 'Performance',
    description: 'Plan-cache workload analysis: top resource queries, missing indexes, statistics health.',
    queries: [
      {
        id: 'top-resource-queries',
        label: 'Top resource-consuming queries',
        script: 'performance/01_top_resource_queries.sql',
        scope: 'server',
        requiresPermission: 'VIEW SERVER STATE',
        refreshSeconds: 30,
        sql: `
SET NOCOUNT ON;

SELECT TOP (50)
    DB_NAME(COALESCE(CAST(pa.value AS INT), 0)) AS database_name,
    qs.execution_count,
    CAST(qs.total_worker_time / 1000.0 AS DECIMAL(18,2)) AS total_cpu_ms,
    CAST((qs.total_worker_time / NULLIF(qs.execution_count,0)) / 1000.0 AS DECIMAL(18,2)) AS avg_cpu_ms,
    CAST(qs.total_elapsed_time / 1000.0 AS DECIMAL(18,2)) AS total_elapsed_ms,
    CAST((qs.total_elapsed_time / NULLIF(qs.execution_count,0)) / 1000.0 AS DECIMAL(18,2)) AS avg_elapsed_ms,
    qs.total_logical_reads,
    qs.total_logical_writes,
    qs.last_execution_time,
    SUBSTRING(st.text,
        (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) ELSE qs.statement_end_offset END - qs.statement_start_offset)/2) + 1
    ) AS statement_text
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
OUTER APPLY sys.dm_exec_plan_attributes(qs.plan_handle) pa
WHERE pa.attribute = 'dbid'
ORDER BY qs.total_worker_time DESC;`,
      },
      {
        id: 'missing-index-recommendations',
        label: 'Missing index recommendations',
        script: 'performance/02_missing_index_recommendations.sql',
        scope: 'database',
        requiresPermission: 'VIEW SERVER STATE',
        refreshSeconds: 120,
        sql: `
SET NOCOUNT ON;

SELECT
    DB_NAME(mid.database_id) AS database_name,
    OBJECT_SCHEMA_NAME(mid.object_id, mid.database_id) AS schema_name,
    OBJECT_NAME(mid.object_id, mid.database_id) AS table_name,
    migs.user_seeks,
    migs.user_scans,
    CAST(migs.avg_total_user_cost AS DECIMAL(18,2)) AS avg_total_user_cost,
    CAST(migs.avg_user_impact AS DECIMAL(18,2)) AS avg_user_impact_pct,
    (migs.user_seeks + migs.user_scans) * migs.avg_total_user_cost * (migs.avg_user_impact/100.0) AS improvement_measure,
    mid.equality_columns,
    mid.inequality_columns,
    mid.included_columns,
    'CREATE INDEX IX_' + REPLACE(OBJECT_NAME(mid.object_id, mid.database_id), ' ', '') +
    '_' + CAST(mid.index_handle AS VARCHAR(20)) +
    ' ON ' + mid.statement +
    ' (' + ISNULL(mid.equality_columns, '') +
    CASE WHEN mid.equality_columns IS NOT NULL AND mid.inequality_columns IS NOT NULL THEN ',' ELSE '' END +
    ISNULL(mid.inequality_columns, '') + ')' +
    ISNULL(' INCLUDE (' + mid.included_columns + ')', '') AS proposed_create_index_sql
FROM sys.dm_db_missing_index_group_stats AS migs
JOIN sys.dm_db_missing_index_groups AS mig
    ON migs.group_handle = mig.index_group_handle
JOIN sys.dm_db_missing_index_details AS mid
    ON mig.index_handle = mid.index_handle
WHERE mid.database_id = DB_ID()
ORDER BY improvement_measure DESC;`,
      },
      {
        id: 'stats-health-check',
        label: 'Statistics health check',
        script: 'performance/03_stats_health_check.sql',
        scope: 'database',
        refreshSeconds: 300,
        sql: `
SET NOCOUNT ON;

;WITH stats_info AS (
    SELECT
        s.object_id,
        OBJECT_SCHEMA_NAME(s.object_id) AS schema_name,
        OBJECT_NAME(s.object_id) AS table_name,
        s.name AS stats_name,
        sp.last_updated,
        sp.rows,
        sp.rows_sampled,
        sp.modification_counter
    FROM sys.stats s
    OUTER APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
    WHERE OBJECTPROPERTY(s.object_id, 'IsUserTable') = 1
)
SELECT
    schema_name,
    table_name,
    stats_name,
    last_updated,
    rows,
    rows_sampled,
    modification_counter,
    CASE
        WHEN rows IS NULL THEN 'Unknown'
        WHEN rows = 0 THEN 'NoRows'
        WHEN modification_counter > (rows * 0.2) THEN 'ConsiderUpdate'
        ELSE 'OK'
    END AS recommendation,
    'UPDATE STATISTICS [' + schema_name + '].[' + table_name + '] [' + stats_name + '] WITH FULLSCAN;' AS suggested_update_sql
FROM stats_info
ORDER BY modification_counter DESC, rows DESC;`,
      },
    ],
  },

  'index-maintenance': {
    label: 'Index Maintenance',
    description: 'Index health, fragmentation, and REORGANIZE/REBUILD recommendations.',
    queries: [
      {
        id: 'fragmentation-report',
        label: 'Index fragmentation report',
        script: 'index-maintenance/01_index_fragmentation_report.sql',
        scope: 'database',
        refreshSeconds: 300,
        sql: `
SET NOCOUNT ON;

SELECT
    DB_NAME() AS database_name,
    s.name AS schema_name,
    t.name AS table_name,
    i.name AS index_name,
    i.index_id,
    ips.index_type_desc,
    ips.page_count,
    CAST(ips.avg_fragmentation_in_percent AS DECIMAL(6,2)) AS avg_fragmentation_in_percent
FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'SAMPLED') ips
JOIN sys.indexes i
    ON ips.object_id = i.object_id
   AND ips.index_id = i.index_id
JOIN sys.tables t
    ON i.object_id = t.object_id
JOIN sys.schemas s
    ON t.schema_id = s.schema_id
WHERE ips.page_count >= 128
  AND i.index_id > 0
ORDER BY ips.avg_fragmentation_in_percent DESC, ips.page_count DESC;`,
      },
      {
        id: 'maintenance-generator',
        label: 'Reorganize/rebuild generator',
        script: 'index-maintenance/02_index_maintenance_generator.sql',
        scope: 'database',
        refreshSeconds: 300,
        sql: `
SET NOCOUNT ON;

IF OBJECT_ID('tempdb..#frag') IS NOT NULL DROP TABLE #frag;

SELECT
    s.name AS schema_name,
    t.name AS table_name,
    i.name AS index_name,
    i.object_id,
    i.index_id,
    ips.page_count,
    ips.avg_fragmentation_in_percent
INTO #frag
FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'SAMPLED') ips
JOIN sys.indexes i
    ON ips.object_id = i.object_id
   AND ips.index_id = i.index_id
JOIN sys.tables t
    ON i.object_id = t.object_id
JOIN sys.schemas s
    ON t.schema_id = s.schema_id
WHERE i.index_id > 0
  AND ips.page_count >= 128;

SELECT
    schema_name,
    table_name,
    index_name,
    page_count,
    CAST(avg_fragmentation_in_percent AS DECIMAL(6,2)) AS frag_pct,
    CASE
        WHEN avg_fragmentation_in_percent BETWEEN 10 AND 30 THEN
            'ALTER INDEX [' + index_name + '] ON [' + schema_name + '].[' + table_name + '] REORGANIZE;'
        WHEN avg_fragmentation_in_percent > 30 THEN
            'ALTER INDEX [' + index_name + '] ON [' + schema_name + '].[' + table_name + '] REBUILD WITH (SORT_IN_TEMPDB = ON);'
        ELSE NULL
    END AS maintenance_sql
FROM #frag
WHERE avg_fragmentation_in_percent >= 10
ORDER BY avg_fragmentation_in_percent DESC, page_count DESC;`,
      },
    ],
  },

  monitoring: {
    label: 'Blocking & Deadlocks',
    description: 'Real-time blocking chains, wait statistics, and deadlock graphs from system_health.',
    queries: [
      {
        id: 'current-blocking-chains',
        label: 'Current blocking chains',
        script: 'monitoring/blocking-deadlocks/01_current_blocking_chains.sql',
        scope: 'server',
        requiresPermission: 'VIEW SERVER STATE',
        refreshSeconds: 10,
        sql: `
SET NOCOUNT ON;

SELECT
    r.session_id,
    r.blocking_session_id,
    r.status,
    r.wait_type,
    r.wait_time,
    r.wait_resource,
    r.cpu_time,
    r.total_elapsed_time,
    DB_NAME(r.database_id) AS database_name,
    s.host_name,
    s.program_name,
    s.login_name,
    SUBSTRING(t.text,
        (r.statement_start_offset/2)+1,
        ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(t.text) ELSE r.statement_end_offset END - r.statement_start_offset)/2) + 1
    ) AS running_statement
FROM sys.dm_exec_requests r
JOIN sys.dm_exec_sessions s
    ON r.session_id = s.session_id
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.blocking_session_id <> 0
   OR r.session_id IN (SELECT blocking_session_id FROM sys.dm_exec_requests WHERE blocking_session_id <> 0)
ORDER BY r.blocking_session_id DESC, r.session_id;`,
      },
      {
        id: 'wait-stats-snapshot',
        label: 'Wait statistics snapshot',
        script: 'monitoring/blocking-deadlocks/02_wait_stats_snapshot.sql',
        scope: 'server',
        refreshSeconds: 15,
        sql: `
SET NOCOUNT ON;

SELECT
    wait_type,
    waiting_tasks_count,
    wait_time_ms,
    signal_wait_time_ms,
    CAST(100.0 * wait_time_ms / NULLIF(SUM(wait_time_ms) OVER(), 0) AS DECIMAL(6,2)) AS pct_total_wait
FROM sys.dm_os_wait_stats
WHERE wait_type NOT LIKE 'SLEEP%'
  AND wait_type NOT IN (
    'CLR_SEMAPHORE','LAZYWRITER_SLEEP','RESOURCE_QUEUE','SQLTRACE_BUFFER_FLUSH','WAITFOR','LOGMGR_QUEUE',
    'CHECKPOINT_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH','XE_TIMER_EVENT','BROKER_TO_FLUSH',
    'BROKER_TASK_STOP','CLR_MANUAL_EVENT','CLR_AUTO_EVENT','DISPATCHER_QUEUE_SEMAPHORE',
    'FT_IFTS_SCHEDULER_IDLE_WAIT','XE_DISPATCHER_WAIT','XE_DISPATCHER_JOIN','BROKER_EVENTHANDLER',
    'TRACEWRITE','FT_IFTSHC_MUTEX','SQLTRACE_INCREMENTAL_FLUSH_SLEEP'
  )
ORDER BY wait_time_ms DESC;`,
      },
      {
        id: 'deadlock-report',
        label: 'Deadlock report (system_health)',
        script: 'monitoring/blocking-deadlocks/03_deadlock_report_from_system_health.sql',
        scope: 'server',
        refreshSeconds: 60,
        sql: `
SET NOCOUNT ON;

;WITH DeadlockData AS (
    SELECT
        CAST(event_data AS XML) AS event_xml,
        DATEADD(HOUR, DATEDIFF(HOUR, GETUTCDATE(), GETDATE()),
            CAST(CAST(event_data AS XML).value('(event/@timestamp)[1]', 'datetime2') AS datetime2)
        ) AS local_event_time
    FROM sys.fn_xe_file_target_read_file('system_health*.xel', NULL, NULL, NULL)
    WHERE object_name = 'xml_deadlock_report'
)
SELECT
    local_event_time,
    CAST(event_xml AS NVARCHAR(MAX)) AS deadlock_graph_xml
FROM DeadlockData
ORDER BY local_event_time DESC;`,
      },
    ],
  },

  'dba-dev-handbook': {
    label: 'DBA/Dev Handbook',
    description: 'Daily operations checks useful to both DBAs and developers.',
    queries: [
      {
        id: 'file-size-and-growth',
        label: 'Database file size & growth',
        script: 'dba-dev-handbook/01_database_file_size_and_growth.sql',
        scope: 'server',
        refreshSeconds: 300,
        sql: `
SET NOCOUNT ON;

SELECT
    DB_NAME(mf.database_id) AS database_name,
    mf.type_desc,
    mf.name AS logical_file_name,
    mf.physical_name,
    CAST(mf.size/128.0 AS DECIMAL(18,2)) AS size_mb,
    CASE mf.max_size
        WHEN -1 THEN -1
        ELSE CAST(mf.max_size/128.0 AS DECIMAL(18,2))
    END AS max_size_mb,
    CASE mf.is_percent_growth
        WHEN 1 THEN CAST(mf.growth AS VARCHAR(20)) + '%'
        ELSE CAST(mf.growth/128 AS VARCHAR(20)) + ' MB'
    END AS growth_setting
FROM sys.master_files mf
ORDER BY database_name, mf.type_desc;`,
      },
      {
        id: 'backup-freshness',
        label: 'Backup freshness',
        script: 'dba-dev-handbook/02_backup_freshness_check.sql',
        scope: 'server',
        refreshSeconds: 300,
        sql: `
SET NOCOUNT ON;

SELECT
    d.name AS database_name,
    MAX(CASE WHEN bs.type = 'D' THEN bs.backup_finish_date END) AS last_full_backup,
    MAX(CASE WHEN bs.type = 'I' THEN bs.backup_finish_date END) AS last_diff_backup,
    MAX(CASE WHEN bs.type = 'L' THEN bs.backup_finish_date END) AS last_log_backup
FROM sys.databases d
LEFT JOIN msdb.dbo.backupset bs
    ON d.name = bs.database_name
GROUP BY d.name
ORDER BY d.name;`,
      },
      {
        id: 'failed-jobs-7d',
        label: 'Failed jobs (last 7 days)',
        script: 'dba-dev-handbook/03_failed_jobs_last_7_days.sql',
        scope: 'server',
        refreshSeconds: 120,
        sql: `
SET NOCOUNT ON;

SELECT
    j.name AS job_name,
    h.step_id,
    h.step_name,
    msdb.dbo.agent_datetime(h.run_date, h.run_time) AS run_datetime,
    h.run_duration,
    h.message
FROM msdb.dbo.sysjobhistory h
JOIN msdb.dbo.sysjobs j
    ON h.job_id = j.job_id
WHERE h.run_status = 0
  AND msdb.dbo.agent_datetime(h.run_date, h.run_time) >= DATEADD(DAY, -7, GETDATE())
ORDER BY run_datetime DESC;`,
      },
      {
        id: 'tempdb-usage-by-session',
        label: 'TempDB usage by session',
        script: 'dba-dev-handbook/04_tempdb_usage_by_session.sql',
        scope: 'server',
        requiresPermission: 'VIEW SERVER STATE',
        refreshSeconds: 30,
        sql: `
SET NOCOUNT ON;

SELECT
    s.session_id,
    s.login_name,
    s.host_name,
    s.program_name,
    CAST((su.user_objects_alloc_page_count + su.internal_objects_alloc_page_count) * 8.0 / 1024 AS DECIMAL(18,2)) AS allocated_mb,
    CAST((su.user_objects_dealloc_page_count + su.internal_objects_dealloc_page_count) * 8.0 / 1024 AS DECIMAL(18,2)) AS deallocated_mb
FROM sys.dm_db_session_space_usage su
JOIN sys.dm_exec_sessions s
    ON su.session_id = s.session_id
ORDER BY allocated_mb DESC;`,
      },
      {
        id: 'long-running-transactions',
        label: 'Long-running transactions',
        script: 'dba-dev-handbook/05_long_running_transactions.sql',
        scope: 'server',
        requiresPermission: 'VIEW SERVER STATE',
        refreshSeconds: 15,
        sql: `
SET NOCOUNT ON;

SELECT
    at.transaction_id,
    at.name AS transaction_name,
    at.transaction_begin_time,
    DATEDIFF(MINUTE, at.transaction_begin_time, GETDATE()) AS open_minutes,
    st.session_id,
    es.login_name,
    es.host_name,
    es.program_name,
    er.status,
    er.command,
    er.wait_type,
    er.blocking_session_id,
    DB_NAME(er.database_id) AS database_name
FROM sys.dm_tran_active_transactions at
JOIN sys.dm_tran_session_transactions st
    ON at.transaction_id = st.transaction_id
LEFT JOIN sys.dm_exec_sessions es
    ON st.session_id = es.session_id
LEFT JOIN sys.dm_exec_requests er
    ON st.session_id = er.session_id
ORDER BY open_minutes DESC;`,
      },
    ],
  },

  'ag-health': {
    label: 'AG Health',
    description: 'Always On Availability Group replica, sync, routing, and failover-readiness checks.',
    queries: [
      {
        id: 'replica-dashboard',
        label: 'Replica dashboard',
        script: 'ag-health/01_ag_replica_dashboard.sql',
        scope: 'server',
        refreshSeconds: 15,
        sql: `
SET NOCOUNT ON;

SELECT
    ag.name AS ag_name,
    ar.replica_server_name,
    ars.role_desc,
    ars.connected_state_desc,
    ars.recovery_health_desc,
    ars.synchronization_health_desc,
    ar.availability_mode_desc,
    ar.failover_mode_desc,
    ar.session_timeout,
    ar.primary_role_allow_connections_desc,
    ar.secondary_role_allow_connections_desc,
    ars.last_connect_error_number,
    ars.last_connect_error_description,
    ars.last_connect_error_timestamp
FROM sys.availability_groups ag
JOIN sys.availability_replicas ar
    ON ag.group_id = ar.group_id
LEFT JOIN sys.dm_hadr_availability_replica_states ars
    ON ar.replica_id = ars.replica_id
ORDER BY ag.name, ar.replica_server_name;`,
      },
      {
        id: 'database-sync-status',
        label: 'Database sync status',
        script: 'ag-health/02_ag_database_sync_status.sql',
        scope: 'server',
        refreshSeconds: 10,
        sql: `
SET NOCOUNT ON;

SELECT
    ag.name AS ag_name,
    ar.replica_server_name,
    DB_NAME(drs.database_id) AS database_name,
    drs.is_local,
    drs.is_primary_replica,
    drs.synchronization_state_desc,
    drs.synchronization_health_desc,
    drs.database_state_desc,
    drs.log_send_queue_size,
    drs.log_send_rate,
    drs.redo_queue_size,
    drs.redo_rate,
    drs.last_sent_time,
    drs.last_received_time,
    drs.last_hardened_time,
    drs.last_redone_time,
    drs.last_commit_time,
    DATEDIFF(SECOND, drs.last_commit_time, GETDATE()) AS approx_commit_lag_seconds
FROM sys.dm_hadr_database_replica_states drs
JOIN sys.availability_replicas ar
    ON drs.replica_id = ar.replica_id
JOIN sys.availability_groups ag
    ON ar.group_id = ag.group_id
ORDER BY ag.name, database_name, ar.replica_server_name;`,
      },
      {
        id: 'listener-and-routing',
        label: 'Listener & read-only routing',
        script: 'ag-health/03_ag_listener_and_routing_check.sql',
        scope: 'server',
        refreshSeconds: 300,
        sql: `
SET NOCOUNT ON;

SELECT
    ag.name AS ag_name,
    l.dns_name AS listener_dns_name,
    l.port,
    ip.ip_address,
    ip.subnet_mask,
    ip.network_subnet_ip,
    ip.state_desc AS listener_ip_state
FROM sys.availability_group_listeners l
JOIN sys.availability_groups ag
    ON l.group_id = ag.group_id
LEFT JOIN sys.availability_group_listener_ip_addresses ip
    ON l.listener_id = ip.listener_id
ORDER BY ag.name, l.dns_name;`,
      },
      {
        id: 'failover-readiness',
        label: 'Failover readiness check',
        script: 'ag-health/04_ag_failover_readiness_check.sql',
        scope: 'server',
        refreshSeconds: 30,
        sql: `
SET NOCOUNT ON;

;WITH replica_health AS (
    SELECT
        ag.name AS ag_name,
        ar.replica_server_name,
        ars.role_desc,
        ars.connected_state_desc,
        ars.recovery_health_desc,
        ars.synchronization_health_desc,
        CASE
            WHEN ars.connected_state_desc <> 'CONNECTED' THEN 1
            WHEN ars.recovery_health_desc <> 'ONLINE' THEN 1
            WHEN ars.synchronization_health_desc NOT IN ('HEALTHY','PARTIALLY_HEALTHY') THEN 1
            ELSE 0
        END AS replica_issue
    FROM sys.availability_groups ag
    JOIN sys.availability_replicas ar
      ON ag.group_id = ar.group_id
    LEFT JOIN sys.dm_hadr_availability_replica_states ars
      ON ar.replica_id = ars.replica_id
),
db_health AS (
    SELECT
        ag.name AS ag_name,
        ar.replica_server_name,
        DB_NAME(drs.database_id) AS database_name,
        drs.is_primary_replica,
        drs.synchronization_state_desc,
        drs.synchronization_health_desc,
        drs.log_send_queue_size,
        drs.redo_queue_size,
        CASE
            WHEN drs.is_primary_replica = 0 AND drs.synchronization_state_desc <> 'SYNCHRONIZED' THEN 1
            WHEN drs.synchronization_health_desc <> 'HEALTHY' THEN 1
            ELSE 0
        END AS db_issue
    FROM sys.dm_hadr_database_replica_states drs
    JOIN sys.availability_replicas ar
      ON drs.replica_id = ar.replica_id
    JOIN sys.availability_groups ag
      ON ar.group_id = ag.group_id
)
SELECT
    rh.ag_name,
    rh.replica_server_name,
    rh.role_desc,
    rh.connected_state_desc,
    rh.recovery_health_desc,
    rh.synchronization_health_desc,
    rh.replica_issue,
    dh.database_name,
    dh.is_primary_replica,
    dh.synchronization_state_desc,
    dh.synchronization_health_desc AS db_sync_health,
    dh.log_send_queue_size,
    dh.redo_queue_size,
    dh.db_issue,
    CASE
        WHEN rh.replica_issue = 0 AND ISNULL(dh.db_issue,0) = 0 THEN 'READY'
        ELSE 'NOT_READY'
    END AS failover_readiness
FROM replica_health rh
LEFT JOIN db_health dh
    ON rh.ag_name = dh.ag_name
   AND rh.replica_server_name = dh.replica_server_name
ORDER BY rh.ag_name, rh.replica_server_name, dh.database_name;`,
      },
      {
        id: 'recent-errors-xe',
        label: 'Recent AG errors (Extended Events)',
        script: 'ag-health/05_ag_recent_errors_from_xe.sql',
        scope: 'server',
        refreshSeconds: 60,
        sql: `
SET NOCOUNT ON;

;WITH xe AS (
    SELECT
        CAST(event_data AS XML) AS event_xml
    FROM sys.fn_xe_file_target_read_file('system_health*.xel', NULL, NULL, NULL)
    WHERE object_name = 'error_reported'
), parsed AS (
    SELECT
        DATEADD(HOUR, DATEDIFF(HOUR, GETUTCDATE(), GETDATE()),
            CAST(event_xml.value('(event/@timestamp)[1]', 'datetime2') AS datetime2)
        ) AS local_event_time,
        event_xml.value('(event/data[@name="error_number"]/value)[1]', 'int') AS error_number,
        event_xml.value('(event/data[@name="severity"]/value)[1]', 'int') AS severity,
        event_xml.value('(event/data[@name="message"]/value)[1]', 'nvarchar(4000)') AS message_text
    FROM xe
)
SELECT TOP (200)
    local_event_time,
    error_number,
    severity,
    message_text
FROM parsed
WHERE message_text LIKE '%availability group%'
   OR message_text LIKE '%hadr%'
   OR message_text LIKE '%replica%'
   OR message_text LIKE '%synchroniz%'
ORDER BY local_event_time DESC;`,
      },
    ],
  },
};

function findQuery(categoryId, queryId) {
  const category = CATEGORIES[categoryId];
  if (!category) return null;
  const query = category.queries.find((q) => q.id === queryId);
  if (!query) return null;
  return { category, query };
}

module.exports = { CATEGORIES, findQuery };
