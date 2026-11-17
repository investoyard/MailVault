<#
.SYNOPSIS
  Creates the certificate MailVault uses to sign in to Microsoft Graph (docs/ENTRA-SETUP.md, step 1).

.DESCRIPTION
  Uses the OpenSSL that ships with Git for Windows, so it does not depend on the Windows certificate
  store (no Cert:\ drive, no PFX password, no multi-line paste).

  Creates in secrets\ (or -OutDir):
    mailvault-graph.cer   public certificate  -> upload to Entra ID (App registration > Certificates & secrets)
    mailvault-graph.pem   private key + cert  -> used by MailVault (M365_CERT_PATH in .env). Keep it secret.

  Then limits the folder to Administrators, SYSTEM, you, the IIS app pool (IIS APPPOOL\MailVault) and any
  -ReadAccess accounts (for example a gMSA that runs the worker).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File D:\Claude\MailVault\scripts\create-graph-cert.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File D:\Claude\MailVault\scripts\create-graph-cert.ps1 -ReadAccess "CORP\svc-mailvault$"
#>
[CmdletBinding()]
param(
  [string]$OutDir = '',
  [ValidateRange(1, 3)][int]$Years = 2,
  [string[]]$ReadAccess = @(),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Default: <repo>\secrets. ($PSScriptRoot can be empty inside param() on Windows PowerShell 5.1.)
if (-not $OutDir) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  $OutDir = Join-Path (Split-Path -Parent $scriptDir) 'secrets'
}

function Fail([string]$msg) { Write-Host ''; Write-Host "  $msg" -ForegroundColor Red; Write-Host ''; exit 1 }

# Windows PowerShell 5.1 turns anything a native tool writes to stderr (OpenSSL's progress dots)
# into an error, so run native tools with errors relaxed and judge them by exit code only.
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $ErrorActionPreference = 'Continue'
  & $exe @arguments 2>&1 | Out-Null
  return $LASTEXITCODE
}

# 1. Find OpenSSL (prefer the native mingw64 build: the MSYS one rewrites "/CN=..." into a file path).
$openssl = @(
  'C:\Program Files\Git\mingw64\bin\openssl.exe',
  'C:\Program Files\Git\usr\bin\openssl.exe',
  (Get-Command openssl.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $openssl) { Fail 'OpenSSL was not found. Install Git for Windows (it includes OpenSSL) and run this again.' }

$pem = Join-Path $OutDir 'mailvault-graph.pem'
$cer = Join-Path $OutDir 'mailvault-graph.cer'

# 2. Never silently replace a certificate that may already be uploaded to Entra ID.
if ((Test-Path $pem) -and -not $Force) {
  Fail "A certificate already exists: $pem`n  If you really want a new one, run again with -Force and upload the new .cer to Entra ID."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$work = Join-Path $OutDir ('.tmp-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null

try {
  $key = Join-Path $work 'key.pem'
  $crt = Join-Path $work 'cert.pem'
  $days = 365 * $Years

  # 3. Key pair + self-signed certificate (RSA 2048, SHA-256), written to a temporary folder first.
  $code = Invoke-Native $openssl @('req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', "$days",
    '-subj', '/CN=MailVault Graph', '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'extendedKeyUsage=clientAuth',
    '-keyout', $key, '-out', $crt)
  if ($code -ne 0 -or -not (Test-Path $crt)) { Fail 'OpenSSL could not create the certificate.' }

  $code = Invoke-Native $openssl @('x509', '-in', $crt, '-outform', 'der', '-out', (Join-Path $work 'cert.cer'))
  if ($code -ne 0) { Fail 'OpenSSL could not export the public certificate.' }

  # PEM for MailVault = private key followed by the certificate.
  $combined = (Get-Content -Raw $key) + (Get-Content -Raw $crt)
  [System.IO.File]::WriteAllText((Join-Path $work 'combined.pem'), $combined, (New-Object System.Text.UTF8Encoding($false)))

  Move-Item -Force (Join-Path $work 'combined.pem') $pem
  Move-Item -Force (Join-Path $work 'cert.cer') $cer

  $info = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $cer
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

# 4. Lock the folder down. Accounts that do not exist on this machine are skipped.
function Resolve-Account([string]$name) {
  try { (New-Object System.Security.Principal.NTAccount($name)).Translate([System.Security.Principal.SecurityIdentifier]) | Out-Null; $true } catch { $false }
}
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$grants = @('*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', "${me}:(OI)(CI)F")   # Administrators, SYSTEM, you
$readers = @('IIS APPPOOL\MailVault') + $ReadAccess
$skipped = @()
foreach ($r in $readers) {
  if (Resolve-Account $r) { $grants += "${r}:(OI)(CI)R" } else { $skipped += $r }
}
$aclOk = ((Invoke-Native 'icacls.exe' (@($OutDir, '/inheritance:r', '/grant:r') + $grants + @('/Q'))) -eq 0)
# Files inside take exactly the folder's permissions.
if ($aclOk) { $aclOk = ((Invoke-Native 'icacls.exe' @((Join-Path $OutDir '*'), '/reset', '/T', '/Q')) -eq 0) }

# 5. Summary.
Write-Host ''
Write-Host '  Certificate created' -ForegroundColor Green
Write-Host ''
Write-Host "  Upload to Entra ID : $cer"
Write-Host "  Thumbprint         : $($info.Thumbprint)"
Write-Host "  Valid until        : $($info.NotAfter.ToString('dd MMM yyyy'))   (MailVault alerts 30 days before)"
Write-Host ''
Write-Host '  Add this line to .env:' -ForegroundColor Cyan
Write-Host "  M365_CERT_PATH=$pem"
Write-Host ''
if ($aclOk) { Write-Host "  Folder access limited to Administrators, SYSTEM, $me$(if ($readers.Count -gt $skipped.Count) { ' and ' + (($readers | Where-Object { $skipped -notcontains $_ }) -join ', ') })." }
else { Write-Host '  Could not change folder permissions. Run this script as Administrator to lock the folder down.' -ForegroundColor Yellow }
if ($skipped) { Write-Host "  Skipped (account not found): $($skipped -join ', ')" -ForegroundColor Yellow }
Write-Host '  Never share or commit the .pem file. secrets\ is git-ignored.'
Write-Host ''
