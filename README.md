# SQLDB Toolkit — Live Monitoring Dashboard

A live dashboard for [wondisha/SQLDB](https://github.com/wondisha/SQLDB), a collection of SQL Server DBA scripts. The project has two parts:

- **backend/API** — a Node.js/Express service in `src/` that opens SQL Server connections, exposes `/api/*` endpoints, applies rate limiting/compression, and serves frontend assets.
- **frontend** — plain HTML/CSS/JS source in `frontend/`, with production bundles emitted to `dist/` via Vite.

## Architecture
- Runtime architecture notes: [`docs/architecture.md`](docs/architecture.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Contributor workflow: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Deployment guide: [`DEPLOYMENT.md`](DEPLOYMENT.md)
- Performance notes: [`PERFORMANCE.md`](PERFORMANCE.md)

## Setup
```bash
npm install
cp .env.example .env
```

Required `.env` values:

```env
DB_SERVER=localhost
DB_NAME=master
DB_USER=sa
DB_PASSWORD=CHANGE_ME
DB_ENCRYPT=false
PORT=4000
```

Common tuning values:

```env
DB_CONNECTION_TIMEOUT_MS=5000
DB_REQUEST_TIMEOUT_MS=15000
DB_POOL_MAX_SIZE=10
CORS_ORIGIN=http://localhost:5173
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=60
QUERY_CACHE_TTL_MS=15000
STATIC_CACHE_MAX_AGE_SECONDS=300
```

## Development
Start the backend:

```bash
npm start
```

Run the frontend in dev mode:

```bash
npm run dev
```

The dev server runs on `http://localhost:5173`. The backend continues to listen on `http://localhost:4000`.

## Builds
- `npm run build` — creates a minified production bundle with source maps in `dist/`
- `npm run build:dev` — creates a non-minified debug bundle with source maps
- `npm start` will serve `dist/` when it exists, otherwise it falls back to the checked-in `public/` assets

## Testing and quality checks
```bash
npm test
npm run test:coverage
npm run lint
npm run build
```

Pre-commit hooks are stored in `.githooks/`. Enable them once per clone:

```bash
git config core.hooksPath .githooks
```

## Dependency management
- `.npmrc` enforces lockfile usage, exact saved versions, and deterministic installs.
- Commit `package-lock.json` with every dependency change.
- Prefer `npm ci` in CI and production image builds.
- Patch/minor dependency updates are preferred unless a task explicitly requires a major upgrade.

## CI/CD automation
GitHub Actions now provide:
- lint + test + build validation on pushes/PRs
- `npm audit --omit=dev` dependency scanning
- CodeQL analysis for JavaScript

Workflow files live in `.github/workflows/`.

## Docker and deployment
```bash
docker compose build
docker compose up
```

The container image installs dependencies, builds the frontend bundle, and starts the Express API on port `4000`.

## Database management
The toolkit does not require an application-owned schema to read SQL Server diagnostics, but Flyway-compatible migrations are included for optional operational metadata.

- Config: `database/flyway/conf/flyway.conf`
- Initial schema migration: `database/migrations/V1__initialize_sqldb_toolkit.sql`

## Performance and caching
- Gzip compression is enabled for HTTP responses.
- Static JS/CSS files receive cache headers.
- Selected read-only diagnostic queries are cached in memory for a short TTL.
- Add `?refresh=1` to a cached query endpoint to bypass the cache while troubleshooting.

## Security hardening
- Restrict `CORS_ORIGIN` in production.
- API rate limiting is enabled with environment-based tuning.
- Keep `.env` local; the repo ignores secrets by default.
- Review `npm audit`, CI results, and CodeQL findings before release.

## Database health endpoint
Use `GET /api/health/db` for a lightweight SQL connectivity probe (`SELECT 1`).

Success:

```json
{
  "ok": true,
  "server": "localhost",
  "database": "master",
  "checkedAt": "2026-08-21T02:44:26.412Z",
  "latencyMs": 18
}
```

Failure:

```json
{
  "ok": false,
  "code": "AUTH_FAILED",
  "message": "Authentication failed. Check DB_USER/DB_PASSWORD.",
  "checkedAt": "2026-08-21T02:44:26.412Z",
  "details": {
    "server": "localhost",
    "database": "master"
  },
  "traceId": "4ed507e2-b1f3-4281-a854-7e06e2557afe"
}
```

## Troubleshooting
| Error code | Meaning | Recommended action |
|---|---|---|
| `AUTH_FAILED` | SQL Server rejected the configured login. | Verify `DB_USER` and `DB_PASSWORD`, then restart the API. |
| `DB_UNREACHABLE` | The SQL Server host or service could not be reached. | Check `DB_SERVER`, SQL Server availability, port exposure, and SQL Browser/service state. |
| `TIMEOUT` | The connection attempt or query exceeded the configured timeout. | Verify network/firewall rules and increase timeout values if needed. |
| `RATE_LIMITED` | API request volume exceeded the configured limit. | Increase `RATE_LIMIT_MAX`, widen `RATE_LIMIT_WINDOW_MS`, or reduce polling pressure. |
| `UNKNOWN_DB_ERROR` | The request failed, but not with a recognized auth/network/timeout signature. | Use the returned `traceId` and server logs to inspect the underlying SQL error. |

## Local verification
```bash
npm test
npm run lint
npm run build
npm start
```
