# MailVault

Automatically collects email attachments from Microsoft 365 mailboxes (Gmail later), filters them with
admin-defined rules and saves them to local or network folders, with a full history and audit trail.

**Stack:** Node.js 24 + TypeScript · Fastify · Prisma + PostgreSQL · pg-boss · React + Vite + Ant Design ·
Microsoft Graph (read-only `Mail.Read`) · IIS reverse proxy · Windows Task Scheduler.

## Project layout

```
apps/
  api/        Fastify REST API + serves the built admin panel (port 3200)
  worker/     Background processing: heartbeat, job queue, folder health (Phase 1: sync + downloads)
  web/        React admin panel (dev server on port 5180)
packages/
  shared/     zod schemas, enums, permission matrix (used by api, worker and web)
  core/       Pure logic: safe file names, folder patterns, provider interface (+ unit tests)
  db/         Prisma schema, migrations, seed scripts
  m365/       Microsoft Graph client and provider (immutable IDs, Retry-After handling, streaming)
scripts/      DB setup, keys, Windows service + IIS install
iis/          IIS web.config (HTTPS + reverse proxy)
docs/         ENTRA-SETUP.md (Microsoft 365 app registration)
tests/e2e/    Edge/Playwright screenshot script
```

## First-time setup (development)

```powershell
npm install
copy .env.example .env               # then fill DATABASE_URL password and run: npm run gen-keys
powershell -ExecutionPolicy Bypass -File scripts\setup-db.ps1 -SuperUser postgres
npm run db:deploy
npm run db:seed                      # default settings
npm run create-admin -- admin "<strong password>" "Your Name"
npm run db:seed-demo                 # optional: demo data for reviewing the UI (remove with -- --clear)
```

Run (three terminals):

```powershell
npm run dev:api       # http://127.0.0.1:3200
npm run dev:worker
npm run dev:web       # http://localhost:5180
```

## Useful commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | TypeScript check of every workspace |
| `npm run check:graph -- user@company.com` | Verifies Microsoft 365 access to a mailbox |
| `npm run check:share -- "\\server\share\path"` | Verifies the current account can write to a folder |
| `npm run db:migrate` | Create a migration after changing `schema.prisma` |
| `npx tsx tests/e2e/screenshots.ts` | Screenshots of every page (uses installed Edge) |

## Production on this server

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -WorkerAccount "CORP\svc-mailvault$"
powershell -ExecutionPolicy Bypass -File scripts\setup-iis.ps1 -HostName mailvault.company.local -CertThumbprint <thumb>
```

## Phase 0 status

| Item | Status |
|---|---|
| Monorepo, TypeScript, shared packages | Done |
| PostgreSQL `mailvault` database + schema v1 (all modules) | Done |
| API: login, dashboard, accounts, folders, rules, history, logs, users, settings, system status | Done |
| Worker: heartbeat, pg-boss queue, folder health checks with alerts | Done |
| Admin panel (all screens; Phase 2 screens shown as planned) | Done |
| `check:graph` / `check:share` commands | Done |
| Service + IIS install scripts | Done (not yet run) |
| Entra ID app, certificate, Exchange RBAC scope | **Needs M365 admin** (docs/ENTRA-SETUP.md) |
| Domain service account with share rights | **Needs IT** |
