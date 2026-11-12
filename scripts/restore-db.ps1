<#
.SYNOPSIS
  MailVault - restore a backup made by backup-db.ps1.

.DESCRIPTION
  Default: restores into a SEPARATE database (mailvault_restore_check) to prove a backup is good,
  prints row counts, and drops it again. Nothing in the live database changes.

  With -IntoLive: replaces the live "mailvault" database. Stop the MailVault-API and MailVault-Worker
  tasks first. Asks for confirmation unless -Force is given.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\restore-db.ps1 -File D:\Backups\mailvault\daily\mailvault_20261112_013000.dump
  powershell -ExecutionPolicy Bypass -File scripts\restore-db.ps1 -File <dump> -IntoLive
#>
param(
  [Parameter(Mandatory = $true)][string]$File,
  [switch]$IntoLive,
  [switch]$Force,
  [string]$SuperUser = 'postgres',
  [string]$PgBin = 'D:\Investoyard\.tools\pgsql\bin',
  [int]$Port = 5433
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $File)) { throw "Backup file not found: $File" }
$psql = Join-Path $PgBin 'psql.exe'
$restore = Join-Path $PgBin 'pg_restore.exe'

function Invoke-Sql($db, $sql) {
  # Via a temp file: Windows PowerShell strips double quotes ("Mailbox") from native command arguments.
  $tmp = [IO.Path]::GetTempFileName()
  try {
    Set-Content -Path $tmp -Value $sql -Encoding ASCII
    & $psql -h 127.0.0.1 -p $Port -U $SuperUser -d $db -v ON_ERROR_STOP=1 -At -f $tmp
    if ($LASTEXITCODE -ne 0) { throw "psql failed: $sql" }
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

if (-not $IntoLive) {
  $target = 'mailvault_restore_check'
  Invoke-Sql 'postgres' "DROP DATABASE IF EXISTS $target"
  Invoke-Sql 'postgres' "CREATE DATABASE $target OWNER mailvault"
  try {
    & $restore -h 127.0.0.1 -p $Port -U $SuperUser -d $target --no-owner --role=mailvault $File
    if ($LASTEXITCODE -ne 0) { throw "pg_restore failed (exit $LASTEXITCODE)" }
    Write-Host "Backup restored into $target. Row counts:"
    Invoke-Sql $target "SELECT 'mailboxes', count(*) FROM ""Mailbox"" UNION ALL SELECT 'rules', count(*) FROM ""Rule"" UNION ALL SELECT 'messages', count(*) FROM ""Message"" UNION ALL SELECT 'downloads', count(*) FROM ""AttachmentDownload"" UNION ALL SELECT 'users', count(*) FROM ""User"" UNION ALL SELECT 'audit entries', count(*) FROM ""AuditLog""" | ForEach-Object { Write-Host "  $_" }
    Write-Host "OK: the backup is usable."
  } finally {
    Invoke-Sql 'postgres' "DROP DATABASE IF EXISTS $target"
  }
  exit 0
}

if (-not $Force) {
  $answer = Read-Host "This REPLACES the live MailVault database with $File. Type RESTORE to continue"
  if ($answer -ne 'RESTORE') { Write-Host 'Cancelled.'; exit 1 }
}
foreach ($t in 'MailVault-API', 'MailVault-Worker') {
  $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq 'Running') { throw "Stop the $t task first (Stop-ScheduledTask -TaskName $t)" }
}
Invoke-Sql 'postgres' "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'mailvault' AND pid <> pg_backend_pid()"
Invoke-Sql 'postgres' 'DROP DATABASE mailvault'
Invoke-Sql 'postgres' 'CREATE DATABASE mailvault OWNER mailvault'
Invoke-Sql 'postgres' "ALTER DATABASE mailvault SET timezone TO 'UTC'"
& $restore -h 127.0.0.1 -p $Port -U $SuperUser -d mailvault --no-owner --role=mailvault $File
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed (exit $LASTEXITCODE)" }
Write-Host 'Live database restored. Start the MailVault-API and MailVault-Worker tasks again.'
