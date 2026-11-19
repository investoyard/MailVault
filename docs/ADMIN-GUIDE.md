# MailVault administrator guide

MailVault watches Microsoft 365 mailboxes, picks out emails with your **rules**, and saves their attachments
to **destination folders**. It never changes the mailbox. This guide covers day-to-day administration.

## 1. Daily routine (2 minutes)

1. **Dashboard**: *Failed* should be 0 or explained; *Pending* should not keep growing.
2. **Notifications** (bell): open problems are listed under *Open problems*. Each problem is reported once and closes itself when fixed.
3. If something failed: **Download History** → filter *Failed* → click a row for the reason → **Retry now** (or select several → *Retry selected*).

## 2. Email accounts

- **Add**: Email Accounts → *Add email account* → address, start date (emails before it are ignored unless you run a historical job).
- **Test connection** (⋮ menu): confirms MailVault can read the mailbox.
- **Monitored folders** (⋮ menu): add subfolders if Outlook rules move emails out of the Inbox.
- **Sync now**: checks the mailbox immediately (normally every 5 minutes).
- **Sync history** (⋮ menu, or click *Last sync*; also Monitoring → Sync History): every check, automatic or Sync now, with result, new emails, emails that matched a rule, duration and any error. The trace button opens the full Processing log for that check.
- **Pause** with the *Monitoring* switch; nothing is lost, emails are processed when switched back on.

| Status | Meaning / action |
|---|---|
| Connected | Working |
| Warning | Last check had a problem; see the tooltip. Usually temporary |
| Disconnected | Access denied: the mailbox may have been removed from the *MailVault-Monitored* group |
| Disabled | Monitoring paused by an admin |

## 3. Destination folders

- Use **UNC paths** (`\\server\share\folder`), never mapped drives.
- The MailVault service account needs **Modify** rights on the folder.
- **Browse…** shows the folders *on the server* (folder names only, never files) and can create a new folder; **Test folder** writes a test file and shows the free space. Both run in the worker, so they check access as the same Windows account that saves the files (shown under the result).
- Windows system folders (`C:\Windows`, `Program Files`, `C:\Users`, …) are never shown or accepted. To limit the picker and destinations to chosen locations, set **Settings → Destination folders → Allowed locations** (e.g. `D:\MailVault-Files`, `\\fileserver\accounts`).
- Folders are checked every 5 minutes. If a folder is unavailable, downloads **wait** (they don't fail) and continue automatically when it is back.

## 4. Rules

Download Rules → *New rule*:

1. **Basics**: name, mailbox, priority (lower runs first), *Stop further rules* if later rules should ignore matching emails.
2. **Which emails**: sender (`name@x.com` or `*@x.com`), *never from*, To, CC, subject, keywords (any/all), optional body text and date range. All filled-in conditions must match.
3. **Which attachments**: all or selected file types, name contains / excludes, size limits.
4. **Where to save**: destination folder + subfolder pattern (click the placeholders), file name, duplicate handling (*Smart* is recommended).
   File name examples (email received 7 Apr 2026, saved 19 Nov 2026, attachment `Statement.zip`):

   | Pattern | Saved as |
   |---|---|
   | `{OriginalName}` (default) | `Statement.zip` |
   | `{BaseName}_{Date:dd-MM-yyyy}` | `Statement_07-04-2026.zip` |
   | `{Date:dd-MMM-yyyy} {BaseName}` | `07-Apr-2026 Statement.zip` |
   | `{BaseName}_{Today:yyyyMMdd}` | `Statement_20261119.zip` |

   `{Date:…}` is the email's received date, `{Today:…}` the day the file is saved. Formats use `yyyy yy MMMM MMM MM M dd d HH mm ss` with `- _ . space ,` between them; the extension is added automatically. Unknown placeholders are flagged before you can save.
5. Watch the **Example save location** on the right, then **Test on the last 14 days of email**.
6. New rules can start in **Simulation**: History shows "would save to …" without writing files.

Rules apply to emails received **after** they are created; each edit saves a new version. To process older emails, use a historical job. Rules are switched off, never deleted.

**Duplicate handling**: *Smart* = identical file is skipped, different file with the same name is saved as `name (1).ext`.

## 5. Rule Testing and historical jobs

- **Rule Testing**: search real emails by sender/subject/dates; each rule shows ✔/✘ per condition and which files it would save. Tick attachments → *Download* to save them by hand.
- **Historical Jobs**: run rules over a past date range. Always **Simulate** first, check History, then **Execute** with *Also process emails these rules already handled* turned on. Jobs can be cancelled and resumed.

## 6. Users and access

Users & Roles → *Add user*: name, email (for alerts), username, temporary password (they change it at first sign-in), role, and **which email accounts they can see**.

| Role | Can |
|---|---|
| Super Admin | Everything; sees all mailboxes |
| Admin | Accounts, rules and folders for assigned mailboxes |
| Operator | Tests, historical jobs, manual downloads, retries |
| Viewer | Read-only dashboard and history |

Switch *Permissions* to **Custom** to fine-tune one user. Keep at least **two Super Admins**.
Disabling a user signs them out within seconds. Everyone can change their password and alert preferences from the menu under their name.

## 7. Alerts

- Settings → **Email alerts**: SMTP server, port, username, From address → **Send test** → switch on.
  The SMTP password lives in `.env` (`SMTP_PASSWORD`).
- Settings → **Microsoft Teams**: switch on after `TEAMS_WEBHOOK_URL` is in `.env`.
- Each user chooses in **My notification preferences**: errors only / warnings too / everything, and instant or a daily summary at 8:00.

Alerts you may receive: mailbox disconnected, folder unavailable, low disk space, downloads failed, many failures in an hour,
processing service stopped, certificate expiring, historical job finished, and the matching "resolved" messages.

## 8. Settings worth knowing

| Setting | Default | Notes |
|---|---|---|
| Check mailboxes every | 5 min | Per-mailbox override possible |
| Maximum attempts / wait between | 5 / 1, 5, 15, 60 min | For temporary errors |
| Maximum attachment size | 150 MB | Larger files are skipped |
| Blocked file types | exe, js, vbs, ps1, … | Never downloaded |
| Keep logs / history | 90 / 730 days | Cleanup runs nightly at 02:15 |

## 9. Maintenance

| Task | How |
|---|---|
| Health check | `npm run preflight` (monthly) |
| Backups | Automatic at 01:30 to `D:\Backups\mailvault\daily` (14 days). Verify: `scripts\restore-db.ps1 -File <dump>` |
| Restart | **System Status → Restart worker** (Super Admin; e.g. after editing `.env`). On the server: `Stop-ScheduledTask MailVault-Worker; Start-ScheduledTask MailVault-Worker` |
| Logs | `logs\api.log`, `logs\worker.log`; in the app: Audit & Logs → Processing logs |
| Update MailVault | `git pull` → `npm install` → `npm run db:deploy` → run `scripts\install-service.ps1` again |
| Certificate renewal | Alert 30 days before; `docs/ENTRA-SETUP.md` steps 1–2 |

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| No new files at all | System Status: is the processing service running? Microsoft 365 configured? |
| One mailbox not working | Email Accounts → status tooltip → *Test connection* |
| Files go to "Waiting for folder" | Destination Folders → status; share reachable from the server as the service account? |
| An expected email was not picked up | Rule Testing for that sender and date → read the ✘ reasons |
| "Already processed" but the file is missing | Someone moved/deleted the file. Rule Testing → tick the attachment → *Download* |
