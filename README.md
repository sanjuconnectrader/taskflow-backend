# TaskFlow Backend

Node.js 22 / Express 5 / TypeScript / Prisma 7 / PostgreSQL. Shared backend for TaskFlow web, desktop and Android. No SMTP dependency.

## Local development

1. Install Node 22.14+, Git and PostgreSQL 17+. Create a database role and start PostgreSQL on port 5432.
2. `npm ci`. Copy `.env.example` to `.env` only on a fresh clone. Set `DATABASE_URL` privately, including your own local password. The original workspace already contains an ignored `.env` configured for the requested local account.
3. `npm run db:generate`.
4. For a fresh local setup, `node --import tsx scripts/setup-local.ts`. It creates `taskflow`/`taskflow_test` without replacing existing databases and generates a local seed password in `.env`. This helper only permits the local `taskflow` database name. Alternatively provision databases manually.
5. `npm run db:migrate` applies checked-in migrations.
6. Optional: set `NODE_ENV=development` and `SEED_PASSWORD` (≥12 characters) in `.env`, then `npm run db:seed`. The helper generates a random one if absent. Demo email: `emma@taskflow.local`. Production seed execution is rejected.
7. `npm run dev`; API http://localhost:4000, health `/health`, interactive docs `/docs`.

On Windows PowerShell use `npm.cmd` / `npx.cmd` if scripts are blocked. Keep the API running while working in other client repositories. Clients point at `NEXT_PUBLIC_API_URL`, which is the API origin without `/api/v1`.

## Source map

- `src/auth.ts`: registration, email login, sessions, profile and administrator recovery.
- `src/security.ts`: opaque-session hashing, CSRF and workspace roles.
- `src/workspaces.ts`: scoped workspace/project/task CRUD, comments, search, activity and notifications.
- `src/reports.ts`: server-calculated metrics and CSV output.
- `src/files.ts`: private S3 signed upload/download and content checks.
- `src/app.ts`, `src/server.ts`: Express/Socket.IO setup and process lifecycle.
- `src/reminders.ts`: idempotent UTC deadline job.
- `prisma/`: schema, versioned PostgreSQL migrations and explicit development seed.
- `scripts/`: local database setup, protected operator bootstrap and Render deploy helper.
- `tests/`: security and real-database integration coverage.

All workspace members can see their workspace's projects/tasks. Viewers cannot change collaborative data. Owners/Admins manage projects and members; only owners change roles/settings/delete a workspace. Personal workspaces make account recovery an operator responsibility in most cases. See [API.md](API.md) for exact rules and payloads.

## Validate and build

Migrate `taskflow_test` before tests. Set `DATABASE_URL` temporarily to the test URL for `npm run db:migrate`, then restore the development URL. Tests themselves force a **local** `taskflow_test` database and clean the users/workspaces they create. Never point tests at production.

```text
npm test
npm run build
npm start
```

No production seed runs during build or start. `npm ci` uses the committed lockfile. `npm run reminders` should run from one scheduler, not every API process. WebSocket invalidation supports one API instance; distributed deployment requires a Redis adapter/rate limiter.

## Production

See [DEPLOYMENT.md](DEPLOYMENT.md). Render uses a managed PostgreSQL connection with certificate-validating TLS. Set CORS to exact web/native origins. Prefer `app.example.com` and `api.example.com` for same-site cookies. GitHub tag workflow validates against a disposable PostgreSQL service, waits for the production environment gate and deploys the exact commit through Render's API. Configure secrets and GitHub approval rules before tagging. Provision S3 privately; unconfigured storage returns a clear unavailable response.

The current session lifetime is 30 days with explicit revocation; background rotation is a follow-up. No complete offline synchronization, private-project ACL, production malware scanner or multi-instance realtime behavior is claimed.
