#!/usr/bin/env pwsh
# Build script for NeuroTrace Windows executable
# This script compiles neurotrace.py into a standalone .exe

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "NeuroTrace Windows Build Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Force use Python 3.11 (better PyInstaller compatibility)
$python311 = "py"
$pythonArgs = @("-3.11")

# Check Python version
Write-Host "Checking Python version..." -ForegroundColor Yellow
$pythonVersion = & $python311 $pythonArgs --version 2>&1
Write-Host "Found: $pythonVersion" -ForegroundColor Green
Write-Host ""

# Check if PyInstaller is installed in Python 3.11
Write-Host "Checking PyInstaller in Python 3.11..." -ForegroundColor Yellow
$pyinstallerCheck = & $python311 $pythonArgs -m pip show pyinstaller 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "PyInstaller not found in Python 3.11. Installing..." -ForegroundColor Yellow
    & $python311 $pythonArgs -m pip install pyinstaller
} else {
    Write-Host "PyInstaller is installed in Python 3.11" -ForegroundColor Green
}
Write-Host ""

# Check required dependencies
Write-Host "Checking required dependencies..." -ForegroundColor Yellow
$requiredPackages = @(
    "faiss-cpu",
    "onnxruntime",
    "sqlcipher3-wheels",
    "transformers",
    "numpy"
)

$missingPackages = @()
foreach ($package in $requiredPackages) {
    $check = & $python311 $pythonArgs -m pip show $package 2>&1
    if ($LASTEXITCODE -ne 0) {
        $missingPackages += $package
        Write-Host "  ✗ Missing: $package" -ForegroundColor Red
    } else {
        Write-Host "  ✓ Found: $package" -ForegroundColor Green
    }
}

if ($missingPackages.Count -gt 0) {
    Write-Host ""
    Write-Host "Installing missing packages from requirements-backend.txt..." -ForegroundColor Yellow
    & $python311 $pythonArgs -m pip install -r requirements-backend.txt
    Write-Host ""
}

# Clean previous build artifacts
Write-Host "Cleaning previous build artifacts..." -ForegroundColor Yellow
if (Test-Path "dist") {
    Remove-Item -Recurse -Force "dist"
    Write-Host "  Removed dist/" -ForegroundColor Gray
}
if (Test-Path "build") {
    Remove-Item -Recurse -Force "build"
    Write-Host "  Removed build/" -ForegroundColor Gray
}
if (Test-Path "neurotrace.exe") {
    Remove-Item -Force "neurotrace.exe"
    Write-Host "  Removed neurotrace.exe" -ForegroundColor Gray
}
Write-Host ""

# Build the executable
Write-Host "Building executable with PyInstaller..." -ForegroundColor Yellow
Write-Host "This may take several minutes..." -ForegroundColor Gray
Write-Host ""

& $python311 $pythonArgs -m PyInstaller --clean neurotrace.spec

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "Build completed successfully!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    
    # Ensure new platform-specific folder naming
    if ((Test-Path "dist/neurotrace") -and (-Not (Test-Path "dist/neurotrace-windows"))) {
        Write-Host "Renaming dist/neurotrace -> dist/neurotrace-windows" -ForegroundColor Yellow
        Rename-Item -Path "dist/neurotrace" -NewName "neurotrace-windows"
    }

    # Note: ONNX model is automatically included in _internal/ by PyInstaller via neurotrace.spec
    # No manual copying needed

    if (Test-Path "dist/neurotrace-windows/neurotrace.exe") {
        # Calculate directory size
        $dirSize = (Get-ChildItem -Recurse "dist/neurotrace-windows" | Measure-Object -Property Length -Sum).Sum / 1MB
        Write-Host "Executable location: dist/neurotrace-windows/neurotrace.exe" -ForegroundColor Cyan
        Write-Host "Total distribution size: $([math]::Round($dirSize, 2)) MB" -ForegroundColor Cyan
        Write-Host ""
    } elseif (Test-Path "dist/neurotrace.exe") {
        $exeSize = (Get-Item "dist/neurotrace.exe").Length / 1MB
        Write-Host "Executable location: dist/neurotrace.exe" -ForegroundColor Cyan
        Write-Host "File size: $([math]::Round($exeSize, 2)) MB" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Testing executable..." -ForegroundColor Yellow
        
        # Test the executable
        $testOutput = & "dist/neurotrace.exe" 2>&1
        Write-Host "Executable is ready to use!" -ForegroundColor Green
    }
} else {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "Build failed!" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "Please check the error messages above." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. The executable is located in: dist/neurotrace-windows/" -ForegroundColor White
Write-Host "2. Test it with: py test_exe.py" -ForegroundColor White
Write-Host "3. The TypeScript extension will automatically detect and use it" -ForegroundColor White
Write-Host ""
