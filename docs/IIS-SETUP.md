# Publishing MailVault in IIS (manual setup)

MailVault runs as a Node app on `127.0.0.1:3200` (it also serves the admin panel).
IIS is only the front door: it receives `https://mailvault…` and forwards every request to port 3200.
**There is nothing to copy:** the IIS site points at the `iis` folder, which contains just `web.config`.

| What | Value |
|---|---|
| **IIS physical path** | `D:\Claude\MailVault\iis` |
| Proxy target (in web.config) | `http://127.0.0.1:3200` |
| App pool | *No Managed Code* |
| Built admin panel | `D:\Claude\MailVault\apps\web\dist` (served by Node, not by IIS) |

Server already has IIS, URL Rewrite and Application Request Routing (ARR) installed.

---

## Step 1: Start MailVault as background services (PowerShell **as Administrator**)

```powershell
cd D:\Claude\MailVault
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
```

This applies database updates, builds the admin panel, stops any development copies, and registers
two tasks that start at boot and restart if they stop: **MailVault-API** (port 3200) and **MailVault-Worker**.
It ends with `MailVault is running on http://127.0.0.1:3200`.

> Network-share destinations need the Worker to run as a domain account with rights on the shares:
> add `-WorkerAccount "CORP\svc-mailvault$"` (gMSA) or `-WorkerAccount "CORP\svc-mailvault" -WorkerPassword (Read-Host -AsSecureString)`.
> Local folders work with the default (SYSTEM).

Check: open `http://127.0.0.1:3200` on the server → MailVault sign-in page.

## Step 2: Allow IIS to act as a proxy (once per server; skip if your other apps already work this way)

IIS Manager → click the **server name** (top of the tree):

1. **Application Request Routing Cache** → *Server Proxy Settings…* (right) → tick **Enable proxy** → *Apply*.
2. **URL Rewrite** → *View Server Variables…* (right) → *Add…* → `HTTP_X_FORWARDED_PROTO` → OK; *Add…* → `HTTP_X_FORWARDED_HOST` → OK.

## Step 3: Create the site

1. **Application Pools** → *Add Application Pool…* → Name `MailVault`, .NET CLR version **No Managed Code** → OK.
2. **Sites** → *Add Website…*
   - Site name: `MailVault`
   - Application pool: `MailVault`
   - **Physical path: `D:\Claude\MailVault\iis`**
   - Binding: **https**, port 443, host name e.g. `mailvault.company.local`, SSL certificate: choose yours
     *(no certificate yet? see "HTTP only" below)*
   - OK.
3. Optional: add a second binding **http**, port 80, same host name. The web.config redirects it to https automatically.
4. Add the DNS name (`mailvault.company.local`) pointing to this server (IT / DNS admin).

### HTTP only (no certificate yet)

Use binding **http / port 80**, then switch to the HTTP-only config (the normal one forces HTTPS):

```powershell
copy /Y D:\Claude\MailVault\iis\web.http-only.config D:\Claude\MailVault\iis\web.config
```

Switch back to HTTPS as soon as you have a certificate: `git checkout iis/web.config` (or restore the file), bind the certificate, then do step 4.

## Step 4: Tell MailVault its public address

Edit `D:\Claude\MailVault\.env`:

```ini
APP_URL=https://mailvault.company.local
COOKIE_SECURE=true        # only when the site is served over https
```

Then restart the API task (PowerShell as Administrator):

```powershell
Stop-ScheduledTask MailVault-API; Start-ScheduledTask MailVault-API
```

## Step 5: Check

1. Browse to `https://mailvault.company.local` → sign-in page, padlock without warning.
2. Sign in → Dashboard; **System Status** shows the API, processing service and database green.
3. Open **Download Rules**, refresh the page (F5): it must reload the same page (not a 404).
4. On the server: `npm run preflight` lists anything still missing for go-live.

## Updating later

```powershell
cd D:\Claude\MailVault
git pull
npm install
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1   # migrates, rebuilds, restarts
```
IIS needs no change for updates.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **502.3 Bad Gateway** | The Node app is not running: `Get-ScheduledTask MailVault-API`, check `logs\api.log`, run step 1 again |
| **404 / IIS default page** | Wrong physical path (must be `D:\Claude\MailVault\iis`) or URL Rewrite missing |
| **500.50 URL Rewrite error** | Server variables not allowed (step 2.2) |
| **Redirects to https and fails** | No certificate bound: use the HTTP-only config |
| **Sign-in says "Request blocked"** | `APP_URL` doesn't match the address in the browser; fix `.env` and restart the API task |
| **Signed in, then immediately signed out** | `COOKIE_SECURE=true` while browsing over http; set it to `false` or use https |
