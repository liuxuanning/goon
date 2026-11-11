param([string]$Node = "node")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
& $Node server.mjs --sync-once
if ($LASTEXITCODE -ne 0) { throw "Daily sync failed" }
& $Node scripts/backup-db.mjs
if ($LASTEXITCODE -ne 0) { throw "SQLite backup failed" }
Write-Output "Goon daily sync and backup completed"
