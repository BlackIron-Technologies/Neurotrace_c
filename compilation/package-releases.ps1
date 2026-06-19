# NeuroTrace Backend Packaging Script for GitHub Releases
# Creates zip archives from compilation/dist/* and writes release metadata.

param(
    [string]$Version = "1.1.6"
)

$ErrorActionPreference = "Stop"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "NeuroTrace Release Packaging v$Version" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

$CompilationPath = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $CompilationPath
$DistPath = Join-Path $CompilationPath "dist"
$LegacyDistPath = Join-Path (Join-Path $ProjectRoot "bin") "dist"
$ReleasesPath = Join-Path $ProjectRoot "releases"
$OnnxModelPath = Join-Path $CompilationPath "onnx_model"

if (-not (Test-Path $ReleasesPath)) {
    New-Item -ItemType Directory -Path $ReleasesPath | Out-Null
    Write-Host "[OK] Created releases directory" -ForegroundColor Green
}

if (-not (Test-Path $DistPath)) {
    if (Test-Path $LegacyDistPath) {
        $DistPath = $LegacyDistPath
        Write-Host "[WARN] Using legacy dist path: $DistPath" -ForegroundColor Yellow
    } else {
        Write-Host "[ERROR] $DistPath not found. Build the backends first." -ForegroundColor Red
        Write-Host "Run: .\compilation\build-windows.ps1" -ForegroundColor Yellow
        Write-Host "     .\compilation\build-linux.sh" -ForegroundColor Yellow
        Write-Host "     .\compilation\build-macos.sh" -ForegroundColor Yellow
        exit 1
    }
}

if (-not (Test-Path $OnnxModelPath)) {
    Write-Host "[WARN] $OnnxModelPath not found. Continuing because current builds embed the ONNX model inside _internal/onnx_model." -ForegroundColor Yellow
}

function New-PlatformPackage {
    param(
        [string]$PlatformName,
        [string]$ExecutablePath,
        [string]$OutputFileName
    )

    Write-Host ""
    Write-Host "Packaging $PlatformName..." -ForegroundColor Yellow

    if (-not (Test-Path $ExecutablePath)) {
        Write-Host "[ERROR] Executable not found: $ExecutablePath" -ForegroundColor Red
        return $null
    }

    $StagingDir = Join-Path $ReleasesPath "staging_$PlatformName"
    if (Test-Path $StagingDir) {
        Remove-Item -Recurse -Force $StagingDir
    }
    New-Item -ItemType Directory -Path $StagingDir | Out-Null

    $PlatformDir = Split-Path -Parent $ExecutablePath
    $ExecName = Split-Path -Leaf $ExecutablePath
    Copy-Item -Path $ExecutablePath -Destination (Join-Path $StagingDir $ExecName) -Force
    Write-Host "  [OK] Copied executable: $ExecName" -ForegroundColor Green

    Set-Content -Path (Join-Path $StagingDir "backend-binary-version.txt") -Value $Version
    Write-Host "  [OK] Created backend-binary-version.txt" -ForegroundColor Green

    $InternalPath = Join-Path $PlatformDir "_internal"
    if (Test-Path $InternalPath) {
        Copy-Item -Path $InternalPath -Destination (Join-Path $StagingDir "_internal") -Recurse -Force
        Write-Host "  [OK] Copied _internal directory" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] _internal directory not found at $InternalPath" -ForegroundColor Yellow
    }

    $NoticeScript = Join-Path $CompilationPath "generate-backend-notices.ps1"
    if (Test-Path $NoticeScript) {
        & $NoticeScript -DistributionPath $StagingDir
    } else {
        Write-Host "  [WARN] Notice generator not found: $NoticeScript" -ForegroundColor Yellow
    }

    $ReadmeLines = @(
        "# NeuroTrace Backend - $PlatformName"
        "Version: $Version"
        ""
        "## Contents"
        "- neurotrace executable (compiled Python backend)"
        "- _internal/ (Python dependencies and bundled AI model files from PyInstaller)"
        ""
        "## Installation"
        "This archive is automatically downloaded by the NeuroTrace extension."
        "If you need to install manually:"
        ""
        "1. Extract this archive"
        "2. Place the contents in your extension backend directory:"
        "   - Windows: %USERPROFILE%\.vscode\extensions\blackirontechnologies.neurotrace-$Version\bin\dist\neurotrace-$($PlatformName.ToLower())\"
        "   - Linux/macOS: ~/.vscode/extensions/blackirontechnologies.neurotrace-$Version/bin/dist/neurotrace-$($PlatformName.ToLower())/"
        ""
        "## Security"
        "All binaries are compiled from open source code available at:"
        "https://github.com/BlackIron-Technologies/Neurotrace_c"
        ""
        "## Third-Party Notices"
        "See THIRD_PARTY_BACKEND_NOTICES.txt for bundled Python dependency, model, and build-tool notices."
        ""
        "SHA-256 checksums are provided in the release notes."
    )
    Set-Content -Path (Join-Path $StagingDir "README.txt") -Value $ReadmeLines
    Write-Host "  [OK] Created README.txt" -ForegroundColor Green

    Write-Host "  [INFO] Staging directory contents:" -ForegroundColor Cyan
    Get-ChildItem -Path $StagingDir -Name | ForEach-Object {
        Write-Host "    - $_" -ForegroundColor Gray
    }

    $OutputPath = Join-Path $ReleasesPath $OutputFileName
    if (Test-Path $OutputPath) {
        Remove-Item -Force $OutputPath
    }

    Write-Host "  [INFO] Compressing archive..." -ForegroundColor Yellow
    Compress-Archive -Path "$StagingDir\*" -DestinationPath $OutputPath -CompressionLevel Optimal

    $FileInfo = Get-Item $OutputPath
    $SizeMB = [math]::Round($FileInfo.Length / 1MB, 2)
    $Hash = (Get-FileHash -Path $OutputPath -Algorithm SHA256).Hash

    Write-Host "  [OK] Created: $OutputFileName" -ForegroundColor Green
    Write-Host "       Size: $SizeMB MB" -ForegroundColor Cyan
    Write-Host "       SHA256: $Hash" -ForegroundColor Cyan

    Remove-Item -Recurse -Force $StagingDir

    return @{
        FileName = $OutputFileName
        Path = $OutputPath
        Size = $SizeMB
        SHA256 = $Hash
    }
}

Write-Host "Starting platform packaging..." -ForegroundColor Cyan
$Packages = @{}

$WindowsExe = Join-Path $DistPath "neurotrace-windows\neurotrace.exe"
$WindowsPkg = New-PlatformPackage -PlatformName "Windows" -ExecutablePath $WindowsExe -OutputFileName "neurotrace-backend-windows-$Version.zip"
if ($WindowsPkg) { $Packages["windows"] = $WindowsPkg }

$LinuxExe = Join-Path $DistPath "neurotrace-linux\neurotrace"
$LinuxPkg = New-PlatformPackage -PlatformName "Linux" -ExecutablePath $LinuxExe -OutputFileName "neurotrace-backend-linux-$Version.zip"
if ($LinuxPkg) { $Packages["linux"] = $LinuxPkg }

$MacOSExe = Join-Path $DistPath "neurotrace-macos\neurotrace"
$MacOSPkg = New-PlatformPackage -PlatformName "macOS" -ExecutablePath $MacOSExe -OutputFileName "neurotrace-backend-macos-$Version.zip"
if ($MacOSPkg) { $Packages["macos"] = $MacOSPkg }

$ExpectedPlatforms = @("windows", "linux", "macos")
$MissingPlatforms = $ExpectedPlatforms | Where-Object { -not $Packages.ContainsKey($_) }
if ($MissingPlatforms.Count -gt 0) {
    Write-Host "[ERROR] Missing packaged platforms: $($MissingPlatforms -join ', ')" -ForegroundColor Red
    exit 1
}

$Timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss UTC'

$ChecksumsPath = Join-Path $ReleasesPath "SHA256SUMS.txt"
$ChecksumsLines = @(
    "NeuroTrace Backend v$Version"
    "SHA-256 Checksums"
    "Generated: $Timestamp"
    ""
)
foreach ($Platform in $Packages.Keys | Sort-Object) {
    $Pkg = $Packages[$Platform]
    $ChecksumsLines += "$($Pkg.SHA256)  $($Pkg.FileName)"
}
Set-Content -Path $ChecksumsPath -Value $ChecksumsLines
Write-Host "[OK] Created SHA256SUMS.txt" -ForegroundColor Green

$ReleaseNotesPath = Join-Path $ReleasesPath "RELEASE_NOTES_$Version.md"
$ReleaseNotesLines = @(
    "# NeuroTrace v$Version - Backend Binaries"
    ""
    "## Platform Packages"
    ""
    "This release includes pre-compiled backend executables for all supported platforms."
    "The NeuroTrace extension will automatically download the appropriate binary for your system."
    ""
    "### Package Sizes"
)
foreach ($Platform in @("windows", "linux", "macos")) {
    if ($Packages.ContainsKey($Platform)) {
        $Pkg = $Packages[$Platform]
        $ReleaseNotesLines += "- **$($Platform.ToUpper())**: $($Pkg.Size) MB"
    }
}
$ReleaseNotesLines += @(
    ""
    "## Security and Verification"
    ""
    "All binaries are compiled from the open-source code at [github.com/BlackIron-Technologies/Neurotrace_c](https://github.com/BlackIron-Technologies/Neurotrace_c)."
    ""
    "### SHA-256 Checksums"
    ""
)
foreach ($Platform in $Packages.Keys | Sort-Object) {
    $Pkg = $Packages[$Platform]
    $ReleaseNotesLines += '```'
    $ReleaseNotesLines += $Pkg.FileName
    $ReleaseNotesLines += $Pkg.SHA256
    $ReleaseNotesLines += '```'
    $ReleaseNotesLines += ""
}
$ReleaseNotesLines += @(
    "## Manual Installation (Advanced)"
    ""
    "If automatic download fails:"
    ""
    "1. Download the appropriate .zip for your platform."
    "2. Extract it to ~/.vscode/extensions/blackirontechnologies.neurotrace-$Version/bin/dist/."
    "3. Restart the editor."
    ""
    "## What Is Included"
    ""
    "Each package contains:"
    "- Compiled Python backend executable"
    "- _internal/ - Bundled Python dependencies and ONNX model files"
    ""
    "## Full Changelog"
    ""
    "See [CHANGELOG.md](../CHANGELOG.md) for complete release notes."
)
Set-Content -Path $ReleaseNotesPath -Value $ReleaseNotesLines
Write-Host "[OK] Created release notes template" -ForegroundColor Green

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "Packaging Complete" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Packages created in: $ReleasesPath" -ForegroundColor Cyan
