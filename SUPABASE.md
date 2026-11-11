# Supabase PostgreSQL connection

TaskFlow uses Supabase as managed PostgreSQL through Prisma. Express continues to handle authentication, sessions, authorization and Socket.IO. Supabase Auth/server SDK keys are not needed for this database-only connection; never put database credentials in the frontend.

1. Keep credentials in ignored `backend/.env.supabase`. Use your project's transaction pooler (6543) for `DATABASE_URL` and session pooler (5432) for `DIRECT_URL`. Percent-encode special characters in the password.
2. Use `schema=taskflow` so application tables, including password hashes and sessions, are separate from the default public Data API schema. Do not add `taskflow` to Supabase's exposed API schemas.
3. The tracked `certs/supabase-ca.crt` is a public Supabase CA certificate, not a secret. Both connection strings use `sslmode=verify-full&sslrootcert=certs/supabase-ca.crt`; certificate/hostname verification remains enabled.
4. Run `npm run db:connect:supabase` from the backend directory. It authenticates first, creates/protects the `taskflow` schema, applies existing migrations without resetting data, verifies Prisma reads through the runtime pooler, and then updates the active ignored `.env`. Authentication/migration failures leave the active `.env` unchanged.
5. The helper retains the previous local configuration in ignored `.env.before-supabase` and adds a local `TEST_DATABASE_URL` so tests do not touch the cloud database. It does not copy local accounts or seed demo data into Supabase.
6. Restart `npm run dev`, then run `npm run db:check` and open `http://localhost:4000/health`. Register a new account to start using the cloud-backed workspace. Web, desktop and mobile still communicate with the same Express API.
7. `npm run db:verify` checks Prisma writes, assignments, status updates and reads inside a transaction which is deliberately rolled back. No probe account or tasks are retained.

For local test migrations while Supabase is active, set **both** `DATABASE_URL` and `DIRECT_URL` to the local test database for that command. `npm test` always uses the guarded local `TEST_DATABASE_URL`; it does not run cloud migrations or use the cloud database.

To diagnose before activating: `node --env-file=.env.supabase --import tsx scripts/check-database.ts`. A successful network/TLS check is not a successful database login. `28P01` means Supabase rejected the database credentials; reset the database password in the dashboard and update both ignored URLs.

Prisma CLI uses `DIRECT_URL` (or legacy `DIRECT_DATABASE_URL`) for migrations. Runtime Prisma uses `DATABASE_URL`, including its explicit schema. On Render configure the same variables and tracked CA path through provider secrets; do not commit populated environment files.

`db:check` reports client TLS verification separately from `pg_stat_ssl`, which reflects Supabase's internal pooler-to-database connection. The verified client link succeeded; the upstream pooler connection currently reports TLS disabled. Supabase controls that upstream link. The schema access check confirms that the `anon` and `authenticated` Data API roles lack usage of TaskFlow's schema.

References: [Supabase Prisma guide](https://supabase.com/docs/guides/database/prisma), [PostgreSQL SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement), [Data API security](https://supabase.com/docs/guides/api/securing-your-api).
