# Microsoft 365 setup for MailVault (Phase 0)

MailVault reads mailboxes through **Microsoft Graph** using **app-only access with a certificate**.
It only ever gets **`Mail.Read`**, so it can never delete, move or change emails.
Access is limited to the mailboxes in one group using **Exchange RBAC for Applications**.

You need: a **Global Administrator** or **Privileged Role Administrator** (Entra ID) and an
**Exchange Administrator** (Exchange Online PowerShell). Allow about 30 minutes, plus up to ~2 hours for
Exchange permission changes to take effect.

---

## 1. Create the certificate (on the MailVault server)

Open PowerShell **as Administrator** and run this **one line**:

```powershell
powershell -ExecutionPolicy Bypass -File D:\Claude\MailVault\scripts\create-graph-cert.ps1
```

The script uses the OpenSSL that comes with Git for Windows (no Windows certificate store, no passwords) and:

1. creates `D:\Claude\MailVault\secrets\mailvault-graph.cer`: the **public** certificate you upload in step 2;
2. creates `D:\Claude\MailVault\secrets\mailvault-graph.pem`: the **private key** MailVault signs in with (`M365_CERT_PATH`);
3. limits the `secrets` folder to Administrators, SYSTEM (runs the worker), you and `IIS APPPOOL\MailVault` (runs the website);
4. prints the thumbprint, the expiry date and the exact `.env` line to add.

If the worker runs under a service account instead of SYSTEM, give it read access too:

```powershell
powershell -ExecutionPolicy Bypass -File D:\Claude\MailVault\scripts\create-graph-cert.ps1 -ReadAccess "CORP\svc-mailvault$"
```

The script refuses to replace an existing certificate. To make a new one (for example before the old one expires), add
`-Force` and upload the new `.cer` to Entra ID.

> `secrets\`, `*.pem` and `*.pfx` are git-ignored. Never email or share the `.pem` file. Note the expiry date: MailVault
> alerts 30 days before.
>
> Copying commands out of the PDF can break long lines. That is why this step is a single short line.

## 2. Register the app in Entra ID

1. Open **https://entra.microsoft.com** → **Identity** → **Applications** → **App registrations** → **New registration**.
2. Name: **MailVault**. Supported account types: **Accounts in this organizational directory only**. No redirect URI yet. **Register**.
3. On the **Overview** page, copy the **Application (client) ID** and **Directory (tenant) ID**.
4. **Certificates & secrets** → **Certificates** → **Upload certificate** → choose `mailvault-graph.cer`.
5. **API permissions**: do **not** add `Mail.Read` (Application) here.
   Permissions granted in Entra apply to *every* mailbox in the tenant and would bypass the scope set in step 3.
   (Remove any `Mail.Read` application permission if it was added.)
6. Open **Enterprise applications** → **MailVault** and copy its **Object ID** (this is different from the app registration's object ID).

## 3. Limit access to the monitored mailboxes (Exchange Online PowerShell)

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser   # once
Connect-ExchangeOnline

# 3a. Group that holds every mailbox MailVault may read
New-DistributionGroup -Name "MailVault-Monitored" -Type Security -PrimarySmtpAddress mailvault-monitored@company.com
Add-DistributionGroupMember -Identity "MailVault-Monitored" -Member accounts@company.com
$groupDN = (Get-DistributionGroup "MailVault-Monitored").DistinguishedName

# 3b. Make the app known to Exchange
New-ServicePrincipal -AppId <CLIENT_ID> -ObjectId <ENTERPRISE_APP_OBJECT_ID> -DisplayName "MailVault"

# 3c. Scope = members of the group; grant read-only mail access within that scope
New-ManagementScope -Name "MailVault Mailboxes" -RecipientRestrictionFilter "MemberOfGroup -eq '$groupDN'"
New-ManagementRoleAssignment -App <CLIENT_ID> -Role "Application Mail.Read" -CustomResourceScope "MailVault Mailboxes"

# 3d. Check (InScope should be True for monitored mailboxes, False for others)
Test-ServicePrincipalAuthorization -Identity <CLIENT_ID> -Resource accounts@company.com
Test-ServicePrincipalAuthorization -Identity <CLIENT_ID> -Resource ceo@company.com
```

To monitor another mailbox later, just add it to **MailVault-Monitored**.

## 4. Configure MailVault

In `D:\Claude\MailVault\.env`:

```ini
M365_TENANT_ID=<Directory (tenant) ID>
M365_CLIENT_ID=<Application (client) ID>
M365_CERT_PATH=D:\Claude\MailVault\secrets\mailvault-graph.pem
```

## 5. Verify

```powershell
cd D:\Claude\MailVault
npm run check:graph -- accounts@company.com      # should show ✔ Connected, folder count, newest email
npm run check:graph -- ceo@company.com           # should FAIL with "Access denied" (proves the scope works)
npm run check:share -- "\\fileserver\Finance\MailVault"
```

Then in the admin panel: **Email Accounts → Add email account → Test connection**.

### Troubleshooting

| Message | Fix |
|---|---|
| Authentication failed | Wrong tenant/client ID, the certificate wasn't uploaded, or the PEM doesn't match the uploaded .cer |
| Access denied | Mailbox not in **MailVault-Monitored**, role assignment missing, or changes not applied yet (wait up to ~2 hours) |
| Mailbox not found | Address typo, or not an Exchange Online mailbox |
| Share: No write permission | Run the Worker as the service account that has Modify rights on the share (`scripts\install-service.ps1 -WorkerAccount`) |
