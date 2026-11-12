<#
.SYNOPSIS
  MailVault - PostgreSQL backup (custom format, verified, with retention).

.DESCRIPTION
  Dumps the "mailvault" database with pg_dump (-Fc, compressed), verifies the file is readable
  with pg_restore --list, and deletes backups older than the retention window.
  The DB password is read from DATABASE_URL in .env (nothing is stored in this script).

  Also back up separately and securely (not in this folder): .env (contains SECRET_ENC_KEY)
  and the Microsoft 365 certificate in secrets\.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
  powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1 -BackupRoot E:\Backups\mailvault -RetentionDays 30
#>
param(
  [string]$BackupRoot = 'D:\Backups\mailvault',
  [int]$RetentionDays = 14,
  [string]$PgBin = 'D:\Investoyard\.tools\pgsql\bin'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Write-Log($msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Output $line
  if ($script:LogFile) { try { Add-Content -Path $script:LogFile -Value $line -ErrorAction SilentlyContinue } catch {} }
}

try {
  foreach ($d in @($BackupRoot, (Join-Path $BackupRoot 'daily'), (Join-Path $BackupRoot 'logs'))) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  }
  $script:LogFile = Join-Path $BackupRoot ('logs\backup_{0}.log' -f (Get-Date -Format 'yyyyMMdd'))

  $line = Select-String -Path (Join-Path $root '.env') -Pattern '^DATABASE_URL=' | Select-Object -First 1
  if (-not $line) { throw 'DATABASE_URL not found in .env' }
  $m = [regex]::Match($line.Line, 'postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?"]+)')
  if (-not $m.Success) { throw 'Could not read DATABASE_URL' }
  $user = $m.Groups[1].Value; $env:PGPASSWORD = [uri]::UnescapeDataString($m.Groups[2].Value)
  $pgHost = $m.Groups[3].Value; $port = $m.Groups[4].Value; $db = $m.Groups[5].Value

  $file = Join-Path $BackupRoot ('daily\{0}_{1}.dump' -f $db, (Get-Date -Format 'yyyyMMdd_HHmmss'))
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & (Join-Path $PgBin 'pg_dump.exe') -h $pgHost -p $port -U $user -d $db -Fc -Z 6 --no-owner -f $file
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }

  # Verify the archive can be read (catches truncated/corrupt files).
  $toc = & (Join-Path $PgBin 'pg_restore.exe') --list $file
  if ($LASTEXITCODE -ne 0 -or -not ($toc -match 'TABLE DATA')) { throw 'Backup verification failed (pg_restore --list)' }
  $sw.Stop()
  $sizeMb = [math]::Round((Get-Item $file).Length / 1MB, 2)
  Write-Log ("OK  {0}  {1} MB  {2}s  ({3} table data entries)" -f $file, $sizeMb, [math]::Round($sw.Elapsed.TotalSeconds, 1), ($toc -match 'TABLE DATA').Count)

  $cutoff = (Get-Date).AddDays(-$RetentionDays)
  Get-ChildItem (Join-Path $BackupRoot 'daily') -Filter '*.dump' | Where-Object { $_.LastWriteTime -lt $cutoff } | ForEach-Object {
    Remove-Item $_.FullName -Force
    Write-Log "Pruned $($_.Name)"
  }
  Get-ChildItem (Join-Path $BackupRoot 'logs') -Filter '*.log' | Where-Object { $_.LastWriteTime -lt $cutoff.AddDays(-30) } | Remove-Item -Force
  exit 0
} catch {
  Write-Log "FAILED  $($_.Exception.Message)"
  exit 1
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
