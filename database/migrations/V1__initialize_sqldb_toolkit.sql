IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'sqldb_toolkit')
BEGIN
    EXEC('CREATE SCHEMA sqldb_toolkit');
END;
GO

IF OBJECT_ID('sqldb_toolkit.audit_events', 'U') IS NULL
BEGIN
    CREATE TABLE sqldb_toolkit.audit_events (
        audit_event_id INT IDENTITY(1,1) PRIMARY KEY,
        event_type NVARCHAR(100) NOT NULL,
        database_name SYSNAME NULL,
        details NVARCHAR(MAX) NULL,
        created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END;
