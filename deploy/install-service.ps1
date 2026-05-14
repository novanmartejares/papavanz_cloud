#Requires -RunAsAdministrator
# ============================================================
# Papavanz Cloud — Install as Windows Service (auto-start)
# ============================================================

$ErrorActionPreference = "Stop"
$installDir = "D:\STORE\papavanz_cloud"
$serviceName = "PapavanzCloud"

Write-Host ""
Write-Host "Installing Papavanz Cloud as a Windows service..." -ForegroundColor Cyan
Write-Host ""

# ---- 1. Download NSSM if not present ----
$nssmDir = "$installDir\tools"
$nssmExe = "$nssmDir\nssm.exe"

if (-not (Test-Path $nssmExe)) {
    Write-Host "[1/3] Downloading NSSM (service manager)..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $nssmDir -Force | Out-Null

    $nssmZip = "$nssmDir\nssm.zip"
    $nssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
    
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip -UseBasicParsing
        Expand-Archive -Path $nssmZip -DestinationPath "$nssmDir\temp" -Force
        $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
        Copy-Item "$nssmDir\temp\nssm-2.24\$arch\nssm.exe" $nssmExe
        Remove-Item "$nssmDir\temp" -Recurse -Force
        Remove-Item $nssmZip -Force
        Write-Host "  NSSM downloaded OK" -ForegroundColor Green
    } catch {
        Write-Host "  Could not download NSSM automatically." -ForegroundColor Red
        Write-Host "  Download it manually from: https://nssm.cc/download" -ForegroundColor Yellow
        Write-Host "  Place nssm.exe in: $nssmDir" -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
        exit 1
    }
} else {
    Write-Host "[1/3] NSSM already present" -ForegroundColor Green
}

# ---- 2. Remove existing service if any ----
Write-Host "[2/3] Configuring service..." -ForegroundColor Yellow
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  Removing old service..." -ForegroundColor DarkYellow
    & $nssmExe stop $serviceName 2>$null
    & $nssmExe remove $serviceName confirm 2>$null
    Start-Sleep -Seconds 2
}

# ---- 3. Install service ----
Write-Host "[3/3] Installing service..." -ForegroundColor Yellow

$nodeExe = (Get-Command node).Source

& $nssmExe install $serviceName $nodeExe "src\index.js"
& $nssmExe set $serviceName AppDirectory "$installDir\server"
& $nssmExe set $serviceName DisplayName "Papavanz Cloud Server"
& $nssmExe set $serviceName Description "Self-hosted private cloud storage"
& $nssmExe set $serviceName Start SERVICE_AUTO_START
& $nssmExe set $serviceName AppStdout "$installDir\server\logs\stdout.log"
& $nssmExe set $serviceName AppStderr "$installDir\server\logs\stderr.log"
& $nssmExe set $serviceName AppRotateFiles 1
& $nssmExe set $serviceName AppRotateBytes 5242880

New-Item -ItemType Directory -Path "$installDir\server\logs" -Force | Out-Null

Write-Host "  Starting service..." -ForegroundColor DarkCyan
& $nssmExe start $serviceName

Start-Sleep -Seconds 3
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue

if ($svc -and $svc.Status -eq "Running") {
    $localIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
        $_.InterfaceAlias -notmatch "Loopback" -and $_.PrefixOrigin -ne "WellKnown"
    } | Select-Object -First 1).IPAddress

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Green
    Write-Host "  SERVICE RUNNING! Auto-starts on boot." -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Access: http://${localIP}:8080" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Commands:" -ForegroundColor White
    Write-Host "    Start:  net start $serviceName" -ForegroundColor DarkCyan
    Write-Host "    Stop:   net stop $serviceName" -ForegroundColor DarkCyan
    Write-Host "    Status: sc query $serviceName" -ForegroundColor DarkCyan
    Write-Host ""
} else {
    Write-Host "  Service may not have started. Check logs:" -ForegroundColor Red
    Write-Host "  $installDir\server\logs\" -ForegroundColor Yellow
}

Read-Host "Press Enter to close"
