# MailVault go-live checklist

Work through the sections in order. Every command runs on the MailVault server in `D:\Claude\MailVault`
(PowerShell **as Administrator** where marked ⚑). Tick each box and note who did it.

> **One command shows what is still missing:** `npm run preflight` (add `-- --graph` once Microsoft 365 is connected).
> Go live only when it reports **No blockers**.

---

## 1. Prerequisites from IT

| ☐ | Item | Owner |
|---|---|---|
| ☐ | Entra ID app **MailVault** registered, certificate uploaded, Exchange RBAC scope "MailVault-Monitored" created (`docs/ENTRA-SETUP.md`) | M365 admin |
| ☐ | Pilot mailboxes added to the **MailVault-Monitored** group | M365 admin |
| ☐ | Domain service account / gMSA with **Modify** rights on every destination share | AD admin |
| ☐ | DNS name for the site (e.g. `mailvault.company.local`) and a TLS certificate in the server store | IT |
| ☐ | SMTP relay details (server, port, account, From address) | IT |
| ☐ | Optional: Teams channel Workflows webhook URL | Team owner |

## 2. Configure

| ☐ | Step |
|---|---|
| ☐ | Fill `.env`: `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CERT_PATH`, `APP_URL=https://…`, `COOKIE_SECURE=true`, `SMTP_PASSWORD`, optional `TEAMS_WEBHOOK_URL` |
| ☐ | `npm run check:graph -- <pilot mailbox>` shows ✔ for each pilot mailbox, and ✘ *Access denied* for a mailbox **outside** the group |
| ☐ | `npm run check:share -- "\\server\share\path"` run **as the service account** (`runas /user:CORP\svc-mailvault cmd`) shows ✔ |
| ☐ | Remove the demo data: `npm run db:seed-demo -- --clear` |
| ☐ | Sign in, open the menu (your name, top right) → **Change password**, then delete the `DEV_ADMIN_*` lines from `.env` |
| ☐ | Users & Roles: add a **second Super Admin**, add every admin's email address, create the other users and assign their mailboxes |
| ☐ | Settings → **Email alerts**: enter SMTP details → **Send test** arrives → switch on → **Save** |
| ☐ | Destination Folders: add the real folders (UNC paths) → status **Healthy** |
| ☐ | Email Accounts: add the pilot mailboxes (start date = go-live day) → **Test connection** ✔ → **Monitored folders** (add subfolders if Outlook rules move mail) |
| ☐ | Download Rules: create the pilot rules, first with **Simulation** on |

## 3. Install as background services ⚑

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -WorkerAccount "CORP\svc-mailvault$"
powershell -ExecutionPolicy Bypass -File scripts\setup-iis.ps1 -HostName mailvault.company.local -CertThumbprint <thumbprint>
powershell -ExecutionPolicy Bypass -File scripts\install-backup.ps1
```

| ☐ | Check |
|---|---|
| ☐ | `https://mailvault.company.local` opens the sign-in page (padlock, no certificate warning) |
| ☐ | System Status: API, processing service, database and Microsoft 365 all green |
| ☐ | First backup exists in `D:\Backups\mailvault\daily` and `scripts\restore-db.ps1 -File <dump>` reports **OK: the backup is usable** |
| ☐ | Restart the server once: MailVault comes back by itself, with no one logged in |
| ☐ | `npm run preflight -- --graph` → **No blockers** |

## 4. Pilot (1–2 weeks)

| ☐ | Step |
|---|---|
| ☐ | **Rule Testing**: search the last 7 days per pilot mailbox; every expected email shows ✔ for the right rule |
| ☐ | **Historical Jobs → Simulate** for last month; check the "would save to" paths in Download History |
| ☐ | Switch rules from Simulation to live; send a real test email per rule; file appears in the right folder within ~5 minutes |
| ☐ | Daily: look at Dashboard (failed = 0?) and Notifications for a week |
| ☐ | Run **Historical Jobs → Execute** (with "include processed") for the back-fill period agreed with the business |
| ☐ | Business owners sign the UAT sheet below |

## 5. User acceptance test (UAT)

| # | Scenario | Expected | Pass |
|---|---|---|---|
| 1 | Vendor sends an invoice PDF matching a rule | Saved to `<folder>\<pattern>` with the original name within 5 min; History shows Success | ☐ |
| 2 | Same invoice sent twice | Second copy skipped as identical (Smart policy) | ☐ |
| 3 | Different file with the same name | Saved as `name (1).pdf` | ☐ |
| 4 | Email from a sender not in any rule | Not downloaded | ☐ |
| 5 | Email with an .exe attachment | Skipped: "Blocked file type" | ☐ |
| 6 | Email with signature logo + PDF | Only the PDF is saved | ☐ |
| 7 | One email matching two rules | Saved to both folders | ☐ |
| 8 | Destination share made unavailable for 10 min | Downloads show "Waiting for folder", then finish by themselves; alert + recovery email | ☐ |
| 9 | Stop the MailVault-Worker task for 5 min | "Processing service stopped" email; restart → resolved email; missed emails processed | ☐ |
| 10 | Viewer signs in | Sees only assigned mailboxes; cannot edit rules | ☐ |
| 11 | Export History to Excel | Opens in Excel with the filtered rows | ☐ |
| 12 | Original emails in Outlook | Unchanged (not moved, not marked read, not deleted) | ☐ |

Signed (business owner): ____________________  Date: __________

## 6. After go-live

- Keep `npm run preflight` in the monthly admin routine.
- Certificate renewal: an alert arrives 30 days before expiry; follow `docs/ENTRA-SETUP.md` step 1–2 with a new certificate.
- Restore test every quarter: `scripts\restore-db.ps1 -File <latest dump>`.
- Back up `.env` and `secrets\` separately and securely: they are not in the database backup.
