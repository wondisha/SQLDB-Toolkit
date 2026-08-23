# Architecture

SQLDB Toolkit uses a small Express backend (`src/server.js`) to execute SQL Server diagnostics through the shared database layer in `src/lib/db.js`. The browser client lives in `frontend/` and is served either from the checked-in `public/` assets or from a Vite production build in `dist/` when that folder exists.

## Runtime flow
- Browser requests dashboard metadata and query results over `/api/*`
- Express applies CORS, rate limiting, compression, and static asset cache headers
- The database module manages pooled SQL Server connections and normalizes DB errors
- Cached read-only query responses reduce repeated load for slower diagnostic panels

## Delivery flow
- `npm run dev` starts a Vite dev server for frontend work
- `npm run build` creates a minified production bundle with source maps in `dist/`
- GitHub Actions runs lint, tests, build, audit, and CodeQL on repository changes
