# Contributing

## Setup
1. Run `npm install` from the repository root.
2. Copy `.env.example` to `.env` and fill in SQL Server access.
3. Enable the shared hooks once per clone:
   ```bash
   git config core.hooksPath .githooks
   ```

## Daily workflow
- Use `npm start` for the backend.
- Use `npm run dev` when editing frontend assets.
- Run `npm run lint`, `npm test`, and `npm run build` before opening a PR.

## Dependency and lockfile policy
- Commit `package-lock.json` with every dependency change.
- Keep installs deterministic by leaving `.npmrc` in place and using `npm install`/`npm ci`.
- Prefer patch/minor upgrades unless a major version is required for the task.

## Code review guidelines
- Keep PRs focused and small.
- Include validation notes for lint, tests, and builds.
- Call out environment or SQL Server assumptions in the PR description.
