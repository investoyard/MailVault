#Requires -RunAsAdministrator
<#
  Runs the MailVault mail Worker in the background, always: starts at boot (before anyone logs in)
  and restarts if it stops. Uses Windows Task Scheduler (same approach as our other apps).

  Default (website hosted by IIS through iisnode, see iisnode\setup-iis.ps1):
    MailVault-Worker  mailbox sync, downloads, retries, alerts, nightly cleanup. It must keep running even
                      when nobody uses the website, so it is a background task, not part of IIS.
                      It MUST run as an account that can write to the destination network shares.

  -IncludeApi (alternative: IIS only as reverse proxy, see iis\web.config):
    also registers MailVault-API on http://127.0.0.1:<PORT>.

    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -WorkerAccount "CORP\svc-mailvault$"   # gMSA
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -WorkerAccount "CORP\svc-mailvault" -WorkerPassword (Read-Host -AsSecureString)
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -IncludeApi
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Uninstall
  Logs: logs\worker.log (and logs\api.log with -IncludeApi)
#>
param(
  [switch]$Uninstall,
  [switch]$IncludeApi,
  [string]$WorkerAccount = "SYSTEM",
  [SecureString]$WorkerPassword
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$port = 3200
$line = Select-String -Path (Join-Path $root ".env") -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }

function Remove-Task([string]$name) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "Removed $name"
  }
}

if ($Uninstall) {
  Remove-Task "MailVault-API"
  Remove-Task "MailVault-Worker"
  exit 0
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
New-Item -ItemType Directory -Force (Join-Path $root "logs") | Out-Null

# Stop development copies of MailVault (npm run dev:api / dev:worker / dev:web) so they don't hold
# port 3200 or process mail twice. Only processes whose command line points at this MailVault folder.
$escaped = [regex]::Escape($root)
$dev = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $escaped -or $_.CommandLine -match 'MailVault[\\/](apps|node_modules)' } |
  Where-Object { $_.CommandLine -match 'tsx|vite|server\.ts|src[\\/]index\.ts' } |
  Where-Object { $_.CommandLine -notmatch 'iisnode' }
foreach ($p in $dev) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($dev) { Write-Host "Stopped $(@($dev).Count) development MailVault process(es)."; Start-Sleep -Seconds 2 }

if ($IncludeApi) {
  $busy = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($busy) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($busy.OwningProcess)"
    throw "Port $port is still in use by: $($owner.CommandLine). Free it or change PORT in .env (and in iis\web.config)."
  }
} else {
  # Website is served by IIS (iisnode) now: an old API task would only duplicate it.
  Remove-Task "MailVault-API"
}

Push-Location $root
Write-Host "Applying database updates..."
& $npm run db:deploy
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Database update failed - is the Postgres service running?" }
Write-Host "Building the admin panel..."
& $npm run build:web
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Web build failed" }
Pop-Location

# Restart the IIS-hosted website so it picks up the new build/code (iisnode watches this file).
$restartMarker = Join-Path $root "iisnode\restart.txt"
if (Test-Path $restartMarker) { Set-Content -Path $restartMarker -Value "restarted $(Get-Date -Format s)" -Encoding ASCII }

$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$trigger = New-ScheduledTaskTrigger -AtStartup

function Register-App([string]$name, [string]$npmScript, [string]$log, $principal, [string]$user, [string]$pass) {
  $cmd = "/c cd /d `"$root`" && `"$npm`" run $npmScript >> `"$root\logs\$log`" 2>&1"
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmd -WorkingDirectory $root
  if ($pass) {
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -User $user -Password $pass -RunLevel Highest -Force | Out-Null
  } else {
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  }
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $name
  Write-Host "Started $name"
}

$sys = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
if ($IncludeApi) { Register-App "MailVault-API" "start:api" "api.log" $sys $null $null }

# Worker: needs write access to destination shares.
if ($WorkerAccount -eq "SYSTEM") {
  Write-Warning "Worker runs as SYSTEM: it can write local folders but usually NOT network shares. Use -WorkerAccount for UNC destinations."
  Register-App "MailVault-Worker" "start:worker" "worker.log" $sys $null $null
} elseif ($WorkerAccount.EndsWith('$')) {
  $gmsa = New-ScheduledTaskPrincipal -UserId $WorkerAccount -LogonType Password -RunLevel Highest
  Register-App "MailVault-Worker" "start:worker" "worker.log" $gmsa $null $null
} else {
  if (-not $WorkerPassword) { throw "Pass -WorkerPassword (Read-Host -AsSecureString) for $WorkerAccount, or use a gMSA (name ending in `$)" }
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($WorkerPassword))
  Register-App "MailVault-Worker" "start:worker" "worker.log" $null $WorkerAccount $plain
}

# Wait for the Worker's first heartbeat (written to the database within ~30 s of starting).
Write-Host "Waiting for the Worker to report in..."
Push-Location $root
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 3
  $state = (Get-ScheduledTask -TaskName "MailVault-Worker").State
  $log = Join-Path $root "logs\worker.log"
  if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'MailVault worker is running' -Quiet) -and $state -eq 'Running') {
    Pop-Location
    Write-Host "MailVault Worker is running (task MailVault-Worker). It starts automatically after every reboot."
    if ($IncludeApi) { Write-Host "API task: http://127.0.0.1:$port" } else { Write-Host "Website: hosted by IIS through iisnode (iisnode\setup-iis.ps1)." }
    Write-Host "Logs: $root\logs"
    exit 0
  }
}
Pop-Location
throw "The Worker did not report in within 90 seconds. Check $root\logs\worker.log"
