# SQLDB Toolkit — Live Monitoring Dashboard

A live dashboard for [wondisha/SQLDB](https://github.com/wondisha/SQLDB), a collection of SQL
Server DBA scripts. It has two parts:

- **backend/** — a small Node.js/Express API that holds real connections to your SQL Server
  instance(s) and runs the repo's diagnostic queries on demand (browsers can't open a raw SQL
  Server connection directly, so this piece is required).
- **frontend/** — a static HTML/JS dashboard that polls the API and renders the results:
  wait stats, blocking chains, AG replica/sync health, index fragmentation, backup freshness,
  failed jobs, and more — one panel per script in the repo.

Every query the API runs is copied verbatim from the repo's `.sql` files (see the `script`
field shown in each panel's header) — nothing was rewritten, so what you see matches what
you'd get running the scripts yourself in SSMS.

Only **read-only, diagnostic** scripts are wired up (everything under `performance/`,
`index-maintenance/` [reports only, not the installer], `monitoring/`, `dba-dev-handbook/`,
`health-check/`, and the AG health *dashboards*). Nothing that writes, alters indexes, creates
SQL Agent jobs, or repairs SIDs is included — those stay manual, on purpose.

## 1. Set up the backend

```bash
cd backend
npm install
cp .env.example .env   # then edit .env with your instance details
```

**One instance:** just fill in `.env`.

**Multiple instances** (e.g. an AG primary + secondaries, matching what
`central-monitor/` would otherwise collect from each node): copy
`servers.example.json` to `servers.json` and list each one. When `servers.json`
exists it takes priority over `.env`.

The account you connect with should be read-only-oriented; per the repo's own README, most
panels need `VIEW SERVER STATE`, and the backup/job panels need read access to `msdb`. No
`sysadmin` or write permissions are required for anything this dashboard runs.

Start the API:

```bash
npm start
```

It listens on `http://localhost:4000` by default (change `PORT` in `.env`).

## 2. Open the frontend

The frontend is plain HTML/CSS/JS with no build step. Easiest options:

```bash
cd frontend
python3 -m http.server 5173
# then open http://localhost:5173
```

or just open `frontend/index.html` directly in a browser.

If your API isn't on `http://localhost:4000`, set it before `app.js` loads by adding this to
`index.html` above the `<script src="app.js">` tag:

```html
<script>window.SQLDB_API_BASE = "http://your-api-host:4000";</script>
```

## What each panel does

| Category | Panels | Source |
|---|---|---|
| Health Check | wait profile, active blockers, backup freshness, failed jobs (24h), tempdb top sessions, long-running transactions | `health-check/01_dashboard_query_pack.sql` |
| Performance | top resource-consuming queries, missing index recommendations, statistics health | `performance/01-03*.sql` |
| Index Maintenance | fragmentation report, reorganize/rebuild command generator | `index-maintenance/01-02*.sql` |
| Blocking & Deadlocks | current blocking chains, wait stats snapshot, deadlock report (from system_health XE) | `monitoring/blocking-deadlocks/01-03*.sql` |
| DBA/Dev Handbook | file size & growth, backup freshness, failed jobs (7d), tempdb by session, long-running transactions | `dba-dev-handbook/01-05*.sql` |
| AG Health | replica dashboard, database sync status, listener & routing, failover readiness, recent AG errors | `ag-health/01-05*.sql` |

Panels that use `DB_ID()`/`OBJECT_ID()` (missing indexes, stats health, index fragmentation) run
in the context of whatever database you pick in the top bar's **Database** selector — everything
else reads server-scoped DMVs and works regardless of which database the connection lands on.

## Notes

- Auto-refresh interval is set globally in the top bar (default 15s); each panel also has a
  manual **run** button.
- The wait-stats and blocking-chain panels get a custom visual (ranked bars / indented tree);
  everything else renders as a sortable-by-eye table with color-coded status badges.
- The deadlock report and AG error panels depend on the `system_health` Extended Events session
  being enabled (it is, by default, on SQL Server 2016+).
