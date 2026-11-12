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

## Phase status

**Phase 0 – Foundation:** done (Entra app registration + share service account pending with IT, see docs/ENTRA-SETUP.md).

**Phase 1 – Core engine:**

| Item | Status |
|---|---|
| Rule engine (sender/recipient/CC/subject/keywords/body/date, exclude wins, match explanation) | Done, unit-tested |
| Attachment filter (types, names, sizes, inline, blocked, cloud links, encrypted, .eml for attached mails) | Done, unit-tested |
| Safe file writer (temp file + SHA-256 + atomic move; Skip/Replace/Rename/Smart duplicates) | Done, unit-tested |
| Microsoft Graph delta sync per folder, body text, folder list, streamed attachments | Done (not yet run against a real tenant) |
| Worker pipeline: scheduler → sync → rule matching → downloads, retries with backoff, wait-for-folder, alerts | Done, integration-tested with a fake mailbox |
| Rule editor (create/edit with versions, live save-path preview), Sync now, monitored folders, retry/manual download | Done |
| Microsoft SSO for admin users, per-user (delegated) mailbox sign-in | **Waiting for the Entra app registration** |

Integration tests: `npm run test:integration -w @mailvault/worker` (uses database `mailvault_test`).
