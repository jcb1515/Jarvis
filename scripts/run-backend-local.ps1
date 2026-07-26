$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

[string]$repoRoot = Split-Path -Parent $PSScriptRoot
[string]$envPath = Join-Path $repoRoot ".env"
[string]$configPath = Join-Path $repoRoot "configs\jarvis-assistant.toml"
[string]$jarvisExecutable = Join-Path $repoRoot ".venv\Scripts\jarvis.exe"

if (-not (Test-Path -LiteralPath $envPath)) {
    throw "Missing local environment file: $envPath"
}
if (-not (Test-Path -LiteralPath $jarvisExecutable)) {
    throw "Missing JARVIS environment. Run: uv sync --extra desktop --extra dev"
}

foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match "^\s*([^#][^=]*)=(.*)$") {
        [string]$name = $matches[1].Trim()
        [string]$value = $matches[2].Trim()
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

$env:OPENJARVIS_CONFIG = $configPath
& $jarvisExecutable serve
