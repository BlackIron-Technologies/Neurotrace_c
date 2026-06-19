# ONNX Model Provenance

These files are the local ONNX embedding model artifacts bundled with
NeuroTrace backend releases.

## Source Model

- Model id: `sentence-transformers/all-MiniLM-L6-v2`
- Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- Pinned revision: `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`
- Revision date: 2026-06-01
- License: Apache-2.0, as listed on the Hugging Face model page
- Purpose: sentence and short-paragraph embeddings for semantic search
- Embedding dimension: 384
- Architecture signal in local `config.json`: `BertModel`, 6 hidden layers,
  hidden size 384, 12 attention heads, vocabulary size 30522

## Local Artifacts

| File | SHA-256 |
| --- | --- |
| `config.json` | `953F9C0D463486B10A6871CC2FD59F223B2C70184F49815E7EFBCAB5D8908B41` |
| `model.onnx` | `6FD5D72FE4589F189F8EBC006442DBB529BB7CE38F8082112682524616046452` |
| `special_tokens_map.json` | `303DF45A03609E4EAD04BC3DC1536D0AB19B5358DB685B6F3DA123D05EC200E3` |
| `tokenizer.json` | `BE50C3628F2BF5BB5E3A7F17B1F74611B2561A3A27EEAB05E5AA30F411572037` |
| `tokenizer_config.json` | `ACB92769E8195AABD29B7B2137A9E6D6E25C476A4F15AA4355C233426C61576B` |
| `vocab.txt` | `07ECED375CEC144D27C900241F3E339478DEC958F92FDDBC551F295C992038A3` |

## Reproducing The Artifacts

Run this from the repository root:

```powershell
.\compilation\fetch-onnx-model.ps1
```

The script downloads these files from the pinned Hugging Face revision and
checks their SHA-256 hashes.
