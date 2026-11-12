# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What MailVault is

A centralized system that monitors Microsoft 365 mailboxes (Gmail later), matches emails against
admin-defined rules, and saves matching attachments to local or UNC folders, with full history,
notifications, users/roles and audit logs. Runs on the company's Windows Server 2022.

## Stack (matches the team's other projects; do not switch to .NET / SQL Server / NestJS)

- Node.js 24, TypeScript (strict), npm workspaces, `tsx` to run TS directly (no build step for server code)
- API: **Fastify 5** + `@fastify/jwt` (httpOnly cookie `mv_session`) + `@fastify/cookie` + `@fastify/static`
- DB: **PostgreSQL 16** on the shared server, port **5433**, database/role `mailvault`; **Prisma 6** (stay on 6.x)
- Jobs: **pg-boss 12** (queues live in schema `pgboss` of the same DB; no Redis on Windows)
- Microsoft Graph via plain `fetch` + `@azure/identity` (certificate preferred); read-only `Mail.Read`
- Web: React 19 + Vite 7 + **Ant Design 5** (+ `@ant-design/v5-patch-for-react-19`) + TanStack Query + Recharts
- Validation: **zod 4** schemas in `packages/shared`, used by API and web
- Tests: Vitest; UI screenshots via `playwright-core` with the installed **Edge** (`channel: 'msedge'`)
- Hosting: IIS reverse proxy -> Node on 127.0.0.1:3200; background apps via Windows Task Scheduler

## Layout

```
apps/api      Fastify API (src/routes/*), also serves apps/web/dist in production
apps/worker   Background service: pg-boss jobs, mailbox sync, rule matching, downloads, folder health
apps/web      React admin panel (pages/, components/ui.tsx, layout/AppLayout.tsx, theme.ts)
packages/shared  enums, zod schemas, permission matrix (browser-safe)
packages/core    pure logic: rule engine, attachment filter, file names, path patterns (browser-safe)
packages/core/src/node  Node-only helpers (folder check, safe file writer) -> import "@mailvault/core/node"
packages/db      Prisma schema + migrations + seeds; exports `prisma`
packages/m365    Graph client + M365Provider
```

Workspace packages export TS source directly (`"main": "src/index.ts"`); imports use `.js` suffixes.

## Commands

```bash
npm run dev:api | dev:worker | dev:web      # 3200 / background / 5180 (Vite proxies /api)
npm test                                     # unit tests (all workspaces)
npm run test:integration -w @mailvault/worker  # pipeline test against DB mailvault_test
npm run typecheck                            # tsc --noEmit in every workspace
npm run db:migrate -- --name <name>          # after editing schema.prisma (dev)
npm run db:deploy | db:seed | db:seed-demo [-- --clear]
npm run check:graph -- user@company.com      # M365 access check
npm run check:share -- "\\server\share"      # write-access check
npx tsx tests/e2e/screenshots.ts [outDir]    # screenshots of every page (needs api + web running)
npx tsx scripts/md-to-pdf.ts <file.md> [out.pdf]  # styled PDF of a doc via Edge
```

## Business rules that code must keep

1. Each email is processed **once per rule** — unique `(messageId, ruleId, runNumber)`; reprocessing = new runNumber, explicit.
2. Duplicate files follow the rule's policy: SKIP / REPLACE / RENAME / SMART (hash-compare; default).
3. One email may match several rules; `priority` ascending; `stopFurtherRules` ends evaluation.
4. Keep original attachment names unless a file-name pattern is configured.
5. Failures get a meaningful, admin-readable message (see `explainGraphError`, `explainFsError`).
6. **Never modify mail**: only `Mail.Read`, only GET requests to Graph.
7. Everything traceable: `correlationId` on matches/sync runs, `ProcessingLog`, `AuditLog` for every admin change.
8. Rule edits apply to future mail only: rules carry `effectiveFrom`; each edit snapshots a `RuleVersion`.
9. Mailboxes have `monitoringStartAt`; older mail only through explicit historical jobs.
10. Rules are disabled, not deleted.

## Conventions

- Store email **metadata only**, never bodies. Stream attachments to disk; never buffer whole files.
- Write files to `<folder>\.mailvault-tmp\*.part`, then move into place (no half-written files).
- Sanitize every file/folder name with `sanitizeFileName`; pattern tokens via `renderPattern`.
- Dates for folders/"today" use the business time zone (`BUSINESS_TIMEZONE`, default Asia/Kolkata).
- API: every route has a `requirePermission(module, action)` guard; validate input with zod; write `audit()`.
- UI: light theme, Ant Design components, `PageHeader` + `mv-card` cards, friendly empty states, plain-English labels.
- Prisma `BigInt` columns are serialized as numbers (patched in `apps/api/src/env.ts`).

## Environment gotchas

- Postgres on 5433 uses `trust` for localhost; superuser `postgres`. psql: `D:\Investoyard\.tools\pgsql\bin\psql.exe`.
- npm install on this server once wrote a truncated file (`bn.js`); if tsx fails with "Unexpected end of file" inside
  node_modules, delete that package folder and re-run `npm install`.
- The Claude built-in browser pane cannot open localhost here; use `tests/e2e/screenshots.ts` for visual checks.
- `.env` holds DB password, `JWT_SECRET`, `SECRET_ENC_KEY`, `DEV_ADMIN_PASSWORD`; never commit it or print secrets.
- Windows services can't see mapped drives: destinations must be local paths or UNC.

## Status

- Phase 0 (foundation): done. Entra app registration + share service account pending with IT (docs/ENTRA-SETUP.md).
- Phase 1 (core engine): engine, pipeline, rule editor done; SSO + delegated mailbox sign-in wait for the Entra app. See README "Phase status".
- Phase 2 (admin experience): Rule Testing, historical jobs, history export/details/save-copy/bulk retry, live updates done; per-mailbox dashboard filter open.
- Live updates: worker calls notifyChange() -> pg_notify('mailvault_events') -> API /api/events (SSE) -> web invalidates queries.
