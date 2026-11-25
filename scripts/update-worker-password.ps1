#Requires -RunAsAdministrator
<#
  Updates the Windows password stored in the MailVault-Worker task and restarts the worker.
  Run this after the password of the worker's Windows account (e.g. FINWAVE-WEB\finwave) was changed.
  Easiest: double-click scripts\update-worker-password.cmd (asks for admin rights, then for the password).
  Nothing is rebuilt; only the task's stored password changes. The password is never written to disk or logs.
#>
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$taskName = "MailVault-Worker"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) { throw "Task $taskName not found. Install it first with scripts\install-service.ps1." }

$account = $task.Principal.UserId
if ($account -in @("SYSTEM", "NT AUTHORITY\SYSTEM", "S-1-5-18")) {
  Write-Host "The worker runs as SYSTEM, which has no password. Nothing to update." -ForegroundColor Yellow
  exit 0
}
if ($account -notmatch '\\') { $account = "$env:COMPUTERNAME\$account" }

Write-Host ""
Write-Host "MailVault worker account: $account" -ForegroundColor Cyan
Write-Host "Type the CURRENT Windows password of this account and press Enter (nothing shows while typing)."
$secure = Read-Host -AsSecureString "Password"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  if (-not $plain) { throw "No password entered." }
  # Task Scheduler checks the password here; a wrong one fails with "user name or password is incorrect".
  Set-ScheduledTask -TaskName $taskName -User $account -Password $plain | Out-Null
} catch {
  Write-Host ""
  Write-Host "Could not save the password: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Check the password and run this again."
  exit 1
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $plain = $null
}
Write-Host "Password saved in the task." -ForegroundColor Green

# Restart the worker: stop the task and any leftover worker processes from this folder, then start it again.
$log = Join-Path $root "logs\worker.log"
$linesBefore = if (Test-Path $log) { @(Get-Content $log).Count } else { 0 }
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$escaped = [regex]::Escape($root)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $escaped -or $_.CommandLine -match 'MailVault[\\/](apps|node_modules)' } |
  Where-Object { $_.CommandLine -match 'supervisor\.mjs|src[\\/]index\.ts' -and $_.CommandLine -notmatch 'iisnode' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $taskName

Write-Host "Restarting the worker..."
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 3
  if (Test-Path $log) {
    $new = @(Get-Content $log) | Select-Object -Skip $linesBefore
    if ($new -match 'MailVault worker is running') {
      Write-Host ""
      Write-Host "Done. The MailVault worker is running as $account." -ForegroundColor Green
      exit 0
    }
  }
}
Write-Host ""
Write-Host "The worker did not report in within 2 minutes. Check $log" -ForegroundColor Red
Write-Host "or open Task Scheduler -> MailVault-Worker -> History."
exit 1
