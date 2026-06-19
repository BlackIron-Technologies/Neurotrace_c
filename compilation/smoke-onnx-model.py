"""Smoke test for the bundled ONNX embedding model."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer


def main() -> None:
    model_dir = Path(__file__).resolve().parent / "onnx_model"
    model_path = model_dir / "model.onnx"

    if not model_path.exists():
        raise FileNotFoundError(f"ONNX model not found: {model_path}")

    session = ort.InferenceSession(str(model_path))
    tokenizer = AutoTokenizer.from_pretrained(str(model_dir))

    inputs = tokenizer(
        ["NeuroTrace remembers release decisions."],
        padding=True,
        truncation=True,
        max_length=512,
        return_tensors="np",
    )
    ort_inputs = {
        "input_ids": inputs["input_ids"].astype(np.int64),
        "attention_mask": inputs["attention_mask"].astype(np.int64),
        "token_type_ids": inputs.get(
            "token_type_ids", np.zeros_like(inputs["input_ids"])
        ).astype(np.int64),
    }

    outputs = session.run(None, ort_inputs)
    embeddings = outputs[0]

    if embeddings.shape[-1] != 384:
        raise AssertionError(f"Expected 384-dimensional embeddings, got {embeddings.shape}")
    if not np.isfinite(embeddings).all():
        raise AssertionError("ONNX output contains non-finite values")

    print(f"ONNX smoke test passed: output shape {embeddings.shape}")


if __name__ == "__main__":
    main()

