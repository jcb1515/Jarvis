$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

[string]$repoRoot = Split-Path -Parent $PSScriptRoot
[string]$backendScript = Join-Path $PSScriptRoot "run-backend-local.ps1"
[string]$frontendRoot = Join-Path $repoRoot "frontend"
[string]$npmExecutable = "C:\Program Files\nodejs\npm.cmd"
[string]$localUrl = "http://127.0.0.1:5173"

function Test-LocalPort {
    param([int]$Port)

    return $null -ne (
        Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    )
}

if (-not (Test-LocalPort -Port 8000)) {
    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile", "-File", $backendScript `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden
}

if (-not (Test-LocalPort -Port 5173)) {
    if (-not (Test-Path -LiteralPath $npmExecutable)) {
        throw "Node.js npm executable was not found: $npmExecutable"
    }
    Start-Process `
        -FilePath $npmExecutable `
        -ArgumentList "run", "dev", "--", "--host", "127.0.0.1" `
        -WorkingDirectory $frontendRoot `
        -WindowStyle Hidden
}

[bool]$backendReady = $false
[bool]$frontendReady = $false
for ([int]$attempt = 0; $attempt -lt 40; $attempt += 1) {
    $backendReady = Test-LocalPort -Port 8000
    $frontendReady = Test-LocalPort -Port 5173
    if ($backendReady -and $frontendReady) {
        break
    }
    Start-Sleep -Milliseconds 500
}

if (-not $backendReady -or -not $frontendReady) {
    throw (
        "JARVIS local services did not become ready: " +
        "backend=$backendReady, frontend=$frontendReady"
    )
}

[string[]]$chromeCandidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
)
[string]$chromeExecutable = $chromeCandidates |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1

if (-not $chromeExecutable) {
    throw "Google Chrome is not installed in a standard location."
}

Start-Process -FilePath $chromeExecutable -ArgumentList $localUrl
Write-Output "JARVIS is running at $localUrl"
