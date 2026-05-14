# Quick Start — Papavanz Cloud
# Just double-click or run in PowerShell

$installDir = "D:\STORE\papavanz_cloud"

if (-not (Test-Path "$installDir\server\.env")) {
    Write-Host "Run setup-server.ps1 first!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Starting Papavanz Cloud... (Press Ctrl+C to stop)" -ForegroundColor Cyan
Push-Location "$installDir\server"
node src/index.js
Pop-Location
