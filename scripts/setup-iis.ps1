#Requires -RunAsAdministrator
# Creates (or updates) the IIS site that publishes MailVault over HTTPS.
# Needs IIS with the URL Rewrite and Application Request Routing (ARR) modules installed.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\setup-iis.ps1 -HostName mailvault.company.local -CertThumbprint <thumbprint>
param(
  [Parameter(Mandatory = $true)][string]$HostName,
  [string]$CertThumbprint,
  [string]$SiteName = "MailVault"
)
$ErrorActionPreference = "Stop"
Import-Module WebAdministration
$root = Split-Path $PSScriptRoot -Parent
$siteDir = Join-Path $root "iis"

$port = 3200
$line = Select-String -Path (Join-Path $root ".env") -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
(Get-Content (Join-Path $siteDir "web.config") -Raw) -replace '127\.0\.0\.1:\d+', "127.0.0.1:$port" |
  Set-Content (Join-Path $siteDir "web.config") -Encoding UTF8

# Allow ARR to act as a proxy and let the rewrite rule set forwarding headers.
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value 'True'
foreach ($v in 'HTTP_X_FORWARDED_PROTO', 'HTTP_X_FORWARDED_HOST') {
  $exists = Get-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter "system.webServer/rewrite/allowedServerVariables/add[@name='$v']"
  if (-not $exists) { Add-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/rewrite/allowedServerVariables' -Value @{ name = $v } }
}

if (-not (Get-Website -Name $SiteName -ErrorAction SilentlyContinue)) {
  New-Website -Name $SiteName -PhysicalPath $siteDir -HostHeader $HostName -Port 80 | Out-Null
  Write-Host "Created IIS site '$SiteName' for http://$HostName"
}
if ($CertThumbprint) {
  if (-not (Get-WebBinding -Name $SiteName -Protocol https -ErrorAction SilentlyContinue)) {
    New-WebBinding -Name $SiteName -Protocol https -Port 443 -HostHeader $HostName -SslFlags 1
  }
  (Get-WebBinding -Name $SiteName -Protocol https).AddSslCertificate($CertThumbprint, "my")
  Write-Host "HTTPS bound with certificate $CertThumbprint. Set COOKIE_SECURE=true in .env and restart the MailVault-API task."
}
Write-Host "Done: https://$HostName -> http://127.0.0.1:$port"
