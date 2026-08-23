# Deployment

## Container deployment
```bash
docker compose build
docker compose up
```

The container builds the frontend with Vite, then starts the Express server on port `4000`.

## Production checklist
- Provide `.env` values for SQL Server connectivity.
- Set `CORS_ORIGIN` to the allowed UI origins.
- Tune `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, and `DB_POOL_MAX_SIZE` for the target environment.
- Run `npm run build` before packaging non-container deployments.

## Database migrations
Flyway-compatible migrations live in `database/migrations/`. The initial migration creates the optional `sqldb_toolkit.audit_events` table for future operational metadata.
