# MailVault security overview

Prepared for review by IT / information security. Status as of the Phase 4 review.

## Data and access to mail

| Topic | Control |
|---|---|
| Mailbox access | Microsoft Graph, **`Mail.Read` only** (read-only). Only HTTP GET requests are made to Graph. Emails are never moved, marked, changed or deleted. |
| Which mailboxes | Exchange **RBAC for Applications** scope: the app can read only members of the *MailVault-Monitored* group. No tenant-wide grant in Entra ID. |
| App credential | Certificate (private key on the MailVault server only, folder ACL limited to Administrators + service account). Expiry alert 30 days ahead. |
| What is stored | Email **metadata** (sender, recipients, subject, dates) and attachment metadata/hashes. **Email bodies are never stored**; "View email" reads the body live. |
| Files | Written to temp + atomically moved; names sanitised (no path traversal, reserved names); blocked file types (exe, js, vbs, ps1, …) never saved; size limit. |

## Application security

| Topic | Control |
|---|---|
| Sign-in | Local accounts with bcrypt (cost 12) password hashes; 10+ characters with letters and numbers; lock-out after 8 failed attempts (15 min). Microsoft SSO planned once the Entra app exists. |
| Session | Signed JWT in an **HttpOnly, SameSite=Strict** cookie (`Secure` when served over HTTPS), 10-hour lifetime. |
| Authorisation | Every API route checks the module × action permission on the server. Role, permissions, active status and mailbox assignments are re-read from the database on each request (≤10 s cache), so disabling a user takes effect immediately. |
| Data scoping | Non-Super-Admins only see data of assigned mailboxes in every screen, export and API; requests for other mailboxes return 404. |
| Cross-site requests | SameSite=Strict cookie **plus** an Origin check that rejects state-changing requests from other sites. |
| Browser hardening | Content-Security-Policy (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy; HSTS via IIS. API responses `Cache-Control: no-store`. |
| Input | All input validated with zod schemas; 1 MB request limit; parameterised SQL only (Prisma). |
| File download from UI | Only files MailVault wrote, and only inside that rule's destination folder (path is checked). |
| Logging | Cookies, authorisation headers and password fields are redacted from logs. |
| Audit | Every sign-in (and failed sign-in), change, export, file download and cleanup is written to an append-only audit trail with before/after values, exportable to Excel. |
| Secrets | `.env` (DB password, JWT secret, encryption key, SMTP password, Teams URL) is excluded from git; the SMTP password and Teams URL are not stored in the database. |

## Operations

| Topic | Control |
|---|---|
| Availability | Background tasks restart automatically; the API raises "processing service stopped" if the worker's heartbeat stops; downloads stuck after a crash are recovered at start-up. |
| Backups | Nightly verified `pg_dump` (14 days kept) + restore check script; `.env` and certificate to be backed up separately. |
| Retention | Logs and download details are purged after the configured periods; the per-rule "already processed" ledger is kept so nothing is downloaded twice. |

## Dependency review

`npm audit --omit=dev` after the Phase 4 fixes (nodemailer → 10.x, @fastify/static → 10.1.10, uuid → 11.1.1):

| Package | Severity | Status |
|---|---|---|
| `prisma` CLI / `@prisma/config` / `deepmerge-ts` | high | **Accepted for now.** The CLI only runs at deployment time (`prisma migrate deploy`) on the server by an administrator; it is not loaded by the running application (which uses `@prisma/client`). The fix requires the Prisma 7 major upgrade, planned as a separate change. |

## Residual risks / recommendations

1. Serve only over HTTPS (IIS + certificate) and set `COOKIE_SECURE=true` before go-live.
2. Run the Worker as a dedicated gMSA with rights only on the destination shares.
3. Keep Microsoft Defender real-time scanning on the destination folders (attachments come from external senders).
4. Plan the Prisma 7 upgrade and Microsoft SSO (with MFA) as follow-ups.
