from .common import (AutoTokenizer, BACKEND_ROOT, EMBEDDING_DTYPE, EMBEDDING_HEADER, EMBEDDING_LENGTH_STRUCT, ONNX_AVAILABLE, Optional, faiss, np, ort, os, sqlite3, struct, sys)

class EmbeddingMixin:
    def _ensure_model(self) -> bool:
        if self.model is None:
            self.load_model()
        return self.model is not None


    def _serialize_embedding(self, embedding: np.ndarray) -> bytes:
        arr = np.asarray(embedding, dtype=EMBEDDING_DTYPE).reshape(-1)
        length_bytes = struct.pack(EMBEDDING_LENGTH_STRUCT, arr.size)
        return EMBEDDING_HEADER + length_bytes + arr.tobytes(order="C")


    def _deserialize_embedding(self, blob: Optional[bytes]) -> Optional[np.ndarray]:
        if not blob:
            return None
        if not blob.startswith(EMBEDDING_HEADER):
            return None
        header_size = len(EMBEDDING_HEADER)
        if len(blob) < header_size + struct.calcsize(EMBEDDING_LENGTH_STRUCT):
            return None
        expected_len = struct.unpack(
            EMBEDDING_LENGTH_STRUCT,
            blob[header_size : header_size + struct.calcsize(EMBEDDING_LENGTH_STRUCT)],
        )[0]
        data = blob[header_size + struct.calcsize(EMBEDDING_LENGTH_STRUCT) :]
        dtype_size = np.dtype(EMBEDDING_DTYPE).itemsize
        if expected_len <= 0 or len(data) != expected_len * dtype_size:
            return None
        vector = np.frombuffer(data, dtype=EMBEDDING_DTYPE)
        return np.array(vector, copy=True)


    def _encode_and_schedule_update(
        self,
        thought_id: str,
        text: Optional[str],
        pending_updates: list[tuple[bytes, str]],
    ) -> Optional[np.ndarray]:
        if not text or not text.strip():
            return None
        if not self._ensure_model():
            return None
        if self.model is None:
            return None
        vector = np.asarray(self.encode([text])[0], dtype=EMBEDDING_DTYPE)
        pending_updates.append((self._serialize_embedding(vector), thought_id))
        return vector


    def _load_embedding_vector(
        self,
        *,
        blob: Optional[bytes],
        text: Optional[str],
        thought_id: str,
        pending_updates: list[tuple[bytes, str]],
    ) -> Optional[np.ndarray]:
        vector = self._deserialize_embedding(blob)
        if vector is not None:
            return vector
        return self._encode_and_schedule_update(thought_id, text, pending_updates)


    def load_model(self):
        """Load the ONNX model and tokenizer."""
        if ONNX_AVAILABLE and not self.model:
            try:
                # Determine the model directory path
                if getattr(sys, "frozen", False):
                    # Running in PyInstaller bundle
                    if hasattr(sys, "_MEIPASS"):
                        base_path = sys._MEIPASS  # type: ignore
                    else:
                        # Alternative for onedir mode
                        base_path = os.path.dirname(sys.executable)
                else:
                    # Running as script
                    base_path = str(BACKEND_ROOT)

                model_path = os.path.join(base_path, "onnx_model", "model.onnx")

                # Verify model file exists before loading
                if not os.path.exists(model_path):
                    sys.stderr.write(f"ERROR: Model file not found at: {model_path}\n")
                    sys.stderr.write(f"Base path: {base_path}\n")
                    sys.stderr.write(f"Frozen: {getattr(sys, 'frozen', False)}\n")
                    sys.stderr.write(f"Executable: {sys.executable}\n")
                    return f"Error: Model file not found at {model_path}"

                # Load ONNX model and tokenizer
                self.ort_session = ort.InferenceSession(model_path)  # type: ignore
                self.tokenizer = AutoTokenizer.from_pretrained(  # type: ignore
                    os.path.join(base_path, "onnx_model")
                )
                self.model = True  # Flag to indicate model is loaded

                print("ONNX model loaded successfully.", file=sys.stderr)
                return "Model loaded successfully"
            except Exception as e:
                sys.stderr.write(f"Failed to load ONNX model: {e}\n")
                sys.stderr.write(f"Traceback: {e.__class__.__name__}\n")
                import traceback

                traceback.print_exc(file=sys.stderr)
                return f"Error loading model: {e}"
        elif not ONNX_AVAILABLE:
            return "ONNX Runtime library not available. Install with: pip install onnxruntime transformers"
        return "Model already loaded"


    def encode(self, texts):
        """Encode texts to embeddings using ONNX model."""
        if not self.model or not self.ort_session or not self.tokenizer:
            raise RuntimeError("Model not loaded. Call load_model() first.")

        # Tokenize inputs
        inputs = self.tokenizer(
            texts, padding=True, truncation=True, max_length=512, return_tensors="np"
        )

        # Run ONNX inference
        ort_inputs = {
            "input_ids": inputs["input_ids"].astype(np.int64),
            "attention_mask": inputs["attention_mask"].astype(np.int64),
            "token_type_ids": inputs.get(
                "token_type_ids", np.zeros_like(inputs["input_ids"])
            ).astype(np.int64),
        }

        # Get model output
        outputs = self.ort_session.run(None, ort_inputs)

        # Mean pooling
        embeddings = outputs[0]  # Shape: (batch_size, seq_len, hidden_size)
        attention_mask = inputs["attention_mask"]

        # Expand attention mask for broadcasting
        mask_expanded = np.expand_dims(attention_mask, -1)

        # Apply mask and compute mean
        sum_embeddings = np.sum(embeddings * mask_expanded, axis=1)
        sum_mask = np.clip(np.sum(mask_expanded, axis=1), a_min=1e-9, a_max=None)
        mean_pooled = sum_embeddings / sum_mask

        # Normalize embeddings
        norms = np.linalg.norm(mean_pooled, axis=1, keepdims=True)
        normalized = mean_pooled / np.clip(norms, a_min=1e-9, a_max=None)

        return normalized


    def build_faiss_index(self) -> str:
        """
        Build or rebuild the FAISS index from the embeddings stored in the database.
        Returns a status message indicating success or failure.
        """
        if not self.model or not faiss:
            return "Model or Faiss library not available. Cannot build index."
        if self.conn is None:
            return "Database connection not established. Cannot build index."

        cursor = self.conn.cursor()
        try:
            cursor.execute(
                "SELECT id, text, embedding FROM thoughts WHERE text IS NOT NULL"
            )
            rows = cursor.fetchall()
        except sqlite3.OperationalError as e:
            if "no such table" in str(e):
                self.faiss_index = None
                self.index_to_id = []
                return "Table 'thoughts' does not exist yet. Index not built."
            raise

        if not rows:
            self.faiss_index = None
            self.index_to_id = []
            return "No embeddings found to index."

        # ── 1. Deserialize & normalise embeddings
        ids, emb_list = [], []
        pending_updates: list[tuple[bytes, str]] = []
        for r in rows:
            row_dict = dict(r)
            vector = self._load_embedding_vector(
                blob=row_dict.get("embedding"),
                text=row_dict.get("text"),
                thought_id=row_dict["id"],
                pending_updates=pending_updates,
            )
            if vector is None:
                continue
            vec = np.asarray(vector, dtype=EMBEDDING_DTYPE)
            norm = np.linalg.norm(vec)
            if norm > 0:
                vec = vec / (norm + 1e-8)
            ids.append(r["id"])
            emb_list.append(vec)

        if pending_updates:
            cursor.executemany(
                "UPDATE thoughts SET embedding = ? WHERE id = ?",
                pending_updates,
            )
            self.conn.commit()

        if not emb_list:
            self.faiss_index = None
            self.index_to_id = []
            return "No embeddings found to index."

        emb_array = np.vstack(emb_list)  # shape (n, d)
        d = emb_array.shape[1]

        # ── 2. Build cosine-similarity index (inner-product)
        self.faiss_index = faiss.IndexFlatIP(d)
        self.faiss_index.add(emb_array)  # type: ignore
        self.index_to_id = ids

        return f"FAISS index built with {self.faiss_index.ntotal} vectors."


    def process_single_embedding(self, thought_id):
        """Generate and save the embedding for a thought, then update the index."""
        if not self._ensure_model() or self.model is None:
            return "Model not loaded. Cannot process embedding."
        if self.conn is None:
            return "Database not initialized. Please run 'init' command first."
        cursor = self.conn.cursor()
        cursor.execute("SELECT text FROM thoughts WHERE id = ?", (thought_id,))
        row = cursor.fetchone()
        if not row:
            return "Thought not found."

        embedding = np.asarray(self.encode([row["text"]])[0], dtype=EMBEDDING_DTYPE)
        embedding_blob = self._serialize_embedding(embedding)
        cursor.execute(
            "UPDATE thoughts SET embedding = ? WHERE id = ?",
            (embedding_blob, thought_id),
        )

        self.conn.commit()

        self.build_faiss_index()
        print(
            f"Embedding for thought {thought_id} processed and saved.", file=sys.stderr
        )
        return "Embedding processed and index updated."


    def semantic_search(self, query: str, top_k: int = 5, min_score: float = 0.25):
        """
        Return up to *top_k* thoughts whose cosine similarity with *query*
        is ≥ *min_score* (range -1 … 1).

        NOTE: Lowered min_score from 0.40 to 0.25 to catch more results
        """
        if self.conn is None:
            return self._connection_error_result()
        if not self.model:
            self.load_model()
            if not self.model:
                return {
                    "error": "Failed to load the embedding model. Ensure onnxruntime is installed and bin/onnx_model is present."
                }

        if not faiss:
            return {
                "error": "FAISS library not installed. Install with: pip install faiss-cpu"
            }

        if not self.faiss_index:
            build_result = self.build_faiss_index()
            if "No embeddings found" in build_result:
                self.process_all_embeddings()
                build_result = self.build_faiss_index()

            if not self.faiss_index:
                return {"error": f"Failed to build search index: {build_result}"}

        q_vec = np.asarray(self.encode([query])[0], dtype=np.float32)
        q_vec /= np.linalg.norm(q_vec) + 1e-8
        q_vec = q_vec.reshape(1, -1)

        k = min(top_k, self.faiss_index.ntotal)
        sims, idxs = self.faiss_index.search(q_vec, k)  # type: ignore

        valid_ids = [
            self.index_to_id[i]
            for i, sim in zip(idxs[0], sims[0])
            if sim >= min_score and 0 <= i < len(self.index_to_id)
        ]
        if not valid_ids:
            return []

        placeholders = ",".join("?" for _ in valid_ids)
        if self.conn is None:
            return "Database connection is not available."
        cursor = self.conn.cursor()
        cursor.execute(
            f"SELECT * FROM thoughts WHERE id IN ({placeholders})", valid_ids
        )
        rows = cursor.fetchall()

        id_to_row = {row["id"]: dict(row) for row in rows}
        ordered = [id_to_row[_id] for _id in valid_ids if _id in id_to_row]

        for r in ordered:
            r.pop("embedding", None)

        return ordered


    def suggest_related(self, thought_id: str, top_k: int = 3, min_score: float = 0.25):
        """
        Suggest related thoughts based on semantic similarity to the given thought ID.
        Returns a list of related thoughts, excluding the thought itself.

        NOTE: Lowered min_score from 0.40 to 0.25 to catch more results
        """
        if not self.faiss_index:
            build_result = self.build_faiss_index()
            if "No embeddings found" in build_result:
                self.process_all_embeddings()
                build_result = self.build_faiss_index()

        if self.conn is None:
            return "Database not initialized. Please run 'init' command first."
        cursor = self.conn.cursor()
        cursor.execute("SELECT text FROM thoughts WHERE id = ?", (thought_id,))
        row = cursor.fetchone()
        if not row:
            return []

        hits = self.semantic_search(row["text"], top_k + 1, min_score=min_score)

        related = [t for t in hits if isinstance(t, dict) and t.get("id") != thought_id]
        return related[:top_k]


    def process_all_embeddings(self):
        """Generate and save embeddings for all thoughts without embeddings."""
        if not self._ensure_model() or self.model is None:
            return "Failed to load model"

        if self.conn is None:
            return "Database not initialized"

        cursor = self.conn.cursor()
        cursor.execute("SELECT id, text, embedding FROM thoughts")
        rows = cursor.fetchall()

        if not rows:
            return "No thoughts found"

        pending_updates: list[tuple[bytes, str]] = []
        for row in rows:
            row_dict = dict(row)
            self._load_embedding_vector(
                blob=row_dict.get("embedding"),
                text=row_dict.get("text"),
                thought_id=row_dict["id"],
                pending_updates=pending_updates,
            )

        if not pending_updates:
            return "Embeddings already up to date"

        cursor.executemany(
            "UPDATE thoughts SET embedding = ? WHERE id = ?",
            pending_updates,
        )
        self.conn.commit()
        self.build_faiss_index()
        count = len(pending_updates)
        print(f"Processed embeddings for {count} thoughts", file=sys.stderr)
        return f"Processed embeddings for {count} thoughts"
