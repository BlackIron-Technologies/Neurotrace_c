# Release Guide

This guide documents the public open-source release flow for NeuroTrace.

## Prerequisites

- Node.js and npm
- Python 3.11
- PowerShell 7 for release packaging scripts
- Platform-specific build environment for backend binaries

## Verify The Extension

Install dependencies:

```powershell
npm install
```

Run the standard checks:

```powershell
npm test
```

`npm test` compiles the extension, validates the Python backend files, and runs
an ONNX smoke test against the pinned embedding model.

Build the production extension bundle:

```powershell
npm run package
```

List VSIX contents before publishing:

```powershell
npx @vscode/vsce ls
```

## Refresh The Pinned ONNX Model

The bundled embedding artifacts are pinned to
`sentence-transformers/all-MiniLM-L6-v2` revision
`1110a243fdf4706b3f48f1d95db1a4f5529b4d41`.

To re-fetch and verify them:

```powershell
.\compilation\fetch-onnx-model.ps1
```

Update `compilation/onnx_model/PROVENANCE.md` and
`THIRD_PARTY_NOTICES.md` if the pinned revision or hashes change.

## Build Backend Binaries

Windows:

```powershell
cd compilation
.\build-windows.ps1
```

Linux:

```bash
cd compilation
chmod +x build-linux.sh
./build-linux.sh
```

macOS:

```bash
cd compilation
chmod +x build-macos.sh
./build-macos.sh
```

## Package Backend Releases

After all platform builds are present in `compilation/dist/`:

```powershell
cd compilation
.\package-releases.ps1 -Version "1.2.6"
.\verify-release-packages.ps1 -ReleasePath "..\releases"
```

Each backend archive must include:

- the platform executable
- `_internal/` with bundled Python dependencies and model artifacts
- `README.txt`
- `THIRD_PARTY_BACKEND_NOTICES.txt`

## Final Checks

Before creating a GitHub release:

```powershell
npm audit
npm audit --omit=dev
npm test
npx @vscode/vsce ls
```

Confirm that `git status --short` contains only intentional source, docs,
workflow, model, and release-script changes.

