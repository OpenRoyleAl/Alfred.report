# alfred-pi installer — https://alfred.report/install.ps1
# Installs @openroyleal/alfred-pi and wires the `alfred` CLI.

$ErrorActionPreference = "Stop"

$AlfredPackage = "@openroyleal/alfred-pi"
$AlfredCmd = "alfred"
$AlfredInstallUrl = if ($env:ALFRED_INSTALL_URL) { $env:ALFRED_INSTALL_URL } else { "https://alfred.report" }

Write-Host ""
Write-Host "  alfred-pi installer" -ForegroundColor White
Write-Host "  There are many agent harnesses but this one is yours" -ForegroundColor DarkGray
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "X Node.js is required (20+). Install from https://nodejs.org/" -ForegroundColor Red
  exit 1
}

$nodeVersion = (node -v) -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
  Write-Host "! Node $nodeVersion detected — 20+ recommended." -ForegroundColor Yellow
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "X npm is required." -ForegroundColor Red
  exit 1
}

Write-Host "-> Installing $AlfredPackage ..." -ForegroundColor DarkGray
try {
  npm install -g --ignore-scripts $AlfredPackage
} catch {
  Write-Host "X npm install failed." -ForegroundColor Red
  Write-Host "  Package may not be published yet — see $AlfredInstallUrl/pi"
  exit 1
}

if (-not (Get-Command $AlfredCmd -ErrorAction SilentlyContinue)) {
  $npmPrefix = npm prefix -g 2>$null
  if ($npmPrefix -and (Test-Path (Join-Path $npmPrefix "bin"))) {
    Write-Host "! Add to PATH: $npmPrefix\bin" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "OK install alfred report — done" -ForegroundColor Green
Write-Host ""
Write-Host "  First launch:  alfred report          # wake word Alfred.report!"
Write-Host "  Resume:        alfred report <slug>   # kebab slug only"
Write-Host "  Update:        alfred report update"
Write-Host "  Login:         /login or $AlfredInstallUrl/login"
Write-Host ""
