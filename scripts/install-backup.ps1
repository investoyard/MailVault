#Requires -RunAsAdministrator
<#
  Registers the nightly MailVault database backup (Windows Task Scheduler, 01:30 every day).
    powershell -ExecutionPolicy Bypass -File scripts\install-backup.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-backup.ps1 -BackupRoot E:\Backups\mailvault -RetentionDays 30
    powershell -ExecutionPolicy Bypass -File scripts\install-backup.ps1 -Uninstall
#>
param(
  [switch]$Uninstall,
  [string]$BackupRoot = 'D:\Backups\mailvault',
  [int]$RetentionDays = 14,
  [string]$At = '01:30',
  [string]$TaskName = 'MailVault-Backup'
)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'backup-db.ps1'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Write-Host "Removed $TaskName"
  exit 0
}

$taskArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -BackupRoot `"$BackupRoot`" -RetentionDays $RetentionDays"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10) -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "MailVault PostgreSQL backup to $BackupRoot (keeps $RetentionDays days)" -Force | Out-Null

Write-Host "Nightly backup registered ($TaskName at $At). Running a first backup now..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -BackupRoot $BackupRoot -RetentionDays $RetentionDays
if ($LASTEXITCODE -ne 0) { throw "First backup failed - see $BackupRoot\logs" }
