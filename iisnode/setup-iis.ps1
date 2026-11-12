# Creates (or updates) the MailVault website in IIS, hosted by iisnode (like GM Trade / HRMSPlus).
# Run in PowerShell as Administrator:
#   powershell -ExecutionPolicy Bypass -File iisnode\setup-iis.ps1 -HostName mailvault.company.local
#   powershell -ExecutionPolicy Bypass -File iisnode\setup-iis.ps1 -Port 8085                 # no host name, own port
# The mail Worker is separate: scripts\install-service.ps1
param([string]$SiteName = 'MailVault', [int]$Port = 80, [string]$HostName = '')
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot                       # D:\Claude\MailVault\iisnode  (site physical path)
$root = Split-Path $here -Parent            # D:\Claude\MailVault
if (-not (Test-Path "$env:windir\System32\inetsrv\rewrite.dll")) { throw 'URL Rewrite is not installed. Install URL Rewrite 2.1, then run this again.' }
if (-not (Test-Path "$env:ProgramFiles\iisnode\iisnode.dll")) { throw 'iisnode is not installed. Install iisnode (x64), then run this again.' }
if (-not (Test-Path (Join-Path $root 'apps\web\dist\index.html'))) { throw 'The admin panel is not built yet. Run: npm run build:web (or scripts\install-service.ps1)' }
Import-Module WebAdministration

# App pool: no .NET, always running, never idles out or recycles on a timer (live updates and the
# "processing service stopped" watchdog live in this process).
if (-not (Test-Path "IIS:\AppPools\$SiteName")) { New-WebAppPool -Name $SiteName | Out-Null }
$pool = "IIS:\AppPools\$SiteName"
Set-ItemProperty $pool -Name managedRuntimeVersion -Value ''
Set-ItemProperty $pool -Name enable32BitAppOnWin64 -Value $false
Set-ItemProperty $pool -Name startMode -Value 'AlwaysRunning'
Set-ItemProperty $pool -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)
Set-ItemProperty $pool -Name recycling.periodicRestart.time -Value ([TimeSpan]::Zero)

if (-not (Test-Path "IIS:\Sites\$SiteName")) {
  New-Website -Name $SiteName -PhysicalPath $here -Port $Port -HostHeader $HostName -ApplicationPool $SiteName | Out-Null
} else {
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $here
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name applicationPool -Value $SiteName
}
# Start the Node app with IIS instead of waiting for the first visitor (needs Application Initialization).
if (Test-Path "$env:windir\System32\inetsrv\warmup.dll") {
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name applicationDefaults.preloadEnabled -Value $true
}

# The app pool account reads the code, node_modules and .env, and writes its logs.
$identity = "IIS AppPool\$SiteName"
icacls $root /grant "$($identity):(OI)(CI)RX" /T /Q | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs\iisnode') | Out-Null
icacls (Join-Path $root 'logs') /grant "$($identity):(OI)(CI)M" /T /Q | Out-Null

Start-WebAppPool -Name $SiteName -ErrorAction SilentlyContinue
Start-Website -Name $SiteName -ErrorAction SilentlyContinue

$url = if ($HostName) { "http://$HostName$(if ($Port -ne 80) { ":$Port" })/" } else { "http://localhost:$Port/" }
Write-Host "MailVault website is set up in IIS: $url"
Write-Host "Check: open $url -> sign-in page. Logs: $root\logs\iisnode"
Write-Host "For HTTPS: add an https binding with your certificate, set enabled=`"true`" on the 'Force HTTPS' rule in iisnode\web.config, and COOKIE_SECURE=true in .env."
