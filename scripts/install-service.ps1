#Requires -RunAsAdministrator
<#
  Runs MailVault in the background, always: starts at boot (before anyone logs in) and restarts if it stops.
  Uses Windows Task Scheduler (same approach as our other apps), so nothing extra needs installing.

  Two background tasks are created:
    MailVault-API     web API + admin panel on http://127.0.0.1:<PORT>, served to users through IIS
    MailVault-Worker  mailbox sync and downloads. It MUST run as an account that can write to the
                      destination network shares, e.g. a domain service account or gMSA.

    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -WorkerAccount "CORP\svc-mailvault$"   # gMSA
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -WorkerAccount "CORP\svc-mailvault" -WorkerPassword (Read-Host -AsSecureString)
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Uninstall
  Logs: logs\api.log, logs\worker.log
#>
param(
  [switch]$Uninstall,
  [string]$WorkerAccount = "SYSTEM",
  [SecureString]$WorkerPassword
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$tasks = @("MailVault-API", "MailVault-Worker")

$port = 3200
$line = Select-String -Path (Join-Path $root ".env") -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }

if ($Uninstall) {
  foreach ($t in $tasks) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $t -Confirm:$false
      Write-Host "Removed $t"
    }
  }
  exit 0
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
New-Item -ItemType Directory -Force (Join-Path $root "logs") | Out-Null

# Stop development copies of MailVault (npm run dev:api / dev:worker / dev:web) so they don't hold
# port 3200 or process mail twice. Only processes whose command line points at this MailVault folder.
$escaped = [regex]::Escape($root)
$dev = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $escaped -or $_.CommandLine -match 'MailVault[\\/](apps|node_modules)' } |
  Where-Object { $_.CommandLine -match 'tsx|vite|server\.ts|src[\\/]index\.ts' }
foreach ($p in $dev) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($dev) { Write-Host "Stopped $(@($dev).Count) development MailVault process(es)."; Start-Sleep -Seconds 2 }
$busy = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($busy.OwningProcess)"
  throw "Port $port is still in use by: $($owner.CommandLine). Free it or change PORT in .env (and in iis\web.config)."
}

Push-Location $root
Write-Host "Applying database updates..."
& $npm run db:deploy
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Database update failed - is the Postgres service running?" }
Write-Host "Building the admin panel..."
& $npm run build:web
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Web build failed" }
Pop-Location

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

# API: no network-share access needed, runs as SYSTEM.
$sys = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-App "MailVault-API" "start:api" "api.log" $sys $null $null

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

Write-Host "Waiting for the API..."
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    if ((Invoke-WebRequest "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 3).Content -match '"ok":true') {
      Write-Host "MailVault is running on http://127.0.0.1:$port (publish it through IIS: scripts\setup-iis.ps1)."
      Write-Host "Both tasks start automatically after every reboot. Logs: $root\logs"
      exit 0
    }
  } catch {}
}
throw "The API didn't answer on port $port within 60 seconds. Check $root\logs\api.log"
