# Performance

- Production frontend assets are built with Vite, minified, and emitted with source maps.
- Express enables gzip compression for API and static responses.
- Static JavaScript and CSS responses receive browser cache headers.
- Expensive read-only SQL panels use short-lived in-memory caching; add `?refresh=1` to bypass cache during troubleshooting.
- Tune `DB_POOL_MAX_SIZE` and `QUERY_CACHE_TTL_MS` based on dashboard concurrency.
