# Delivery verification — 11 November 2026

## Observed locally

- PostgreSQL 17 running on localhost; requested credential stored only in ignored backend `.env`.
- Initial migration applied to `taskflow` and isolated `taskflow_test`.
- Explicit development seed created 5 users, 3 projects and 16 persisted tasks; no production seeding.
- Backend TypeScript/Prisma build passed; 13 security/database integration tests passed.
- Next.js production static export and TypeScript check passed; 2 component tests passed.
- Two real-API Playwright workflows passed at desktop and Pixel viewport sizes: registration, project/task creation, completion persistence after reload, calendar navigation and overflow checks.
- Data-loaded dashboard screenshots captured at 1448px and 430px; no page errors or horizontal overflow.
- Electron path traversal test passed. Bounded startup passed. UI smoke rendered the bundled frontend, confirmed Node isolation and native bridge boundaries, and verified encrypted session write/read/clear.
- Windows NSIS installer generated. No Windows signing certificate is configured; installer is unsigned.
- Capacitor Android configuration tests passed. JDK 21/SDK 36 Gradle release and debug builds passed. Release signing key is retained in ignored local files. APK signature verification is performed before publication.
- Four private repositories created and pushed under `sanjuconnectrader`. The first main-branch Actions validation passed in all four. Dependabot PRs are separate from the validated main commits.
- Staged-file scan rejects local database/seed/signing secrets, native keys, generated client assets, dependencies and build outputs.

## Release semantics

Downloadable files use a clearly marked local prerelease, not a production deployment. Windows calls the local API by default. Android release requires an operator HTTPS API configured on the login screen. The separate `.dev` debug package can use `adb reverse` with the local API. All clients can use one shared API/database.

## Not verified / not completed

- No Render/Vercel production service or domain is deployed; the user requested repository/source and downloadable apps without hosting setup.
- GitHub billing plan rejected required-reviewer protection (HTTP 422). Production workflow preflight fails closed without that protection. Deployment credentials and a narrowly scoped cross-private-repository frontend read token still need owner configuration.
- No physical Android device/emulator was connected for native flow verification; browser responsiveness and successful APK compilation do not establish device QA. Android KeyStore runtime behavior requires device testing.
- Windows installer creation and Electron UI startup were tested; installing/uninstalling the NSIS package on a separate clean Windows machine has not been tested.
- Private S3 upload/download configuration and end-to-end storage tests need a configured bucket. Server code implements scoped signed URLs, size/MIME/magic-byte checks and publishes confirmed uploads under a separate immutable-to-the-upload-URL key. Antivirus scanning is not implemented.
- Offline mutation queues, background session rotation, native push, native OS task deep links, auto-updates, iOS Keychain/native build, project-private ACLs, avatar/logo uploading and advanced calendar rescheduling are follow-ups.
- Dashboard/board/calendar previews load the first 100 tasks with a visible limit notice; My Tasks is paginated, while reports query all matching database tasks. Full large-workspace server-side aggregations and filtering should be optimized before scaling.
- Reports use a creation-date range and current task state; full historical state comparisons are not recorded. Metrics deliberately do not invent previous-week percentages.
- Workspace-wide project visibility is the implemented permission model; per-project membership restrictions are not implemented.
- Ordinary workspace admins cannot recover accounts that own/administer another workspace. Because registration creates a personal owner workspace, most account recovery requires a protected platform operator.
- OpenAPI covers core routes; API.md is the complete implemented inventory. Deployment workflows are configured but real production deployments/releases through those workflows have not run.
- Desktop build tooling currently has 6 moderate transitive minimatch advisories; frontend/backend/mobile audits reported no vulnerabilities at the last dependency installation. No high/critical runtime advisory is knowingly left unresolved. Re-audit as versions change.

This is a working cross-platform local release with documented production setup and remaining product work, not a claim that every item in the extensive attached specification has passed production acceptance.
