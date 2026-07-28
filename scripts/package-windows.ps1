$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

[string]$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
[string]$frontendDirectory = Join-Path $repositoryRoot "frontend"
[string]$tauriTargetDirectory = Join-Path $frontendDirectory "src-tauri\target"
[string]$toolShimDirectory = Join-Path $tauriTargetDirectory "toolchain-shims"
[string]$xwinCacheDirectory = Join-Path $env:LOCALAPPDATA "cargo-xwin-cache"
[string]$xwinSysroot = Join-Path $xwinCacheDirectory "windows-msvc-sysroot\windows-msvc-sysroot"
[string]$targetTriple = "x86_64-pc-windows-msvc"
[string]$sysrootTriple = "x86_64-unknown-windows-msvc"
[string]$cargoBinDirectory = Join-Path $env:USERPROFILE ".cargo\bin"

$env:Path = "$cargoBinDirectory;$env:Path"
$cargoXwinCommand = Get-Command "cargo-xwin" -ErrorAction SilentlyContinue
if ($null -eq $cargoXwinCommand) {
    throw "cargo-xwin is required. Install it with: cargo install --locked cargo-xwin"
}

[System.IO.FileInfo[]]$llvmRcCandidates = @(Get-ChildItem `
    -Path (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages") `
    -Recurse `
    -Filter "llvm-rc.exe" `
    -File `
    -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "LLVM-MinGW\.UCRT" })

if ($llvmRcCandidates.Count -ne 1) {
    throw "Expected exactly one LLVM-MinGW UCRT llvm-rc.exe installation, found $($llvmRcCandidates.Count). Install it with: winget install --id MartinStorsjo.LLVM-MinGW.UCRT --exact"
}

[string]$llvmBinDirectory = $llvmRcCandidates[0].DirectoryName
[string]$lldExecutable = Join-Path $llvmBinDirectory "ld.lld.exe"
if (-not (Test-Path -LiteralPath $lldExecutable -PathType Leaf)) {
    throw "LLVM linker not found at $lldExecutable."
}

New-Item -ItemType Directory -Path $toolShimDirectory -Force | Out-Null
[string]$lldLinkShim = Join-Path $toolShimDirectory "lld-link.exe"
Copy-Item -LiteralPath $lldExecutable -Destination $lldLinkShim -Force

$env:Path = "$toolShimDirectory;$llvmBinDirectory;$env:Path"
$env:XWIN_CACHE_DIR = $xwinCacheDirectory
$env:XWIN_CROSS_COMPILER = "clang"

& cargo xwin env --cross-compiler clang --target $targetTriple | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "cargo-xwin failed to prepare the Windows MSVC sysroot with exit code $LASTEXITCODE."
}

[string]$targetLibraryDirectory = Join-Path $xwinSysroot "lib\$sysrootTriple"
[string]$includeDirectory = Join-Path $xwinSysroot "include"
if (-not (Test-Path -LiteralPath (Join-Path $targetLibraryDirectory "kernel32.lib") -PathType Leaf)) {
    throw "The cargo-xwin MSVC sysroot is incomplete: kernel32.lib is missing from $targetLibraryDirectory."
}

$env:LIB = $targetLibraryDirectory
$env:INCLUDE = @(
    $includeDirectory
    (Join-Path $includeDirectory "c++\stl")
    (Join-Path $includeDirectory "__msvc_vcruntime_intrinsics")
) -join ";"
$env:RC = Join-Path $llvmBinDirectory "llvm-rc.exe"
$env:RC_x86_64_pc_windows_msvc = $env:RC

Push-Location $frontendDirectory
try {
    & npx tauri build `
        --runner cargo-xwin `
        --target $targetTriple `
        --bundles nsis
    if ($LASTEXITCODE -ne 0) {
        throw "Astrono Jarvis Windows packaging failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
