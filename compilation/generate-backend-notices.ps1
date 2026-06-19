# Generate third-party notices for a PyInstaller backend distribution.

param(
    [Parameter(Mandatory = $true)]
    [string]$DistributionPath,

    [string]$OutputPath = (Join-Path $DistributionPath "THIRD_PARTY_BACKEND_NOTICES.txt")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $DistributionPath)) {
    throw "Distribution path not found: $DistributionPath"
}

$InternalPath = Join-Path $DistributionPath "_internal"
if (-not (Test-Path $InternalPath)) {
    throw "PyInstaller _internal path not found: $InternalPath"
}

function Get-MetadataValue {
    param(
        [string[]]$Lines,
        [string]$Key
    )

    $Prefix = "$Key`: "
    $Match = $Lines | Where-Object { $_.StartsWith($Prefix) } | Select-Object -First 1
    if ($Match) {
        return $Match.Substring($Prefix.Length).Trim()
    }
    return ""
}

$Packages = @()
$MetadataFiles = Get-ChildItem -Path $InternalPath -Recurse -Filter "METADATA" -File |
    Where-Object { $_.FullName -match "\.dist-info[\\/]+METADATA$" }

foreach ($MetadataFile in $MetadataFiles) {
    $Lines = Get-Content -LiteralPath $MetadataFile.FullName
    $Name = Get-MetadataValue -Lines $Lines -Key "Name"
    $Version = Get-MetadataValue -Lines $Lines -Key "Version"
    $LicenseExpression = Get-MetadataValue -Lines $Lines -Key "License-Expression"
    $License = Get-MetadataValue -Lines $Lines -Key "License"
    $Summary = Get-MetadataValue -Lines $Lines -Key "Summary"
    $HomePage = Get-MetadataValue -Lines $Lines -Key "Home-page"

    if (-not $LicenseExpression) {
        $LicenseExpression = $License
    }
    if (-not $LicenseExpression) {
        $LicenseExpression = "UNKNOWN"
    }

    if ($Name) {
        $Packages += [PSCustomObject]@{
            Name = $Name
            Version = $Version
            License = $LicenseExpression
            Summary = $Summary
            HomePage = $HomePage
        }
    }
}

$LinesOut = @(
    "NeuroTrace Backend Third-Party Notices"
    ""
    "This file is generated from Python package metadata bundled by PyInstaller."
    "Each component remains under its own license."
    ""
    "Bundled Python packages:"
    ""
)

foreach ($Package in $Packages | Sort-Object Name, Version -Unique) {
    $LinesOut += "- $($Package.Name) $($Package.Version)"
    $LinesOut += "  License: $($Package.License)"
    if ($Package.HomePage) {
        $LinesOut += "  Home-page: $($Package.HomePage)"
    }
    if ($Package.Summary) {
        $LinesOut += "  Summary: $($Package.Summary)"
    }
    $LinesOut += ""
}

$LinesOut += @(
    "Bundled model artifacts:"
    ""
    "- sentence-transformers/all-MiniLM-L6-v2"
    "  License: Apache-2.0"
    "  Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2"
    "  Pinned revision: 1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
    ""
    "Build tool:"
    ""
    "- PyInstaller"
    "  License: GPLv2-or-later with special exception for generated bundles"
    "  Source: https://pyinstaller.org"
)

Set-Content -Path $OutputPath -Value $LinesOut -Encoding UTF8
Write-Host "[OK] Wrote backend third-party notices: $OutputPath" -ForegroundColor Green

