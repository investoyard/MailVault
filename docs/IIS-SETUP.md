# Publishing MailVault in IIS (iisnode, like HRMSPlus)

MailVault has two parts:

| Part | Hosted by | Why |
|---|---|---|
| **Website + API** (admin panel) | **IIS through iisnode**, like HRMSPlus / GM Trade | Only needed when someone uses the site |
| **Mail Worker** (sync, downloads, retries, alerts, cleanup) | **Background task** (`scripts\install-service.ps1`), like AutoCheckAllotment / eKYC | Must keep checking mailboxes 24×7, even with nobody on the website. IIS only runs Node when a request arrives and recycles app pools, so it can't host the Worker reliably. |

| What | Value |
|---|---|
| **IIS physical path** | `D:\Claude\MailVault\iisnode` |
| Entry file IIS runs | `iisnode\server.cjs` (loads the API; the API also serves the built admin panel) |
| App pool | `MailVault`, *No Managed Code*, Start mode *AlwaysRunning*, Idle time-out 0 |
| Built admin panel | `D:\Claude\MailVault\apps\web\dist` |

The server already has IIS, **iisnode**, URL Rewrite and Application Initialization installed.

---

## Step 1: Start the mail Worker (PowerShell **as Administrator**)

```powershell
cd D:\Claude\MailVault
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
```

This applies database updates, builds the admin panel, compiles the API for IIS, stops development copies, and registers the
**MailVault-Worker** task (starts at boot, restarts if it stops). It ends with *MailVault Worker is running*.

> Network-share destinations: run the Worker as a domain account with rights on the shares:
> add `-WorkerAccount "CORP\svc-mailvault$"` (gMSA) or `-WorkerAccount "CORP\svc-mailvault" -WorkerPassword (Read-Host -AsSecureString)`.

## Step 2: Create the website

### Option A: one command (recommended; same as HRMSPlus's setup-iis.ps1)

```powershell
powershell -ExecutionPolicy Bypass -File iisnode\setup-iis.ps1 -HostName mailvault.company.local
```
(or `-Port 8085` without a host name). It creates the app pool and site with the settings below and grants
the app pool read access to the code and write access to `logs`.

### Option B: manually in IIS Manager

1. **Application Pools** → *Add Application Pool…* → Name `MailVault`, .NET CLR version **No Managed Code** → OK.
   Then *Advanced Settings…* on the pool: **Start Mode = AlwaysRunning**, **Idle Time-out = 0**,
   **Regular Time Interval (Recycling) = 0**.
2. **Sites** → *Add Website…*
   - Site name `MailVault`, application pool `MailVault`
   - **Physical path `D:\Claude\MailVault\iisnode`**
   - Binding: http, port 80, host name `mailvault.company.local` (or https + certificate, see step 4)
3. Site → *Advanced Settings…* → **Preload Enabled = True** (starts Node with IIS instead of on the first visit).
4. Folder permissions (PowerShell as Administrator):
   ```powershell
   icacls D:\Claude\MailVault /grant "IIS AppPool\MailVault:(OI)(CI)RX" /T /Q
   icacls D:\Claude\MailVault\logs /grant "IIS AppPool\MailVault:(OI)(CI)M" /T /Q
   ```
5. DNS: point `mailvault.company.local` to this server (IT / DNS admin).

## Step 3: Tell MailVault its public address

`D:\Claude\MailVault\.env`:
```ini
APP_URL=http://mailvault.company.local     # https://… once a certificate is bound
COOKIE_SECURE=false                         # true only with https
```
Then restart the website: edit/save `D:\Claude\MailVault\iisnode\restart.txt` (iisnode restarts Node), or recycle the `MailVault` app pool.

## Step 4: HTTPS (when you have a certificate)

1. Site → *Bindings…* → *Add* → https, port 443, host name, choose the certificate.
2. In `iisnode\web.config` change the *Force HTTPS* rule to `enabled="true"`.
3. `.env`: `APP_URL=https://mailvault.company.local`, `COOKIE_SECURE=true`; touch `iisnode\restart.txt`.

## Step 5: Check

1. Browse to the site → sign-in page.
2. Sign in → **System Status**: API, processing service (Worker) and database green.
3. Open **Download Rules** and press F5: the same page reloads.
4. On the server: `npm run preflight` lists anything still missing for go-live.

## Updating later

```powershell
cd D:\Claude\MailVault
git pull
npm install
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1   # migrates, rebuilds, restarts Worker + website
```
The installer also touches `iisnode\restart.txt`, so IIS restarts the website on the next request.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **500 / "iisnode encountered an error"** | Read the newest file in `D:\Claude\MailVault\logs\iisnode`. Common: app pool can't read the folder (step 2B.4) or `.env` missing |
| **404 / IIS default page** | Physical path must be `D:\Claude\MailVault\iisnode`; URL Rewrite installed? |
| **System Status: processing service offline** | The Worker task isn't running: `Get-ScheduledTask MailVault-Worker`, `logs\worker.log`, run step 1 again |
| **Live badge says "Polling"** | `flushResponse="true"` must stay in `iisnode\web.config` |
| **Sign-in says "Request blocked"** | `APP_URL` doesn't match the address in the browser; fix `.env`, touch `restart.txt` |
| **Signed in, then immediately signed out** | `COOKIE_SECURE=true` while browsing over http |

---

### Alternative: IIS as reverse proxy only

If you prefer the Node API as its own background task (like AutoCheckAllotment), use physical path
`D:\Claude\MailVault\iis` (or `iis\web.http-only.config` without a certificate), enable ARR *Server Proxy*,
allow the server variables `HTTP_X_FORWARDED_PROTO` and `HTTP_X_FORWARDED_HOST`, and install with
`scripts\install-service.ps1 -IncludeApi`.
