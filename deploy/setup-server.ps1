#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$installDir = 'D:\STORE\papavanz_cloud'
$storageRoot = 'D:\STORE\papavanz_storage'

Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  Papavanz Cloud - Server Setup' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''
Write-Host ('  Install dir:  ' + $installDir) -ForegroundColor DarkCyan
Write-Host ('  Storage dir:  ' + $storageRoot) -ForegroundColor DarkCyan
Write-Host ''

# 1. Check Node.js
Write-Host '[1/6] Checking Node.js...' -ForegroundColor Yellow
$nodeVersion = $null
try { $nodeVersion = (node --version 2>$null) } catch {}

if (-not $nodeVersion) {
    Write-Host '  Node.js not found!' -ForegroundColor Red
    Write-Host '  Please install Node.js LTS from https://nodejs.org' -ForegroundColor Yellow
    Read-Host 'Press Enter to exit'
    exit 1
}
Write-Host ('  Node.js ' + $nodeVersion + ' OK') -ForegroundColor Green

# 2. Verify project files
Write-Host ''
Write-Host '[2/6] Checking project files...' -ForegroundColor Yellow
$serverPkg = Join-Path $installDir 'server\package.json'
if (-not (Test-Path $serverPkg)) {
    Write-Host ('  ERROR: Cannot find ' + $serverPkg) -ForegroundColor Red
    Read-Host 'Press Enter to exit'
    exit 1
}
Write-Host '  Project files found OK' -ForegroundColor Green

# 3. Install dependencies
Write-Host ''
Write-Host '[3/6] Installing server dependencies...' -ForegroundColor Yellow
$serverDir = Join-Path $installDir 'server'
$webDir = Join-Path $installDir 'web'

Push-Location $serverDir
npm install --omit=dev 2>&1 | Out-Null
Write-Host '  Server deps OK' -ForegroundColor Green
Pop-Location

Write-Host '  Installing web dependencies...' -ForegroundColor Yellow
Push-Location $webDir
npm install 2>&1 | Out-Null
Write-Host '  Web deps OK' -ForegroundColor Green

# 4. Build frontend
Write-Host ''
Write-Host '[4/6] Building frontend...' -ForegroundColor Yellow
npm run build 2>&1 | Out-Null
Write-Host '  Frontend built OK' -ForegroundColor Green
Pop-Location

# 5. Configure environment
Write-Host ''
Write-Host '[5/6] Configuring environment...' -ForegroundColor Yellow

$envFile = Join-Path $serverDir '.env'
$distDir = Join-Path $webDir 'dist'

if (-not (Test-Path $storageRoot)) {
    New-Item -ItemType Directory -Path $storageRoot -Force | Out-Null
    Write-Host ('  Created storage dir: ' + $storageRoot) -ForegroundColor DarkCyan
}

# Generate random JWT secret
$chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
$jwtSecret = -join (1..48 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })

$envLines = @(
    '# Papavanz Cloud Server Configuration'
    ('# Generated on ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    ''
    'PORT=8080'
    'HOST=0.0.0.0'
    ''
    ('JWT_SECRET=' + $jwtSecret)
    ''
    ('STORAGE_ROOT=' + $storageRoot)
    ''
    'DATABASE_URL=file:./data/app.db'
    ''
    'MAX_UPLOAD_BYTES=524288000'
    ''
    'DEFAULT_QUOTA_BYTES=5368709120'
    ''
    'INVITE_CODE=papavanz2026'
    ''
    ('STATIC_DIR=' + $distDir)
    ''
    'CORS_ORIGINS='
)

$envLines | Out-File -FilePath $envFile -Encoding utf8
Write-Host '  Config file created' -ForegroundColor Green
Write-Host '  Invite code: papavanz2026' -ForegroundColor DarkCyan

# Database migrations
Write-Host '  Setting up database...' -ForegroundColor DarkCyan
Push-Location $serverDir
npx prisma@5.22.0 migrate deploy 2>&1 | Out-Null
npx prisma@5.22.0 generate 2>&1 | Out-Null
Write-Host '  Database ready' -ForegroundColor Green
Pop-Location

# 6. Firewall
Write-Host ''
Write-Host '[6/6] Configuring firewall...' -ForegroundColor Yellow
$ruleName = 'Papavanz Cloud Server'
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existingRule) {
    Remove-NetFirewallRule -DisplayName $ruleName
}
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private,Domain -Description 'Allow Papavanz Cloud on local network' | Out-Null
Write-Host '  Firewall rule added (port 8080)' -ForegroundColor Green

# Get local IP
$localIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.InterfaceAlias -notmatch 'Loopback' -and $_.PrefixOrigin -ne 'WellKnown'
} | Select-Object -First 1).IPAddress

Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host '  SETUP COMPLETE!' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host ''
Write-Host '  To start the server now:' -ForegroundColor White
Write-Host ('    cd ' + $serverDir) -ForegroundColor Cyan
Write-Host '    node src/index.js' -ForegroundColor Cyan
Write-Host ''
Write-Host '  To auto-start on boot:' -ForegroundColor White
Write-Host ('    cd ' + (Join-Path $installDir 'deploy')) -ForegroundColor Cyan
Write-Host '    .\install-service.ps1' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Access from this computer:' -ForegroundColor White
Write-Host '    http://localhost:8080' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Access from other devices on your network:' -ForegroundColor White
Write-Host ('    http://' + $localIP + ':8080') -ForegroundColor Cyan
Write-Host ''
Write-Host '  Invite code: papavanz2026' -ForegroundColor Yellow
Write-Host ''
Read-Host 'Press Enter to close'
