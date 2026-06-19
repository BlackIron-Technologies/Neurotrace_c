# Script to verify backend release zip archives.

param(
    [string]$ReleasePath = (Join-Path (Split-Path -Parent $PSScriptRoot) "releases")
)

$ErrorActionPreference = "Stop"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "NeuroTrace Release Package Verifier" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $ReleasePath)) {
    Write-Host "[WARN] Release path does not exist: $ReleasePath" -ForegroundColor Yellow
    exit 0
}

$ZipFiles = Get-ChildItem -Path $ReleasePath -Filter "neurotrace-backend-*.zip" | Sort-Object Name

if (-not $ZipFiles -or $ZipFiles.Count -eq 0) {
    Write-Host "[WARN] No release packages found in $ReleasePath" -ForegroundColor Yellow
    exit 0
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

foreach ($ZipFile in $ZipFiles) {
    Write-Host "Verifying: $($ZipFile.Name)" -ForegroundColor Cyan
    Write-Host "Size: $([math]::Round($ZipFile.Length / 1MB, 2)) MB" -ForegroundColor Gray
    Write-Host ""

    $Zip = [System.IO.Compression.ZipFile]::OpenRead($ZipFile.FullName)
    try {
        $ExpectedItems = @(
            @{ Name = "neurotrace.exe|neurotrace"; Type = "File"; Desc = "Executable" },
            @{ Name = "_internal/"; Type = "Directory"; Desc = "Python dependencies and bundled assets" },
            @{ Name = "README.txt"; Type = "File"; Desc = "Documentation" },
            @{ Name = "THIRD_PARTY_BACKEND_NOTICES.txt"; Type = "File"; Desc = "Third-party backend notices" }
        )

        $AllGood = $true
        $RootItems = @()

        Write-Host "Root-level contents:" -ForegroundColor Yellow
        foreach ($Entry in $Zip.Entries) {
            $Parts = $Entry.FullName -split '/'
            if ($Parts.Count -eq 1 -and $Entry.Name -ne "") {
                $RootItems += $Entry.Name
                Write-Host "  [FILE] $($Entry.Name) ($([math]::Round($Entry.Length / 1MB, 2)) MB)" -ForegroundColor Green
            } elseif ($Parts.Count -eq 2 -and $Entry.FullName.EndsWith('/')) {
                $DirName = $Parts[0]
                if ($RootItems -notcontains "$DirName/") {
                    $RootItems += "$DirName/"
                    $FileCount = ($Zip.Entries | Where-Object { $_.FullName -like "$DirName/*" -and $_.Name -ne "" }).Count
                    Write-Host "  [DIR]  $DirName/ ($FileCount files)" -ForegroundColor Green
                }
            }
        }

        Write-Host ""

        $UnexpectedFolders = @("src", "bin", "node_modules", ".vscode", ".git", "out", "dist", "compilation")
        $FoundUnexpected = @()
        foreach ($UnexpectedFolder in $UnexpectedFolders) {
            $Found = $Zip.Entries | Where-Object { $_.FullName -like "$UnexpectedFolder/*" }
            if ($Found) {
                $FoundUnexpected += $UnexpectedFolder
            }
        }

        if ($FoundUnexpected.Count -gt 0) {
            Write-Host "[ERROR] Unexpected folders found in archive:" -ForegroundColor Red
            foreach ($Folder in $FoundUnexpected) {
                Write-Host "    - $Folder/" -ForegroundColor Red
            }
            $AllGood = $false
        }

        Write-Host "Expected items check:" -ForegroundColor Yellow
        foreach ($Expected in $ExpectedItems) {
            $Pattern = $Expected.Name
            if ($Expected.Type -eq "File") {
                $Found = $RootItems | Where-Object { $_ -match "^($Pattern)$" }
            } else {
                $Found = $RootItems | Where-Object { $_ -eq $Pattern }
            }

            if ($Found) {
                Write-Host "  [OK] $($Expected.Desc)" -ForegroundColor Green
            } else {
                Write-Host "  [ERROR] $($Expected.Desc) missing" -ForegroundColor Red
                $AllGood = $false
            }
        }

        $HasEmbeddedModel = $Zip.Entries | Where-Object { $_.FullName -like "_internal/onnx_model/*" }
        if ($HasEmbeddedModel) {
            Write-Host "  [OK] Embedded ONNX model in _internal/onnx_model/" -ForegroundColor Green
        } else {
            Write-Host "  [ERROR] Embedded ONNX model missing from _internal/onnx_model/" -ForegroundColor Red
            $AllGood = $false
        }

        Write-Host ""
        if ($AllGood) {
            Write-Host "[OK] Package is clean and contains only necessary files" -ForegroundColor Green
        } else {
            Write-Host "[ERROR] Package has issues; see messages above" -ForegroundColor Red
        }
    } finally {
        $Zip.Dispose()
    }

    Write-Host ""
    Write-Host "======================================" -ForegroundColor Gray
    Write-Host ""
}

Write-Host "Verification complete." -ForegroundColor Cyan
