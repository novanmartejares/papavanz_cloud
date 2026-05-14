# ─── Schedule Papavanz Cloud Daily Backup ────────────────────────────────────
# Creates a Windows Scheduled Task that runs the backup script every day at 3 AM
# ─────────────────────────────────────────────────────────────────────────────

$taskName   = "PapavanzCloudBackup"
$scriptPath = "D:\STORE\papavanz_cloud\deploy\backup.ps1"

# Remove existing task if any
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Create the action — run PowerShell with the backup script
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

# Trigger: every day at 3:00 AM
$trigger = New-ScheduledTaskTrigger -Daily -At "3:00AM"

# Settings
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable:$false

# Register the task to run as SYSTEM (no password needed)
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Highest `
    -User "SYSTEM" `
    -Description "Daily backup of Papavanz Cloud storage and database to F:\STORE\BACKUP"

Write-Host ""
Write-Host "✅ Scheduled task '$taskName' created!" -ForegroundColor Green
Write-Host "   Runs daily at 3:00 AM"
Write-Host "   Backup destination: F:\STORE\BACKUP\papavanz_cloud\"
Write-Host ""
Write-Host "To run it manually right now:"
Write-Host "   Start-ScheduledTask -TaskName '$taskName'"
Write-Host ""
Write-Host "To test the backup script directly:"
Write-Host "   powershell -ExecutionPolicy Bypass -File D:\STORE\papavanz_cloud\deploy\backup.ps1"
Write-Host ""
