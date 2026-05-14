# ─── Papavanz Cloud Daily Backup Script ──────────────────────────────────────
# Backs up: user files + database + server config
# Destination: F:\STORE\BACKUP\papavanz_cloud\
# Keeps the last 7 daily snapshots of the database
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

# Source paths
$StorageRoot = "D:\STORE\papavanz_storage"
$Database    = "D:\STORE\papavanz_cloud\server\prisma\data\app.db"
$EnvFile     = "D:\STORE\papavanz_cloud\server\.env"

# Destination paths
$BackupRoot  = "F:\STORE\BACKUP\papavanz_cloud"
$FilesBackup = "$BackupRoot\files"
$DbBackup    = "$BackupRoot\db_snapshots"
$ConfigBak   = "$BackupRoot\config"

$timestamp   = Get-Date -Format "yyyy-MM-dd_HH-mm"
$logFile     = "$BackupRoot\backup.log"

function Log($msg) {
    $entry = "[$timestamp] $msg"
    Write-Host $entry
    Add-Content -Path $logFile -Value $entry
}

# Create backup directories
New-Item -ItemType Directory -Force -Path $FilesBackup  | Out-Null
New-Item -ItemType Directory -Force -Path $DbBackup     | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigBak    | Out-Null

Log "=== Papavanz Cloud Backup Started ==="

# ─── 1. Backup user files (incremental with robocopy) ───────────────────────
Log "Syncing user files..."
$roboArgs = @($StorageRoot, $FilesBackup, "/MIR", "/MT:4", "/R:2", "/W:5", "/NP", "/NDL", "/NFL")
$result = & robocopy @roboArgs
$exitCode = $LASTEXITCODE

if ($exitCode -le 3) {
    Log "  Files synced OK (robocopy exit: $exitCode)"
} else {
    Log "  WARNING: robocopy exit code $exitCode (some files may have failed)"
}

# ─── 2. Backup database (timestamped snapshot) ──────────────────────────────
if (Test-Path $Database) {
    $dbDest = "$DbBackup\dev_$timestamp.db"
    Copy-Item -Path $Database -Destination $dbDest -Force
    Log "  Database snapshot: $dbDest"

    # Also keep a 'latest' copy for quick restore
    Copy-Item -Path $Database -Destination "$DbBackup\dev_latest.db" -Force

    # Clean old snapshots (keep last 7)
    $old = Get-ChildItem "$DbBackup\dev_*.db" -Exclude "dev_latest.db" |
           Sort-Object LastWriteTime -Descending |
           Select-Object -Skip 7
    foreach ($f in $old) {
        Remove-Item $f.FullName -Force
        Log "  Cleaned old snapshot: $($f.Name)"
    }
} else {
    Log "  WARNING: Database not found at $Database"
}

# ─── 3. Backup config (.env) ────────────────────────────────────────────────
if (Test-Path $EnvFile) {
    Copy-Item -Path $EnvFile -Destination "$ConfigBak\.env" -Force
    Log "  Config backed up"
}

# ─── Done ────────────────────────────────────────────────────────────────────
$size = (Get-ChildItem $FilesBackup -Recurse -File | Measure-Object -Property Length -Sum).Sum
$sizeGB = [math]::Round($size / 1GB, 2)
Log "=== Backup Complete ($sizeGB GB total in backup) ==="
Log ""
