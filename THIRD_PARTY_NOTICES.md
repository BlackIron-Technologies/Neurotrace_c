# Third-Party Notices

This document tracks third-party software and model artifacts used by
NeuroTrace. It is a release checklist and public notice file; before publishing
a release, verify the exact dependency graph and bundled binary contents from
the release artifact.

NeuroTrace itself is licensed under the MIT License. Third-party components
remain under their own licenses.

## NPM Runtime Dependencies

These direct runtime dependencies are declared in `package.json` and resolved in
`package-lock.json`.

| Component | Version | License | Source |
| --- | ---: | --- | --- |
| `adm-zip` | 0.5.16 | MIT | npm registry |
| `cytoscape` | 3.33.0 | MIT | npm registry |
| `cytoscape-cola` | 2.5.1 | MIT | npm registry |
| `cytoscape-edgehandles` | 4.0.1 | MIT | npm registry |

The extension bundle may include transitive runtime code from these packages.
For each release, generate or inspect the full bundled dependency notice from
`package-lock.json` and the packaged VSIX.

## NPM Development Tooling

Development and packaging tools are declared under `devDependencies`. They are
not intended to ship as runtime extension code, but their licenses still matter
for development and release tooling.

Direct development dependencies currently include MIT, Apache-2.0, and
BSD-2-Clause licensed tools. The lockfile also includes transitive packages
under permissive licenses including MIT, Apache-2.0, BSD, ISC, BlueOak-1.0.0,
0BSD, CC0-1.0, CC-BY-3.0, Python-2.0, Artistic-2.0, WTFPL, and multi-license
expressions.

Items that need explicit review before publication:

- `@vscode/vsce-sign` and platform variants list `SEE LICENSE IN LICENSE.txt`
  in `package-lock.json`.
- `memorystream` appears with an unknown license in `package-lock.json`.

## Python Backend Dependencies

The backend release build installs the direct dependencies from
`compilation/requirements-backend.txt`.

| Component | Pinned Version | Local/Declared License Signal | Notes |
| --- | ---: | --- | --- |
| `sqlcipher3-wheels` | 0.5.5.post0 | zlib/libpng | Python DB-API wrapper for SQLCipher. |
| `onnxruntime` | 1.23.1 | MIT | Runtime for the bundled ONNX embedding model. |
| `faiss-cpu` | 1.11.0 | MIT | Vector search index library. |
| `transformers` | 4.55.4 | Apache-2.0 | Tokenizer/config loading for embeddings. |
| `numpy` | 2.3.3 | BSD-style | Binary wheels can include OpenBLAS/LAPACK/GCC runtime notices. |
| `python-dotenv` | 1.1.1 | BSD-3-Clause | Local environment-file utility. |

Release binaries created with PyInstaller also include PyInstaller bootloader
and collected transitive Python packages. The generated backend archives should
include license notices for the exact wheel set used to build each platform.
`compilation/package-releases.ps1` generates
`THIRD_PARTY_BACKEND_NOTICES.txt` from the bundled `.dist-info/METADATA` files
inside each PyInstaller distribution.

## Build Tools

Backend binaries are produced with PyInstaller. PyInstaller is distributed under
GPLv2-or-later with a special exception for distributing generated bundles.
Include PyInstaller notices in backend binary release artifacts.

## Bundled ONNX Model

The repository currently contains these model artifacts under
`compilation/onnx_model/`:

Source model:

- Model id: `sentence-transformers/all-MiniLM-L6-v2`
- Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- Pinned revision: `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`
- License: Apache-2.0, as listed on the Hugging Face model page
- Local provenance file: `compilation/onnx_model/PROVENANCE.md`

| File | Purpose |
| --- | --- |
| `model.onnx` | ONNX embedding model used by the local backend. |
| `config.json` | Transformer model configuration. |
| `tokenizer.json` | Tokenizer definition. |
| `tokenizer_config.json` | Tokenizer settings. |
| `special_tokens_map.json` | Special token metadata. |
| `vocab.txt` | Token vocabulary. |

Known SHA-256 fingerprints from this cleanup pass:

| File | SHA-256 |
| --- | --- |
| `config.json` | `953F9C0D463486B10A6871CC2FD59F223B2C70184F49815E7EFBCAB5D8908B41` |
| `model.onnx` | `6FD5D72FE4589F189F8EBC006442DBB529BB7CE38F8082112682524616046452` |
| `special_tokens_map.json` | `303DF45A03609E4EAD04BC3DC1536D0AB19B5358DB685B6F3DA123D05EC200E3` |
| `tokenizer.json` | `BE50C3628F2BF5BB5E3A7F17B1F74611B2561A3A27EEAB05E5AA30F411572037` |
| `tokenizer_config.json` | `ACB92769E8195AABD29B7B2137A9E6D6E25C476A4F15AA4355C233426C61576B` |
| `vocab.txt` | `07ECED375CEC144D27C900241F3E339478DEC958F92FDDBC551F295C992038A3` |

The bundled artifacts can be reproduced with:

```powershell
.\compilation\fetch-onnx-model.ps1
```

## Release Checklist

- Verify `package-lock.json` licenses for the exact committed lockfile.
- Verify Python wheel licenses for the exact platform builds.
- Include PyInstaller and binary dependency notices in backend archives.
- Re-run `.\compilation\fetch-onnx-model.ps1` before backend release builds.
- Remove local metadata files such as `Zone.Identifier` from tracked model
  directories.
- Rebuild release archives and compare checksums after notices are finalized.
