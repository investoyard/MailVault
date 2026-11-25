# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What MailVault is

A centralized system that monitors Microsoft 365 mailboxes (Gmail later), matches emails against
admin-defined rules, and saves matching attachments to local or UNC folders, with full history,
notifications, users/roles and audit logs. Runs on the company's Windows Server 2022.

## Stack (matches the team's other projects; do not switch to .NET / SQL Server / NestJS)

- Node.js 24, TypeScript (strict), npm workspaces, `tsx` to run TS directly (no build step for server code)
- API: **Fastify 5** + `@fastify/jwt` (httpOnly cookie `mv_session`) + `@fastify/cookie` + `@fastify/static`
- DB: **PostgreSQL 16** on the shared server, port **5433**, database/role `mailvault`; **Prisma 7.10** with `@prisma/adapter-pg` (URL in `packages/db/prisma.config.ts`, not in schema.prisma)
- Jobs: **pg-boss 12** (queues live in schema `pgboss` of the same DB; no Redis on Windows)
- Microsoft Graph via plain `fetch` + `@azure/identity` (certificate preferred); read-only `Mail.Read`
- Web: React 19 + Vite 7 + **Ant Design 5** (+ `@ant-design/v5-patch-for-react-19`) + TanStack Query + Recharts
- Validation: **zod 4** schemas in `packages/shared`, used by API and web
- Tests: Vitest; UI screenshots via `playwright-core` with the installed **Edge** (`channel: 'msedge'`)
- Files: **qpdf** CLI (PDF passwords, `QPDF_PATH`), **@zip.js/zip.js** (protected ZIPs), yauzl/mailparser/msgreader (unpacking),
  installed **Edge** via playwright-core in the worker (email to PDF)
- Hosting: website/API in IIS via **iisnode** (site path iisnode/, entry iisnode/server.cjs, PORT = named pipe); Worker as Windows Task Scheduler task (scripts/install-service.ps1). Alternative: IIS reverse proxy (iis/) + install-service -IncludeApi

## Layout

```
apps/api      Fastify API (src/routes/*), also serves apps/web/dist in production
apps/worker   Background service: pg-boss jobs, mailbox sync, rule matching, downloads, folder health
apps/web      React admin panel (pages/, components/ui.tsx, layout/AppLayout.tsx, theme.ts)
packages/shared  enums, zod schemas, permission matrix (browser-safe)
packages/core    pure logic: rule engine, attachment filter, file names, path patterns, email-html (browser-safe)
packages/core/src/node  Node-only helpers (folder check/browse, safe file writer, extract, unlock) -> import "@mailvault/core/node"
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
npm run preflight [-- --graph]               # go-live readiness check (exit 1 = blockers)
npm run loadtest -w @mailvault/worker        # load test on mailvault_test
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

- Store email **metadata only**, never bodies (the email-PDF feature fetches the body at save time and writes it only into
  the PDF). Stream attachments to disk; never buffer whole files.
- Write files to `<folder>\.mailvault-tmp\*.part`, then move into place (no half-written files).
- Sanitize every file/folder name with `sanitizeFileName`; pattern tokens via `renderPattern`.
  File names only via `buildFileName` (core/src/path-pattern.ts, shared by worker + rule editor preview): the pattern is the
  name *without* extension, the original extension is appended once (`{OriginalName}` in a longer pattern = base name,
  trailing `{Ext}` dropped). Date tokens: `{Date:<fmt>}` = received date, `{Today:<fmt>}` = save date (`ctx.now`),
  fmt parts `yyyy yy MMMM MMM MM M dd d HH mm ss` + `- _ . space ,`; `{FY}`/`{FYQuarter}` = Indian April–March year.
  New tokens go in `PATTERN_TOKENS` + `PATTERN_TOKEN_HELP`; `unknownTokens()` drives the editor's validation.
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
- Live site: http://mailvault.finwave.co (IIS + iisnode); worker = Task Scheduler task MailVault-Worker running as
  `FINWAVE-WEB\finwave` (stored password; since 2026-11-25, for UNC shares such as `\\192.168.2.111\aif-ifsc`).
  The server is in a WORKGROUP: SYSTEM reaches other machines as anonymous, so shares need a real user account with Modify rights.
  Reinstall/password change (admin PowerShell, in-process, not `powershell -File`, which turns the SecureString into text):
  `Set-ExecutionPolicy -Scope Process Bypass -Force; .\scripts\install-service.ps1 -WorkerAccount "FINWAVE-WEB\finwave" -WorkerPassword (Read-Host -AsSecureString)`.
  Running it without -WorkerAccount reverts to SYSTEM. If the Finwave password changes, the worker won't start until reinstalled.
  qpdf lives in `D:\Investoyard\.tools\qpdf` (next to pgsql); `.env` has `QPDF_PATH=D:/Investoyard/.tools/qpdf/bin/qpdf.exe`.
- Shell pitfalls here: Git Bash heredocs/printf and `node -e` strings eat backslashes (`\b` became a backspace in .env):
  write Windows paths with forward slashes, and do multi-line source edits with the Edit/Write tools or a script file.
  `git stash` round-trips rewrite files with CRLF; normalise line endings (`.replace(/\r\n/g, '\n')`) before string-matching in scripts.
- Integration tests that pin `ctx.now` to a fixed clock must derive times from that clock, never from `Date.now()`.

## Status

- Phase 0 (foundation): done. Entra app registration + share service account pending with IT (docs/ENTRA-SETUP.md).
- Phase 1 (core engine): engine, pipeline, rule editor done; SSO + delegated mailbox sign-in wait for the Entra app. See README "Phase status".
- Phase 2 (admin experience): Rule Testing, historical jobs, history export/details/save-copy/bulk retry, live updates done; per-mailbox dashboard filter open.
- Phase 3 (governance): users/roles/permission overrides, mailbox scoping, email/Teams alerts + prefs + digest, watchdog, cert-expiry, cleanup, audit export done.
- Phase 4 (hardening): CSP/headers + Origin guard in apps/api/src/server.ts, npm run preflight, backup/restore scripts, drills + load test, docs/GO-LIVE.md, SECURITY.md, ADMIN-GUIDE.md, USER-GUIDE.md. Remaining: install on server + pilot (needs IT).
- Prisma 7: `prisma migrate dev` no longer runs generate; the npm scripts `db:migrate`/`db:deploy` run `prisma generate` afterwards. Prisma no longer reads .env itself (prisma.config.ts and src/load-env.ts load it).
- Phase 5: ZIP/attached-email extraction (core/src/node/extract.ts, ExtractedFile model), outbound webhooks (packages/db/src/webhooks.ts, Integrations page, docs/WEBHOOKS.md).
- Phase 6 (done, live, checked by the user): folder picker + worker-run folder tests, Sync History, date tokens/file-name
  patterns, password removal for PDF/ZIP, email saved as PDF, rule editor as a full page. Mailbox access via Exchange RBAC.
- Windows PowerShell 5.1 strips double quotes from native args: pass SQL to psql via a temp file (-f), as restore-db.ps1 does.
- Access control: requireAuth loads role/permissions/mailboxIds from DB per request (10 s cache, invalidateAccess on change). Use mailboxScope()/assertMailbox() in every route touching mailbox data.
- Alerts/delivery live in packages/db/src/ops.ts (raiseAlert, resolveAlert, dispatchPending, sendDailyDigest); API watchdog (apps/api/src/watchdog.ts) also dispatches so alerts go out when the worker is down.
- Live updates: worker calls notifyChange() -> pg_notify('mailvault_events') -> API /api/events (SSE) -> web invalidates queries.
- Worker runs under apps/worker/src/supervisor.mjs (`npm start`): exit code 75 = restart now, crash = restart with backoff. System Status → Restart worker -> POST /api/system/worker/restart (system:execute) -> pg-boss queue `worker-control`.
- Destination picker: core/src/node/folder-browse.ts (browse/test/mkdir, system folders blocked, Setting `destinations.browseRoots`). The API sends these to the worker via pg-boss queue `folder-ops` (notify) and waits for the job output (apps/api/src/folder-ops.ts), so checks use the worker's Windows account; falls back to the API when no worker is online.
- iisnode/web.config removes WebDAV, which otherwise answers PUT/DELETE with 405 in IIS.
- Mailbox access = Exchange RBAC for Applications (not tenant-wide Mail.Read): service principal + scope "MailVault Mailboxes"
  on mail-enabled security group `MailVault-Monitored` + role "Application Mail.Read". New mailboxes: add them to that group in
  the Exchange admin center (steps shown in AccountsPage `MailboxAccessSteps`). Diagnose/repair: scripts/check-exchange-rbac.ps1 [-Fix]
  (run by the tenant admin; never sign in for the user).
- Sync History (Monitoring): GET /api/sync-runs (apps/api/src/routes/sync-runs.ts, permission module `syncHistory`) over `SyncRun`
  (`newMessages` stored by worker pipeline/sync.ts); no finish time after 15 min = STOPPED.
- Password removal (rule `download.unlockProtected`): core/src/node/unlock.ts. PDFs via qpdf (`QPDF_PATH`, installed at
  D:\Investoyard\.tools\qpdf; password through stdin, `--deterministic-id` so Smart duplicates still match); ZIPs via zip.js,
  re-packed without password (inner PDFs unlocked too). Passwords: `Rule.filePasswords` (encryptSecret JSON array) + `filePasswordCount`;
  sent as `filePasswords` next to the rule body (undefined = keep), never in rule JSON/versions/audit, API omits the column.
  Result in `AttachmentDownload.protection` / `ExtractedFile.protection`; STILL_LOCKED keeps the original, raises alert `UNLOCK:<ruleId>`,
  and Retry (allowed for SUCCESS+STILL_LOCKED) replaces that exact file.
- Email as PDF (rule `download.emailPdf` OFF/ALSO/ONLY): evaluate.ts adds a synthetic Attachment (kind EMAIL_BODY, providerAttachmentId
  `EMAIL_PDF_ATTACHMENT_ID`) so the normal download queue/history/retry/webhooks handle it; other rules never see that row.
  download.ts fetches `getEmailContent` (GET only, body not stored), core/src/email-html.ts sanitizes + builds HTML (CSP), worker
  pipeline/email-pdf.ts renders with installed Edge via playwright-core (JS off, network blocked, shared browser, max 2 parallel).
  Historical jobs include emails without attachments when a selected rule saves email PDFs.
- Rule editor is a page, not a drawer: routes /rules/new and /rules/:id (pages/RuleEditorPage.tsx -> components/RuleEditor.tsx).
  The form is filled once per rule (background refetches must not reset it); Back/Cancel compare values with a snapshot and confirm.
- Deploy on this server: `npm run build:api && npm run build:web`, touch `iisnode/restart.txt` (never commit it), restart the worker
  via POST /api/system/worker/restart. Schema changes: write the migration SQL, then `npm run db:deploy`.
