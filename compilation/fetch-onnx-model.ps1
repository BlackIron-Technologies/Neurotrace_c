# Fetch the pinned ONNX embedding model artifacts used for backend releases.

param(
    [string]$Revision = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
    [string]$OutputDir = (Join-Path $PSScriptRoot "onnx_model")
)

$ErrorActionPreference = "Stop"

$ModelId = "sentence-transformers/all-MiniLM-L6-v2"
$BaseUrl = "https://huggingface.co/$ModelId/resolve/$Revision"

$Files = @(
    @{ Remote = "config.json"; Local = "config.json"; Sha256 = "953F9C0D463486B10A6871CC2FD59F223B2C70184F49815E7EFBCAB5D8908B41" },
    @{ Remote = "onnx/model.onnx"; Local = "model.onnx"; Sha256 = "6FD5D72FE4589F189F8EBC006442DBB529BB7CE38F8082112682524616046452" },
    @{ Remote = "special_tokens_map.json"; Local = "special_tokens_map.json"; Sha256 = "303DF45A03609E4EAD04BC3DC1536D0AB19B5358DB685B6F3DA123D05EC200E3" },
    @{ Remote = "tokenizer.json"; Local = "tokenizer.json"; Sha256 = "BE50C3628F2BF5BB5E3A7F17B1F74611B2561A3A27EEAB05E5AA30F411572037" },
    @{ Remote = "tokenizer_config.json"; Local = "tokenizer_config.json"; Sha256 = "ACB92769E8195AABD29B7B2137A9E6D6E25C476A4F15AA4355C233426C61576B" },
    @{ Remote = "vocab.txt"; Local = "vocab.txt"; Sha256 = "07ECED375CEC144D27C900241F3E339478DEC958F92FDDBC551F295C992038A3" }
)

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

foreach ($File in $Files) {
    $Url = "$BaseUrl/$($File.Remote)"
    $Destination = Join-Path $OutputDir $File.Local

    Write-Host "Downloading $($File.Remote)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $Url -OutFile $Destination

    $ActualHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
    if ($ActualHash -ne $File.Sha256) {
        throw "Hash mismatch for $($File.Local). Expected $($File.Sha256), got $ActualHash"
    }
}

Write-Host "Pinned ONNX model artifacts downloaded and verified." -ForegroundColor Green

