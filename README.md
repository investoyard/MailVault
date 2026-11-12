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

**Phase 2 – Admin experience:**

| Item | Status |
|---|---|
| Mailbox search (Graph date-range search, paged) + fetch single message | Done |
| Rule Testing: live search, per-rule ✔/✘ explanation, "already processed" flags, manual download of selected files | Done (needs M365 to show real results) |
| "Test on the last 14 days" for an unsaved rule inside the rule editor | Done |
| Historical jobs: Simulate / Execute, include-processed, saved checkpoints, cancel & resume, completion notification | Done, integration-tested |
| History: Excel export (streamed), email details with live body, save a copy (path-guarded), bulk retry, status filter from links | Done |
| Live updates (Postgres LISTEN/NOTIFY → server-sent events → screens refresh) | Done |
| Low-disk-space alerts for destination folders | Done |
| Per-mailbox dashboard filter | Done |

**Phase 3 – Governance & operations:**

| Item | Status |
|---|---|
| Users: add / edit / disable, reset password, forced password change, self-service password change | Done |
| Roles + per-user permission overrides (module × action), Super Admin lock-out protection | Done |
| Mailbox scoping: users only see their assigned mailboxes in every screen and API (dashboard, rules, history, tests, jobs, exports) | Done, live-tested |
| Access re-checked on every request (disabled users / role changes apply within ~10 s) | Done |
| Alerts by email (SMTP) and Teams, per-user preferences (instant / daily summary / off, minimum severity), test email | Done (needs SMTP details / Teams webhook to go live) |
| Watchdog: "processing service stopped" raised by the API; repeated-failure alert; certificate-expiry alert (30 days) | Done, integration-tested |
| Nightly retention cleanup (keeps the per-rule match ledger so nothing re-downloads), audited | Done, integration-tested |
| Audit trail filters (user, action, date) + Excel export | Done |

**Phase 4 – Hardening & go-live:**

| Item | Status |
|---|---|
| Dependency audit: nodemailer 10, @fastify/static 10.1.10, uuid 11 (Prisma CLI accepted, see docs/SECURITY.md) | Done |
| Security headers + CSP, cross-site request guard, log redaction, password/secret policies | Done, verified on the production build |
| `npm run preflight` go-live readiness check | Done |
| Nightly verified backup (`scripts/backup-db.ps1`, `install-backup.ps1`) + restore check (`restore-db.ps1`) | Done, backup + restore drill passed |
| Failure drills (crash mid-download, share offline, throttling) | Done, automated tests |
| Load test (`npm run loadtest -w @mailvault/worker`): 20 mailboxes × 250 emails | Pass: 5,000 emails, 4,500 files, 0 duplicates, 331 MB peak |
| Docs: GO-LIVE checklist + UAT, SECURITY, ADMIN-GUIDE, USER-GUIDE (+ PDFs in docs/) | Done |
| Install services / IIS / backup task on this server, pilot | **Waiting for IT items + your go-ahead** |

**Phase 5 – Enhancements (started):**

| Item | Status |
|---|---|
| Prisma 6 → 7.10.1 (driver adapter, `prisma.config.ts`) – `npm audit` now clean | Done |
| Unpack ZIP files and attached emails (.eml/.msg) per rule, zip-bomb safe, per-file history | Done, unit + integration tested |
| Outbound webhooks (file.saved / file.failed / job.completed), signed, retries, delivery log, Integrations screen | Done, integration + live tested |
| Graph change notifications, SharePoint/OneDrive destinations, Gmail, AI classification | Not started |

Integration tests: `npm run test:integration -w @mailvault/worker` (uses database `mailvault_test`).
PDF of any doc: `npx tsx scripts/md-to-pdf.ts docs/ENTRA-SETUP.md`.
