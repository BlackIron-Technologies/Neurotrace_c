from datetime import datetime
import getpass
import json
import os
from pathlib import Path
import shutil
import socket
import socketserver
import sqlite3
import struct
import subprocess
import sys
import threading
import time
from typing import Optional
import uuid

BACKEND_VERSION = "1.1.6"
STANDALONE_DAEMON_INFO_FILENAME = "standalone_daemon.json"

if "--version" in sys.argv:
    print(BACKEND_VERSION)
    sys.exit(0)

import numpy as np

try:
    import faiss
except ImportError:
    faiss = None

try:
    import onnxruntime as ort
    from transformers import AutoTokenizer

    ONNX_AVAILABLE = True
except ImportError:
    ort = None
    AutoTokenizer = None  # type: ignore
    ONNX_AVAILABLE = False

try:
    from sqlcipher3 import dbapi2 as sqlite_cipher
except ImportError:
    sqlite_cipher = None

EMBEDDING_HEADER = b"NTEM1"
EMBEDDING_DTYPE = np.float32
EMBEDDING_LENGTH_STRUCT = ">I"
TASK_STATUS_OPEN = "open"
TASK_STATUS_IN_PROGRESS = "in-progress"
TASK_STATUS_BLOCKED = "blocked"
TASK_STATUS_CLOSED = "closed"
TASK_STATUS_OBSOLETE = "obsolete"
ACTIVE_TASK_STATUSES = {
    TASK_STATUS_OPEN,
    TASK_STATUS_IN_PROGRESS,
    TASK_STATUS_BLOCKED,
}
CLOSED_TASK_STATUSES = {
    TASK_STATUS_CLOSED,
    TASK_STATUS_OBSOLETE,
}
TASK_STATUS_ORDER = {
    TASK_STATUS_OPEN: 0,
    TASK_STATUS_IN_PROGRESS: 1,
    TASK_STATUS_BLOCKED: 2,
    TASK_STATUS_CLOSED: 3,
    TASK_STATUS_OBSOLETE: 4,
}
PRIORITY_ORDER = {
    "high": 0,
    "moderate": 1,
    "low": 2,
}
PRIORITY_CANONICAL = {
    "high": "High",
    "moderate": "Moderate",
    "low": "Low",
}


def _sanitize_text_value(value):
    """Replace lone surrogate code points so SQLite can store the value as UTF-8."""
    if value is None or not isinstance(value, str):
        return value
    return "".join(
        "\uFFFD" if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in value
    )


def _apply_sqlcipher_key(connection, password: str) -> None:
    """Apply SQLCipher key using parameter binding when possible."""
    if password is None:
        raise ValueError("Password cannot be None")
    try:
        connection.execute("PRAGMA key = ?", (password,))
    except Exception as primary_error:
        sanitized = password.replace("'", "''")
        try:
            connection.execute(f"PRAGMA key = '{sanitized}'")
        except Exception:
            raise primary_error


def get_db_connection(db_path):
    """Get a database connection."""
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def get_sqlcipher_connection(db_path):
    """Get a SQLCipher connection safe for serialized cross-thread access."""
    if not sqlite_cipher:
        raise RuntimeError("sqlcipher3 is not installed")
    conn = sqlite_cipher.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite_cipher.Row
    return conn


class NeuroTraceServer:
    """
    A class to manage the server state, including the DB connection,
    the AI model, and the search index.
    """

    def __init__(self, db_path, bridge_enabled: bool = False):
        self.conn = None
        self.bridge_enabled = bridge_enabled
        self.connection_status_hint: Optional[str] = None
        if db_path is not None:
            self.conn = get_db_connection(db_path)
            self.connection_status_hint = "UNENCRYPTED"
        self.model = None
        self.faiss_index = None
        self.index_to_id = []
        self.workspace_path: Optional[Path] = None
        self.command_lock = threading.RLock()
        self.bridge_server: Optional[socketserver.ThreadingTCPServer] = None
        self.bridge_thread: Optional[threading.Thread] = None
        self.bridge_port: Optional[int] = None
        self.bridge_token: Optional[str] = None
        self.bridge_info_path: Optional[Path] = None
        if self.conn is not None:
            self.init()

    def _get_bridge_info_path(self) -> Optional[Path]:
        if self.workspace_path is None:
            return None
        return self.workspace_path / ".neurotrace" / "backend_bridge.json"

    def _remove_bridge_info_file(self) -> None:
        if self.bridge_info_path and self.bridge_info_path.exists():
            try:
                self.bridge_info_path.unlink()
            except OSError:
                pass

    def _write_bridge_info(self) -> None:
        info_path = self._get_bridge_info_path()
        if info_path is None or self.bridge_port is None or self.bridge_token is None:
            return

        info_path.parent.mkdir(parents=True, exist_ok=True)
        info = {
            "host": "127.0.0.1",
            "port": self.bridge_port,
            "token": self.bridge_token,
            "pid": os.getpid(),
            "workspace": str(self.workspace_path) if self.workspace_path else None,
        }
        info_path.write_text(json.dumps(info), encoding="utf-8")
        self.bridge_info_path = info_path

    def stop_bridge_server(self) -> None:
        if self.bridge_server is not None:
            try:
                self.bridge_server.shutdown()
            except Exception:
                pass
            try:
                self.bridge_server.server_close()
            except Exception:
                pass

        self.bridge_server = None
        self.bridge_thread = None
        self.bridge_port = None
        self.bridge_token = None
        self._remove_bridge_info_file()
        self.bridge_info_path = None

    def start_bridge_server(self) -> None:
        if not self.bridge_enabled:
            return

        info_path = self._get_bridge_info_path()
        if info_path is None:
            return

        if self.bridge_server is not None and self.bridge_info_path == info_path:
            self._write_bridge_info()
            return

        self.stop_bridge_server()
        self.bridge_token = uuid.uuid4().hex
        neurotrace_server = self

        class ThreadedBridgeServer(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        class BridgeHandler(socketserver.StreamRequestHandler):
            def handle(self):
                while True:
                    line = self.rfile.readline()
                    if not line:
                        break

                    req_id = None
                    try:
                        req = json.loads(line.decode("utf-8"))
                        req_id = req.get("id")
                        if req.get("token") != neurotrace_server.bridge_token:
                            response = {
                                "id": req_id,
                                "error": "Unauthorized bridge request.",
                                "success": False,
                            }
                        else:
                            result = execute_backend_command(
                                neurotrace_server,
                                req.get("command", ""),
                                req.get("payload", {}),
                            )
                            response = {"id": req_id, "data": result, "success": True}
                    except Exception as e:
                        response = {
                            "id": req_id,
                            "error": f"Python Error: {type(e).__name__}: {e}",
                            "success": False,
                        }

                    self.wfile.write((json.dumps(response) + "\n").encode("utf-8"))
                    self.wfile.flush()

        self.bridge_server = ThreadedBridgeServer(("127.0.0.1", 0), BridgeHandler)
        self.bridge_port = int(self.bridge_server.server_address[1])
        self.bridge_thread = threading.Thread(
            target=self.bridge_server.serve_forever,
            daemon=True,
            name="NeuroTraceBridge",
        )
        self.bridge_thread.start()
        self._write_bridge_info()
        print(
            f"NeuroTrace bridge listening on 127.0.0.1:{self.bridge_port}",
            file=sys.stderr,
        )

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

    def _normalize_path(self, file_path: Optional[str]) -> Optional[str]:
        if not file_path:
            return None
        path = str(file_path).strip()
        if not path:
            return None
        return os.path.normcase(os.path.normpath(os.path.abspath(path)))

    def _normalize_task_status(self, thought_type: Optional[str], status: Optional[str]) -> Optional[str]:
        if thought_type != "task":
            return None
        if status is None:
            return TASK_STATUS_OPEN
        normalized = str(status).strip().lower().replace("_", "-").replace(" ", "-")
        if normalized in ACTIVE_TASK_STATUSES or normalized in CLOSED_TASK_STATUSES:
            return normalized
        raise ValueError(
            "Invalid task status. Expected one of: open, in-progress, blocked, closed, obsolete."
        )

    def _normalize_task_priority(
        self, thought_type: Optional[str], priority: Optional[str]
    ) -> Optional[str]:
        if thought_type != "task":
            return None
        if priority is None:
            return None
        normalized = str(priority).strip().lower()
        if not normalized:
            return None
        if normalized in PRIORITY_CANONICAL:
            return PRIORITY_CANONICAL[normalized]
        raise ValueError(
            "Invalid task priority. Expected one of: Low, Moderate, High."
        )

    def _priority_rank(self, priority: Optional[str]) -> int:
        if not priority:
            return len(PRIORITY_ORDER)
        return PRIORITY_ORDER.get(str(priority).strip().lower(), len(PRIORITY_ORDER))

    def _task_group_rank(self, thought_type: Optional[str], status: Optional[str]) -> int:
        if thought_type != "task":
            return 1
        normalized_status = str(status).strip().lower().replace("_", "-").replace(" ", "-") if status else TASK_STATUS_OPEN
        if normalized_status in ACTIVE_TASK_STATUSES:
            return 0
        if normalized_status in CLOSED_TASK_STATUSES:
            return 2
        return 0

    def _sort_thoughts_for_file(self, thoughts):
        def sort_key(thought):
            thought_type = thought.get("type")
            status = thought.get("status")
            group_rank = self._task_group_rank(thought_type, status)
            line = thought.get("line")
            line_none = line is None
            line_value = line if isinstance(line, int) else 0
            priority_rank = self._priority_rank(thought.get("priority")) if thought_type == "task" else len(PRIORITY_ORDER)
            timestamp = thought.get("timestamp") or ""
            try:
                timestamp_value = datetime.fromisoformat(timestamp).timestamp() if timestamp else 0.0
            except Exception:
                timestamp_value = 0.0
            return (
                group_rank,
                line_none,
                line_value,
                priority_rank,
                -timestamp_value,
                thought.get("id") or "",
            )

        return sorted(thoughts, key=sort_key)

    def _strip_embedding_from_row(self, row):
        row_dict = dict(row)
        row_dict.pop("embedding", None)
        return row_dict

    def _connection_error_result(self):
        status = self.check_db_status().get("status", "UNKNOWN")
        if status == "NO_DB":
            return {"error": "no_database"}
        if status == "NO_WORKSPACE":
            return {"error": "no_workspace"}
        if status == "LOCKED":
            return {"error": "Database is locked"}
        return {"error": "Database not initialized"}

    def _ensure_database_ready(self):
        """Create or open the workspace database and ensure required tables exist."""
        if self.workspace_path is None:
            return "Error: Workspace path not set."

        nt_folder = self.workspace_path / ".neurotrace"
        nt_folder.mkdir(exist_ok=True)
        db_path = nt_folder / "neurotrace.db"
        if self.conn is None:
            status = self.check_db_status().get("status", "UNKNOWN")
            if status == "LOCKED":
                return "Database is locked. Unlock required before initialization."
            self.conn = get_db_connection(db_path)
            self.connection_status_hint = "UNENCRYPTED"

        cursor = self.conn.cursor()
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS thoughts (
                id TEXT PRIMARY KEY, timestamp TEXT, text TEXT, file_path TEXT,
                line INTEGER, type TEXT, tags TEXT, embedding BLOB, snippet TEXT,
                priority TEXT, status TEXT
            )
            """
        )
        self.ensure_schema_migration()
        self.conn.commit()

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS relations (
                id   TEXT PRIMARY KEY,
                src  TEXT NOT NULL,
                dst  TEXT NOT NULL,
                rel  TEXT NOT NULL,
                meta TEXT
            )
            """
        )
        self.conn.commit()
        return None

    def check_db_status(self):
        """Determines the current state of the database file."""
        if self.workspace_path is None:
            return {"status": "NO_WORKSPACE"}
        db_path = os.path.join(str(self.workspace_path), ".neurotrace", "neurotrace.db")
        if not os.path.exists(db_path):
            return {"status": "NO_DB"}
        if self.conn is not None:
            try:
                self.conn.execute("SELECT count(*) FROM sqlite_master;")
                if self.connection_status_hint in ("UNENCRYPTED", "UNLOCKED"):
                    return {"status": self.connection_status_hint}
                return {"status": "UNLOCKED"}
            except Exception:
                self.conn = None
                self.connection_status_hint = None
        try:
            conn = sqlite3.connect(db_path)
            conn.execute("SELECT count(*) FROM sqlite_master;")
            conn.close()
            return {"status": "UNENCRYPTED"}
        except Exception:
            return {"status": "LOCKED"}

    def unlock_database(self, password):
        """Unlocks the database for the current session."""
        if not sqlite_cipher:
            return {"status": "error", "message": "sqlcipher3 not installed."}
        try:
            db_path = os.path.join(
                str(self.workspace_path), ".neurotrace", "neurotrace.db"
            )
            self.conn = get_sqlcipher_connection(db_path)
            _apply_sqlcipher_key(self.conn, password)
            self.conn.execute("SELECT count(*) FROM sqlite_master;")
        except Exception as e:
            self.conn = None
            self.connection_status_hint = None
            return {"status": "error", "message": "Invalid passphrase."}
        try:
            self.ensure_schema_migration()
        except Exception as e:
            try:
                if self.conn:
                    self.conn.close()
            except Exception:
                pass
            self.conn = None
            self.connection_status_hint = None
            return {"status": "error", "message": f"Schema migration failed: {e}"}
        self.connection_status_hint = "UNLOCKED"
        return {"status": "ok"}

    def encrypt_database(self, password):
        """Migrates an unencrypted database to an encrypted one using SQLCipher's native capabilities."""
        if not sqlite_cipher:
            return {"status": "error", "message": "sqlcipher3 is not available."}

        if self.workspace_path is None:
            return {"status": "error", "message": "Workspace not set."}

        db_path = os.path.join(str(self.workspace_path), ".neurotrace", "neurotrace.db")
        db_temp_path = os.path.join(
            str(self.workspace_path), ".neurotrace", "temp_encrypted.db"
        )

        try:
            if self.conn is not None:
                self.conn.close()
                self.conn = None
            source_conn = get_db_connection(db_path)
            encrypted_conn = get_sqlcipher_connection(db_temp_path)
            _apply_sqlcipher_key(encrypted_conn, password)
            cursor = source_conn.cursor()
            cursor.execute("SELECT sql FROM sqlite_master WHERE type='table'")
            tables = cursor.fetchall()

            encrypted_cursor = encrypted_conn.cursor()
            for table in tables:
                if "sqlite_sequence" not in table[0]:
                    encrypted_cursor.execute(table[0])

            cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
            table_names = cursor.fetchall()

            for table_name in table_names:
                name = table_name[0]
                if not name.startswith("sqlite_"):
                    cursor.execute(f"SELECT * FROM {name}")
                    rows = cursor.fetchall()

                    if rows:
                        columns = [description[0] for description in cursor.description]
                        placeholders = ", ".join(["?"] * len(columns))
                        column_str = ", ".join(columns)
                        for row in rows:
                            row_data = [row[column] for column in range(len(columns))]
                            encrypted_cursor.execute(
                                f"INSERT INTO {name} ({column_str}) VALUES ({placeholders})",
                                row_data,
                            )
            encrypted_conn.commit()
            source_conn.close()
            encrypted_conn.close()

            shutil.move(db_temp_path, db_path)
            unlock_result = self.unlock_database(password)
            if unlock_result["status"] != "ok":
                return {
                    "status": "error",
                    "message": f"Failed to unlock encrypted database: {unlock_result.get('message', 'Unknown error')}",
                }
            return {"status": "ok"}
        except Exception as e:
            if self.conn:
                try:
                    self.conn.close()
                except:
                    pass
                self.conn = None
            return {"status": "error", "message": f"Encryption failed: {str(e)}"}

    def decrypt_database(self, password):
        """Migrates an encrypted database to an unencrypted one using SQLCipher's native capabilities."""
        if not sqlite_cipher:
            return {"status": "error", "message": "sqlcipher3 is not available."}

        if self.workspace_path is None:
            return {"status": "error", "message": "Workspace not set."}

        db_path = os.path.join(str(self.workspace_path), ".neurotrace", "neurotrace.db")
        db_temp_path = os.path.join(
            str(self.workspace_path), ".neurotrace", "temp_decrypted.db"
        )

        try:
            test_conn = get_sqlcipher_connection(db_path)
            _apply_sqlcipher_key(test_conn, password)
            test_conn.execute("SELECT count(*) FROM sqlite_master")
            test_conn.close()

            if self.conn is not None:
                self.conn.close()
                self.conn = None

            encrypted_conn = get_sqlcipher_connection(db_path)
            _apply_sqlcipher_key(encrypted_conn, password)
            decrypted_conn = sqlite3.connect(db_temp_path)
            cursor = encrypted_conn.cursor()
            cursor.execute("SELECT sql FROM sqlite_master WHERE type='table'")
            tables = cursor.fetchall()
            decrypted_cursor = decrypted_conn.cursor()
            for table in tables:
                if "sqlite_sequence" not in table[0]:
                    decrypted_cursor.execute(table[0])

            cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
            table_names = cursor.fetchall()

            for table_name in table_names:
                name = table_name[0]
                if not name.startswith("sqlite_"):
                    cursor.execute(f"SELECT * FROM {name}")
                    rows = cursor.fetchall()

                    if rows:
                        columns = [description[0] for description in cursor.description]
                        placeholders = ", ".join(["?"] * len(columns))
                        column_str = ", ".join(columns)
                        for row in rows:
                            row_data = [row[column] for column in range(len(columns))]
                            decrypted_cursor.execute(
                                f"INSERT INTO {name} ({column_str}) VALUES ({placeholders})",
                                row_data,
                            )
            decrypted_conn.commit()
            encrypted_conn.close()
            decrypted_conn.close()

            shutil.move(db_temp_path, db_path)
            self.conn = get_db_connection(db_path)
            self.conn.row_factory = sqlite3.Row
            self.connection_status_hint = "UNENCRYPTED"

            return {"status": "ok"}

        except Exception as e:
            if self.conn:
                try:
                    self.conn.close()
                except:
                    pass
                self.conn = None
            self.connection_status_hint = None
            return {"status": "error", "message": f"Decryption failed: {str(e)}"}

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
                    base_path = os.path.dirname(os.path.abspath(__file__))

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

    def ensure_schema(self):
        """Ensure the database schema is created."""
        self.clear_relations()
        if self.conn is None:
            return
        c = self.conn.cursor()
        c.execute(
            """
        CREATE TABLE IF NOT EXISTS relations (
            id TEXT PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL, rel TEXT NOT NULL, meta TEXT
        )
        """
        )
        self.conn.commit()

    def clear_relations(self):
        """Clears all records from the relations table."""
        if self.conn is None:
            return "Database not initialized. Please run 'init' command first."
        cursor = self.conn.cursor()
        cursor.execute("DELETE FROM relations")
        self.conn.commit()
        return "All records from 'relations' have been deleted."

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

    def init(self):
        """Initialize the database and create the necessary tables."""
        setup_error = self._ensure_database_ready()
        if setup_error:
            return setup_error
        self.load_model()
        self.process_all_embeddings()

        return "Initialized database and created 'thoughts' table."

    def add_thought(
        self,
        text,
        file_path=None,
        line=None,
        type=None,
        tags="",
        snippet=None,
        priority=None,
        status=None,
    ):
        """Add a new thought to the database."""
        if not text:
            return "No text provided for new thought."
        if self.conn is None:
            setup_error = self._ensure_database_ready()
            if setup_error:
                if "locked" in setup_error.lower():
                    return {"error": "Database is locked"}
                return {"error": "database_unavailable", "message": setup_error}
        text = _sanitize_text_value(text)
        file_path = _sanitize_text_value(file_path)
        type = _sanitize_text_value(type)
        tags = _sanitize_text_value(tags)
        snippet = _sanitize_text_value(snippet)
        priority = _sanitize_text_value(priority)
        status = _sanitize_text_value(status)
        cursor = self.conn.cursor()
        thought_id = str(uuid.uuid4())
        timestamp = datetime.now().isoformat()
        normalized_type = type or "note"
        normalized_priority = self._normalize_task_priority(normalized_type, priority)
        normalized_status = self._normalize_task_status(normalized_type, status)
        new_thought = {
            "id": thought_id,
            "timestamp": timestamp,
            "text": text,
            "file_path": file_path,
            "line": line,
            "type": normalized_type,
            "tags": tags,
            "snippet": snippet,
            "priority": normalized_priority,
            "status": normalized_status,
        }
        cursor.execute(
            "INSERT INTO thoughts (id, timestamp, text, file_path, line, type, tags, snippet, priority, status) VALUES (:id, :timestamp, :text, :file_path, :line, :type, :tags, :snippet, :priority, :status)",
            new_thought,
        )
        self.conn.commit()
        return new_thought

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

    def edit_thought(
        self,
        thought_id,
        new_text=None,
        new_tags=None,
        new_file_path=None,
        new_line=None,
        new_snippet=None,
        new_priority=None,
        new_status=None,
    ):
        """Edit an existing thought's fields."""
        if self.conn is None:
            return self._connection_error_result()
        if not thought_id:
            return "Thought ID is required for editing."
        thought_id = _sanitize_text_value(thought_id)
        cursor = self.conn.cursor()
        updates, params = [], {}
        if new_text is not None:
            new_text = _sanitize_text_value(new_text)
            updates.append("text = :text")
            params["text"] = new_text
        if new_tags is not None:
            new_tags = _sanitize_text_value(new_tags)
            updates.append("tags = :tags")
            params["tags"] = new_tags
        if new_file_path is not None:
            new_file_path = _sanitize_text_value(new_file_path)
            updates.append("file_path = :file_path")
            params["file_path"] = new_file_path
        if new_line is not None:
            updates.append("line = :line")
            params["line"] = new_line
        if new_snippet is not None:
            new_snippet = _sanitize_text_value(new_snippet)
            updates.append("snippet = :snippet")
            params["snippet"] = new_snippet
        if new_priority is not None:
            new_priority = _sanitize_text_value(new_priority)
            cursor.execute("SELECT type FROM thoughts WHERE id = ?", (thought_id,))
            current_row = cursor.fetchone()
            thought_type = current_row["type"] if current_row else None
            normalized_priority = self._normalize_task_priority(
                thought_type, new_priority
            )
            updates.append("priority = :priority")
            params["priority"] = normalized_priority
        if new_status is not None:
            new_status = _sanitize_text_value(new_status)
            cursor.execute("SELECT type FROM thoughts WHERE id = ?", (thought_id,))
            current_row = cursor.fetchone()
            thought_type = current_row["type"] if current_row else None
            normalized_status = self._normalize_task_status(thought_type, new_status)
            updates.append("status = :status")
            params["status"] = normalized_status

        if updates:
            params["id"] = thought_id
            query = f"UPDATE thoughts SET {', '.join(updates)} WHERE id = :id"
            cursor.execute(query, params)
            self.conn.commit()

        cursor.execute("SELECT * FROM thoughts WHERE id = ?", (thought_id,))
        updated_row = cursor.fetchone()
        return self._strip_embedding_from_row(updated_row) if updated_row else None

    def delete_thought(self, thought_id):
        """Delete a thought from the database."""
        if self.conn is None:
            return self._connection_error_result()
        if not thought_id:
            return "Thought ID is required for deletion."
        cursor = self.conn.cursor()
        cursor.execute("DELETE FROM thoughts WHERE id = ?", (thought_id,))
        self.conn.commit()
        self.build_faiss_index()
        return f"Thought {thought_id} deleted."

    def list_thoughts(self, page=0, page_size=15):
        """List thoughts with pagination."""
        if self.conn is None:
            error_result = self._connection_error_result()
            return {
                "error": error_result.get("error", "Database not initialized"),
                "thoughts": [],
                "total": 0,
                "page": 0,
                "page_size": page_size,
            }

        cursor = self.conn.cursor()
        cursor.execute("SELECT COUNT(*) as count FROM thoughts")
        total = cursor.fetchone()["count"]
        cursor.execute(
            "SELECT * FROM thoughts ORDER BY timestamp DESC LIMIT ? OFFSET ?",
            (page_size, page * page_size),
        )
        rows = cursor.fetchall()
        result = [dict(row) for row in rows]
        for r in result:
            if "embedding" in r:
                del r["embedding"]

        return {
            "thoughts": result,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    def search_entries(self, term):
        """Search for entries in the database by text, type, or tags."""
        if self.conn is None:
            return self._connection_error_result()
        cursor = self.conn.cursor()
        pattern = f"%{term}%"
        cursor.execute(
            "SELECT * FROM thoughts WHERE text LIKE ? OR type LIKE ? OR tags LIKE ? OR status LIKE ? OR file_path LIKE ? ORDER BY timestamp DESC",
            (pattern, pattern, pattern, pattern, pattern),
        )
        rows = cursor.fetchall()
        result = [dict(row) for row in rows]
        for r in result:
            if "embedding" in r:
                del r["embedding"]
        return result

    def get_memories_by_file(self, file_path):
        """Return all thoughts linked to the exact normalized file path."""
        if self.conn is None:
            error_result = self._connection_error_result()
            return {
                "error": error_result.get("error", "Database not initialized"),
                "file_path": file_path,
                "memories": [],
                "count": 0,
            }
        normalized_target = self._normalize_path(file_path)
        if not normalized_target:
            return {"error": "file_path is required", "file_path": file_path, "memories": [], "count": 0}

        cursor = self.conn.cursor()
        cursor.execute(
            "SELECT * FROM thoughts WHERE file_path IS NOT NULL"
        )
        rows = cursor.fetchall()

        matched = []
        for row in rows:
            row_dict = dict(row)
            if self._normalize_path(row_dict.get("file_path")) == normalized_target:
                row_dict.pop("embedding", None)
                matched.append(row_dict)

        sorted_rows = self._sort_thoughts_for_file(matched)
        return {
            "file_path": file_path,
            "memories": sorted_rows,
            "count": len(sorted_rows),
        }

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

    def export_bundle(self, entry_type=None, tag=None, since=None):
        """Export filtered thoughts to markdown."""
        if self.workspace_path is None:
            return "Error: Workspace path not set."

        query = "SELECT * FROM thoughts WHERE 1=1"
        params = []
        if entry_type:
            if isinstance(entry_type, list):
                placeholders = ",".join("?" * len(entry_type))
                query += f" AND type IN ({placeholders})"
                params.extend(entry_type)
            else:
                query += " AND type = ?"
                params.append(entry_type)
        if tag:
            query += " AND tags LIKE ?"
            params.append(f"%{tag}%")
        if since:
            query += " AND timestamp >= ?"
            params.append(since)

        if self.conn is None:
            return "Database not initialized. Please run 'init' command first."

        cursor = self.conn.cursor()
        cursor.execute(query + " ORDER BY timestamp DESC", params)
        rows = cursor.fetchall()
        if not rows:
            return "No thoughts found to export."

        nt_folder = self.workspace_path / ".neurotrace"
        nt_folder.mkdir(exist_ok=True)
        export_name = f"bundle_{datetime.now().strftime('%Y%m%d')}.md"
        export_path = nt_folder / export_name

        def detect_language(file_path):
            if not file_path:
                return ""
            ext = file_path.split(".")[-1].lower()
            lang_map = {
                "py": "python",
                "js": "javascript",
                "ts": "typescript",
                "java": "java",
                "cpp": "cpp",
                "c": "c",
                "cs": "csharp",
                "php": "php",
                "rb": "ruby",
                "go": "go",
                "rs": "rust",
                "sh": "bash",
                "sql": "sql",
                "html": "html",
                "css": "css",
                "json": "json",
                "xml": "xml",
                "yaml": "yaml",
                "yml": "yaml",
                "md": "markdown",
                "txt": "text",
            }
            return lang_map.get(ext, "")

        with open(export_path, "w", encoding="utf-8") as f:
            f.write("# NeuroTrace Bundle Export\n\n")
            for row in rows:
                thought_dict = dict(row)
                f.write(f"## {thought_dict['timestamp']}\n")
                f.write(f"**Thought**: {thought_dict['text']}\n\n")
                if thought_dict["file_path"]:
                    f.write(
                        f"**File**: `{thought_dict['file_path']}:{thought_dict['line']}`\n\n"
                    )
                if thought_dict["type"]:
                    f.write(f"**Type**: {thought_dict['type']}\n\n")
                if thought_dict["tags"]:
                    f.write(f"**Tags**: {thought_dict['tags']}\n\n")
                if thought_dict["snippet"]:
                    lang = detect_language(thought_dict.get("file_path"))
                    cleaned_snippet = thought_dict["snippet"].replace("\n", "")
                    f.write(f"**Snippet**:\n```{lang}\n{cleaned_snippet}\n```\n\n")
                f.write("---\n\n")

        return f"Thoughts exported to {export_path}"

    def count_thoughts(self, entry_type=None, tag=None, since=None):
        """Count filtered thoughts without exporting."""
        if self.workspace_path is None:
            return 0

        query = "SELECT COUNT(*) as count FROM thoughts WHERE 1=1"
        params = []
        if entry_type:
            if isinstance(entry_type, list):
                placeholders = ",".join("?" * len(entry_type))
                query += f" AND type IN ({placeholders})"
                params.extend(entry_type)
            else:
                query += " AND type = ?"
                params.append(entry_type)
        if tag:
            query += " AND tags LIKE ?"
            params.append(f"%{tag}%")
        if since:
            query += " AND timestamp >= ?"
            params.append(since)

        if self.conn is None:
            return 0

        cursor = self.conn.cursor()
        cursor.execute(query, params)
        result = cursor.fetchone()
        return result["count"] if result else 0

    def get_graph_data(self, top_k: int = 3, sim_threshold: float = 0.40):
        """Return graph data: nodes & edges.

        Nodes: {id, label, text, type, file_path, line, timestamp, priority, status}
        Edges: {source, target, rel, weight}
        rel = manual relation type | 'file' | 'semantic'
        """
        if self.conn is None:
            return {"nodes": [], "edges": []}

        cur = self.conn.cursor()
        cur.execute(
            "SELECT id, text, type, tags, file_path, line, timestamp, priority, status FROM thoughts"
        )
        rows = cur.fetchall()

        # 1.  nodes
        nodes = []
        id_to_row = {}
        for r in rows:
            d = dict(r)
            id_to_row[d["id"]] = d
            node_data = {
                "id": d["id"],
                "label": (d["type"] or "note").capitalize(),
                "text": d["text"] or "",
                "type": d["type"] or "note",
                "file_path": d["file_path"] or "No file associated",
                "line": d["line"],
                "timestamp": d["timestamp"] or "",
            }
            if d.get("priority"):
                node_data["priority"] = d["priority"]
            if d.get("status"):
                node_data["status"] = d["status"]
            nodes.append(node_data)

        edges = []
        # 2. Manual relations
        cur.execute("SELECT id, src, dst, rel, meta FROM relations")
        for r in cur.fetchall():
            edges.append(
                {
                    "id": r["id"],
                    "source": r["src"],
                    "target": r["dst"],
                    "rel": r["rel"] or "manual",
                    "weight": 1.0,
                    "meta": r["meta"],
                }
            )

        # 3. explicit edges: same file & ±30 lines ──────────────
        file_map = {}
        for r in rows:
            if r["file_path"]:
                file_map.setdefault(r["file_path"], []).append(r)
        for f, lst in file_map.items():
            for i in range(len(lst)):
                for j in range(i + 1, len(lst)):
                    if abs((lst[i]["line"] or 0) - (lst[j]["line"] or 0)) <= 30:
                        edges.append(
                            {
                                "source": lst[i]["id"],
                                "target": lst[j]["id"],
                                "rel": "file",
                                "weight": 0.8,
                                "meta": "near-code",
                            }
                        )

        # 4.  semantic edges
        if self.faiss_index and self.model:
            for row in rows:
                sims = self.semantic_search(row["text"], top_k, sim_threshold)
                if isinstance(sims, list):
                    for hit in sims:
                        if isinstance(hit, dict) and "id" in hit:
                            edges.append(
                                {
                                    "source": row["id"],
                                    "target": hit["id"],
                                    "rel": "semantic",
                                    "weight": 0.9,
                                    "meta": "emb",
                                }
                            )

        return {"nodes": nodes, "edges": edges}

    def get_graph_insights(self):
        """Calcula nodos aislados, hubs y comunidades simples."""
        try:
            import networkx as nx
        except ImportError:
            return {"status": "error", "msg": "networkx no instalado"}

        data = self.get_graph_data()
        G = nx.Graph()
        for n in data["nodes"]:
            G.add_node(n["id"])
        for e in data["edges"]:
            G.add_edge(e["source"], e["target"])

        isolated = [n for n in nx.isolates(G)]
        degree_dict = dict(G.degree())  # type: ignore
        hubs = sorted(degree_dict, key=lambda k: degree_dict[k], reverse=True)[:5]

        communities = []
        try:
            communities = list(nx.connected_components(G))
        except:
            pass

        return {
            "isolated": isolated,
            "hubs": hubs,
            "communities": [list(c) for c in communities],
        }

    def save_graph_layout(self, layout_dict):
        """Guarda coordenadas de nodos en JSON para persistir layout."""
        if self.workspace_path is None:
            return {"status": "error", "msg": "Workspace path not set"}

        layout_path = os.path.join(
            self.workspace_path, ".neurotrace", "graph_layout.json"
        )
        try:
            os.makedirs(os.path.dirname(layout_path), exist_ok=True)
            with open(layout_path, "w", encoding="utf-8") as f:
                json.dump(layout_dict, f)
            return {"status": "ok"}
        except Exception as e:
            return {"status": "error", "msg": str(e)}

    def add_relation(self, src, dst, rel, meta=None):
        if self.conn is None:
            return {"status": "error", "msg": "Database not initialized."}
        rid = str(uuid.uuid4())
        cur = self.conn.cursor()
        cur.execute(
            "INSERT INTO relations(id,src,dst,rel,meta) VALUES(?,?,?,?,?)",
            (rid, src, dst, rel or "manual", meta),
        )
        self.conn.commit()
        return {"status": "ok", "id": rid}

    def delete_relation(self, id):
        """Deletes a manual relation by its ID."""
        if self.conn is None:
            return {"status": "error", "msg": "Database not initialized."}
        cur = self.conn.cursor()
        cur.execute("DELETE FROM relations WHERE id = ?", (id,))
        self.conn.commit()
        return {"status": "ok", "id": id}

    def update_edge_type(self, id, rel):
        """Updates the relationship type of a manual edge."""
        if self.conn is None:
            return {
                "status": "error",
                "msg": "Database not initialized. Please run 'init' command first.",
            }
        self.conn.execute("UPDATE relations SET rel=? WHERE id=?", (rel, id))
        self.conn.commit()
        return {"status": "ok"}

    def ensure_schema_migration(self):
        """Ensure database schema is up to date with migrations."""
        if self.conn is None:
            return

        cursor = self.conn.cursor()
        cursor.execute("PRAGMA table_info(thoughts)")
        existing_columns = {row["name"] for row in cursor.fetchall()}
        migrations = [
            ("priority", "TEXT"),  # Existing migration
            ("status", "TEXT"),
            # ("due_date", "TEXT"),
            # ("assignee", "TEXT"),
        ]
        added_columns = set()
        for column_name, sql_type in migrations:
            if column_name in existing_columns:
                continue
            cursor.execute(f"ALTER TABLE thoughts ADD COLUMN {column_name} {sql_type}")
            self.conn.commit()
            added_columns.add(column_name)
            print(f"Added {column_name} column to thoughts table", file=sys.stderr)
        if "status" in existing_columns or "status" in added_columns:
            cursor.execute(
                "UPDATE thoughts SET status = ? WHERE type = 'task' AND status = ?",
                (TASK_STATUS_CLOSED, "validated"),
            )
            if cursor.rowcount:
                self.conn.commit()
            cursor.execute(
                "UPDATE thoughts SET status = ? WHERE type = 'task' AND (status IS NULL OR TRIM(status) = '')",
                (TASK_STATUS_OPEN,),
            )
            if cursor.rowcount:
                self.conn.commit()

    def cleanup_and_exit(self):
        """Cleanly closes connections before exiting."""
        self.stop_bridge_server()
        if self.conn:
            try:
                self.conn.close()
            except:
                pass
        self.conn = None
        self.connection_status_hint = None
        return "Server closed correctly."

    def set_workspace(self, workspace):
        """Set the workspace path and check for existing database."""
        if not workspace:
            return "Error: Workspace path cannot be empty."
        new_workspace_path = Path(workspace)
        if (
            self.workspace_path is not None
            and self.workspace_path != new_workspace_path
        ):
            self.stop_bridge_server()
        self.workspace_path = new_workspace_path
        nt_folder = self.workspace_path / ".neurotrace"
        db_path = nt_folder / "neurotrace.db"
        if db_path.exists():
            try:
                self.conn = get_db_connection(db_path)
                self.connection_status_hint = "UNENCRYPTED"
                self.ensure_schema_migration()
                return f"Connected to existing database at {db_path}"
            except Exception:
                self.conn = None
                self.connection_status_hint = None
                return f"Workspace set, database exists but is encrypted."
        else:
            self.connection_status_hint = None
            return f"Workspace set, but database does not exist yet."

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

    def get_total_count(self):
        """Get the total count of thoughts."""
        if self.conn is None:
            return {"total": 0}

        cursor = self.conn.cursor()
        cursor.execute("SELECT COUNT(*) as count FROM thoughts")
        total = cursor.fetchone()["count"]

        return {"total": total}

    def get_graph_layout(self):
        """Carga las coordenadas de nodos guardadas."""
        if self.workspace_path is None:
            return {}

        layout_path = os.path.join(
            self.workspace_path, ".neurotrace", "graph_layout.json"
        )

        if not os.path.exists(layout_path):
            return {}

        try:
            with open(layout_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading graph layout: {e}", file=sys.stderr)
            return {}


###############################################################################
# MCP (Model Context Protocol) stdio server
# Activated with: neurotrace --mcp --workspace /path/to/project
# Speaks JSON-RPC 2.0 over stdin/stdout as defined by the MCP specification.
###############################################################################

MCP_TOOL_DEFINITIONS = [
    {
        "name": "neurotrace_addThought",
        "description": (
            "Create a memory in NeuroTrace. "
            "Use only for durable, high-signal context that will help in a later session: decisions, non-obvious insights, concrete risks, real follow-up tasks, validated hypotheses, discards, or important notes. "
            "Include file_path, line, and snippet when the memory is tied to code. For tasks, include priority and status when applicable. "
            "Do not use for routine progress updates, trivial bug fixes, obvious code changes, or temporary debugging notes. "
            "Prefer fewer, higher-value memories."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["text", "type"],
            "properties": {
                "text": {
                    "type": "string",
                    "description": "Memory text to store.",
                },
                "type": {
                    "type": "string",
                    "enum": [
                        "hypothesis",
                        "decision",
                        "insight",
                        "task",
                        "risk",
                        "discard",
                        "note",
                    ],
                    "description": "Memory type.",
                },
                "tags": {
                    "type": "string",
                    "description": "Comma-separated tags.",
                },
                "file_path": {
                    "type": "string",
                    "description": "Absolute file path linked to this memory.",
                },
                "line": {
                    "type": "number",
                    "description": "1-based line number in file_path.",
                },
                "snippet": {
                    "type": "string",
                    "description": "Related code snippet.",
                },
                "priority": {
                    "type": "string",
                    "enum": ["Low", "Moderate", "High"],
                    "description": "Task priority only.",
                },
                "status": {
                    "type": "string",
                    "enum": [
                        "open",
                        "in-progress",
                        "blocked",
                        "closed",
                        "obsolete",
                    ],
                    "description": (
                        "Task status only: open=pending, in-progress=active, blocked=waiting, "
                        "closed=done, obsolete=no longer relevant."
                    ),
                },
            },
        },
    },
    {
        "name": "neurotrace_listThoughts",
        "description": (
            "List memories with pagination and optional type filter."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "page": {
                    "type": "number",
                    "description": "0-based page number.",
                },
                "page_size": {
                    "type": "number",
                    "description": "Items per page.",
                },
                "type_filter": {
                    "type": "string",
                    "enum": [
                        "hypothesis",
                        "decision",
                        "insight",
                        "task",
                        "risk",
                        "discard",
                        "note",
                    ],
                    "description": "Optional memory type filter.",
                },
            },
        },
    },
    {
        "name": "neurotrace_editThought",
        "description": (
            "Update an existing memory by id. "
            "Use to change text, tags, code reference, task priority, or task status."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["thought_id"],
            "properties": {
                "thought_id": {
                    "type": "string",
                    "description": "Memory id to edit.",
                },
                "new_text": {
                    "type": "string",
                    "description": "New memory text.",
                },
                "new_tags": {
                    "type": "string",
                    "description": "New comma-separated tags.",
                },
                "new_file_path": {
                    "type": "string",
                    "description": "New absolute file path.",
                },
                "new_line": {
                    "type": "number",
                    "description": "New 1-based line number.",
                },
                "new_snippet": {
                    "type": "string",
                    "description": "New related code snippet.",
                },
                "new_priority": {
                    "type": "string",
                    "enum": ["Low", "Moderate", "High"],
                    "description": "New task priority only.",
                },
                "new_status": {
                    "type": "string",
                    "enum": [
                        "open",
                        "in-progress",
                        "blocked",
                        "closed",
                        "obsolete",
                    ],
                    "description": (
                        "New task status only: open=pending, in-progress=active, blocked=waiting, "
                        "closed=done, obsolete=no longer relevant."
                    ),
                },
            },
        },
    },
    {
        "name": "neurotrace_deleteThought",
        "description": (
            "Permanently delete a memory by id."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["thought_id"],
            "properties": {
                "thought_id": {
                    "type": "string",
                    "description": "Memory id to delete.",
                },
            },
        },
    },
    {
        "name": "neurotrace_searchThoughts",
        "description": (
            "Keyword search across memory text, tags, file path, and task status."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["term"],
            "properties": {
                "term": {
                    "type": "string",
                    "description": "Search term.",
                },
            },
        },
    },
    {
        "name": "neurotrace_semanticSearch",
        "description": (
            "Semantic search for conceptually related memories."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language search query.",
                },
            },
        },
    },
    {
        "name": "neurotrace_suggestRelated",
        "description": (
            "Find memories related to a specific memory id."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["thought_id"],
            "properties": {
                "thought_id": {
                    "type": "string",
                    "description": "Memory id to expand from.",
                },
            },
        },
    },
    {
        "name": "neurotrace_getGraphData",
        "description": (
            "Return memory graph nodes and edges for the current workspace."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "include_semantic": {
                    "type": "boolean",
                    "description": "Include semantic similarity edges.",
                },
            },
        },
    },
    {
        "name": "neurotrace_getMemoriesByFile",
        "description": (
            "List memories linked to one exact file path. "
            "Active tasks are returned first, then non-task memories, then closed tasks."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["file_path"],
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute file path.",
                }
            },
        },
    },
    {
        "name": "neurotrace_getGraphInsights",
        "description": (
            "Return graph analytics such as hubs, isolated nodes, and communities."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "neurotrace_addRelation",
        "description": (
            "Create a manual relation between two memories."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["source_id", "target_id", "relation_type"],
            "properties": {
                "source_id": {
                    "type": "string",
                    "description": "Source memory id.",
                },
                "target_id": {
                    "type": "string",
                    "description": "Target memory id.",
                },
                "relation_type": {
                    "type": "string",
                    "enum": [
                        "causes",
                        "blocks",
                        "contradicts",
                        "supports",
                        "related",
                    ],
                    "description": "Relation type.",
                },
            },
        },
    },
    {
        "name": "neurotrace_deleteRelation",
        "description": (
            "Delete a manual relation by relation id."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["relation_id"],
            "properties": {
                "relation_id": {
                    "type": "string",
                    "description": "Relation id to delete.",
                },
            },
        },
    },
    {
        "name": "neurotrace_getDatabaseStatus",
        "description": (
            "Check whether NeuroTrace is ready in this workspace."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _mcp_response(req_id, result):
    """Build a JSON-RPC 2.0 success response."""
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _mcp_error(req_id, code, message):
    """Build a JSON-RPC 2.0 error response."""
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def _mcp_text_content(text):
    """Wrap text in MCP content format."""
    return {"content": [{"type": "text", "text": text}]}


def _locked_database_error_content(
    message: str = "Database is encrypted and locked. Open the NeuroTrace sidebar in your IDE and unlock it there.",
):
    return _mcp_text_content(
        json.dumps(
            {
                "error": "database_locked",
                "message": message,
            }
        )
    )


def _no_database_error_content():
    return _mcp_text_content(
        json.dumps(
            {
                "error": "no_database",
                "message": "No NeuroTrace database exists. Initialize it from the NeuroTrace sidebar.",
            }
        )
    )


def _codex_locked_database_error_content():
    return _locked_database_error_content(
        "Database is encrypted and locked. Open the NeuroTrace sidebar in your IDE and use `Unlock for Codex` to launch the unlock flow in the integrated terminal."
    )


def _normalize_backend_result(result, locked_error_content_factory=None):
    if locked_error_content_factory is None:
        locked_error_content_factory = _locked_database_error_content
    if isinstance(result, dict):
        error_value = result.get("error")
        if error_value:
            error_text = str(error_value).lower().replace("_", " ")
            if "locked" in error_text:
                return None, locked_error_content_factory()
            if "no database" in error_text or error_text == "no_database":
                return None, _no_database_error_content()
            message = result.get("message") or str(error_value)
            return None, _mcp_text_content(
                json.dumps({"error": error_value, "message": message})
            )
    return result, None


class BridgeUnavailableError(RuntimeError):
    pass


class DaemonUnavailableError(RuntimeError):
    pass


def _bridge_unavailable_content():
    return _mcp_text_content(
        json.dumps(
            {
                "error": "bridge_unavailable",
                "message": "Open the NeuroTrace sidebar in your IDE and wait for the backend to start.",
            }
        )
    )


def _daemon_unavailable_content(workspace_path: Optional[str]):
    return _mcp_text_content(
        json.dumps(
            {
                "error": "daemon_unavailable",
                "message": "NeuroTrace standalone daemon is unavailable. Open the NeuroTrace sidebar in your IDE and use `Unlock for Codex` to launch the unlock flow in the integrated terminal, then retry.",
            }
        )
    )


def _read_bridge_info(workspace_path: Optional[str]):
    if not workspace_path:
        raise BridgeUnavailableError(
            "Open the NeuroTrace sidebar in your IDE and wait for the backend to start."
        )

    info_path = Path(workspace_path) / ".neurotrace" / "backend_bridge.json"
    try:
        return json.loads(info_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise BridgeUnavailableError(
            "Open the NeuroTrace sidebar in your IDE and wait for the backend to start."
        ) from exc


def _send_bridge_command(workspace_path: Optional[str], command: str, payload=None):
    bridge_info = _read_bridge_info(workspace_path)
    request = {
        "id": f"bridge-{uuid.uuid4().hex}",
        "token": bridge_info.get("token"),
        "command": command,
        "payload": payload or {},
    }

    try:
        with socket.create_connection(
            (bridge_info.get("host", "127.0.0.1"), int(bridge_info["port"])),
            timeout=2.0,
        ) as sock:
            sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
            response_buffer = b""
            while b"\n" not in response_buffer:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                response_buffer += chunk
    except Exception as exc:
        raise BridgeUnavailableError(
            "Open the NeuroTrace sidebar in your IDE and wait for the backend to start."
        ) from exc

    if not response_buffer:
        raise BridgeUnavailableError(
            "Open the NeuroTrace sidebar in your IDE and wait for the backend to start."
        )

    response = json.loads(response_buffer.split(b"\n", 1)[0].decode("utf-8"))
    if not response.get("success"):
        raise RuntimeError(response.get("error", "Bridge request failed."))

    return response.get("data")


def _get_daemon_info_path(workspace_path: str) -> Path:
    return Path(workspace_path) / ".neurotrace" / STANDALONE_DAEMON_INFO_FILENAME


def _write_daemon_info(workspace_path: str, host: str, port: int, token: str) -> Path:
    info_path = _get_daemon_info_path(workspace_path)
    info_path.parent.mkdir(parents=True, exist_ok=True)
    info_path.write_text(
        json.dumps(
            {
                "host": host,
                "port": port,
                "token": token,
                "pid": os.getpid(),
                "workspace": workspace_path,
            }
        ),
        encoding="utf-8",
    )
    return info_path


def _remove_daemon_info(workspace_path: str) -> None:
    info_path = _get_daemon_info_path(workspace_path)
    if not info_path.exists():
        return
    try:
        info_path.unlink()
    except OSError:
        pass


def _read_daemon_info(workspace_path: Optional[str]):
    if not workspace_path:
        raise DaemonUnavailableError("Workspace path is required to use NeuroTrace standalone mode.")

    info_path = _get_daemon_info_path(workspace_path)
    try:
        return json.loads(info_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise DaemonUnavailableError(
            "NeuroTrace standalone daemon is not running for this workspace."
        ) from exc


def _send_socket_command(
    endpoint_info, command: str, payload=None, timeout: float = 2.0
):
    request = {
        "id": f"socket-{uuid.uuid4().hex}",
        "token": endpoint_info.get("token"),
        "command": command,
        "payload": payload or {},
    }
    response_buffer = b""

    with socket.create_connection(
        (endpoint_info.get("host", "127.0.0.1"), int(endpoint_info["port"])),
        timeout=timeout,
    ) as sock:
        sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
        while b"\n" not in response_buffer:
            chunk = sock.recv(65536)
            if not chunk:
                break
            response_buffer += chunk

    if not response_buffer:
        raise RuntimeError("Empty response from NeuroTrace endpoint.")

    response = json.loads(response_buffer.split(b"\n", 1)[0].decode("utf-8"))
    if not response.get("success"):
        raise RuntimeError(response.get("error", "Socket request failed."))

    return response.get("data")


def _build_daemon_spawn_args(workspace_path: str):
    if getattr(sys, "frozen", False):
        return [sys.executable, "--daemon", "--workspace", workspace_path]
    return [sys.executable, os.path.abspath(__file__), "--daemon", "--workspace", workspace_path]


def _spawn_detached_process(args):
    kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(args, **kwargs)


def _ensure_standalone_daemon_running(workspace_path: Optional[str]):
    if not workspace_path:
        raise DaemonUnavailableError("Workspace path is required to use NeuroTrace standalone mode.")

    try:
        daemon_info = _read_daemon_info(workspace_path)
        _send_socket_command(daemon_info, "check_db_status", {})
        return daemon_info
    except Exception:
        _remove_daemon_info(workspace_path)

    Path(workspace_path, ".neurotrace").mkdir(parents=True, exist_ok=True)
    _spawn_detached_process(_build_daemon_spawn_args(workspace_path))

    deadline = time.time() + 5.0
    last_error = None
    while time.time() < deadline:
        try:
            daemon_info = _read_daemon_info(workspace_path)
            _send_socket_command(daemon_info, "check_db_status", {})
            return daemon_info
        except Exception as exc:
            last_error = exc
            time.sleep(0.1)

    raise DaemonUnavailableError(
        "NeuroTrace standalone daemon could not be started."
    ) from last_error


def _send_daemon_command(workspace_path: Optional[str], command: str, payload=None):
    try:
        daemon_info = _ensure_standalone_daemon_running(workspace_path)
        return _send_socket_command(daemon_info, command, payload)
    except DaemonUnavailableError:
        raise
    except Exception as exc:
        raise DaemonUnavailableError(
            "NeuroTrace standalone daemon is unavailable for this workspace."
        ) from exc


def _handle_mcp_tool_call_via_remote(
    workspace_path,
    tool_name,
    arguments,
    send_command,
    unavailable_error,
    unavailable_content,
    locked_error_content_factory,
):
    try:
        if tool_name == "neurotrace_addThought":
            result, error_content = _normalize_backend_result(
                send_command(workspace_path, "add_thought", arguments),
                locked_error_content_factory,
            )
            if error_content:
                return error_content
            return _mcp_text_content(
                json.dumps(
                    {
                        "success": True,
                        "id": result.get("id"),
                        "timestamp": result.get("timestamp"),
                    }
                )
            )

        elif tool_name == "neurotrace_listThoughts":
            page = arguments.get("page", 0)
            page_size = arguments.get("page_size", 20)
            type_filter = arguments.get("type_filter")
            result = send_command(
                workspace_path,
                "list",
                {"page": page, "page_size": page_size},
            )
            result, error_content = _normalize_backend_result(
                result, locked_error_content_factory
            )
            if error_content:
                return error_content
            thoughts = result.get("thoughts", [])
            if type_filter:
                thoughts = [t for t in thoughts if t.get("type") == type_filter]
            return _mcp_text_content(
                json.dumps(
                    {
                        "thoughts": thoughts,
                        "total": result.get("total", 0),
                        "page": result.get("page", 0),
                        "page_size": page_size,
                        "has_more": (result.get("page", 0) + 1) * page_size
                        < result.get("total", 0),
                    }
                )
            )

        elif tool_name == "neurotrace_editThought":
            thought_id = arguments["thought_id"]
            new_text = arguments.get("new_text")
            new_tags = arguments.get("new_tags")
            new_file_path = arguments.get("new_file_path")
            new_line = arguments.get("new_line")
            new_snippet = arguments.get("new_snippet")
            new_priority = arguments.get("new_priority")
            new_status = arguments.get("new_status")
            updated = send_command(
                workspace_path,
                "edit",
                {
                    "thought_id": thought_id,
                    "new_text": new_text,
                    "new_tags": new_tags,
                    "new_file_path": new_file_path,
                    "new_line": new_line,
                    "new_snippet": new_snippet,
                    "new_priority": new_priority,
                    "new_status": new_status,
                },
            )
            updated, error_content = _normalize_backend_result(
                updated, locked_error_content_factory
            )
            if error_content:
                return error_content
            if new_text and updated and updated.get("id"):
                send_command(
                    workspace_path,
                    "process-one",
                    {"thought_id": updated["id"]},
                )
            return _mcp_text_content(json.dumps({"success": True, "thought": updated}))

        elif tool_name == "neurotrace_getMemoriesByFile":
            result, error_content = _normalize_backend_result(
                send_command(
                    workspace_path,
                    "get_memories_by_file",
                    {"file_path": arguments["file_path"]},
                ),
                locked_error_content_factory,
            )
            if error_content:
                return error_content
            return _mcp_text_content(
                json.dumps(
                    {
                        "file_path": result.get("file_path", arguments["file_path"]),
                        "memories": result.get("memories", []),
                        "count": result.get("count", 0),
                    }
                )
            )

        elif tool_name == "neurotrace_deleteThought":
            result, error_content = _normalize_backend_result(
                send_command(
                    workspace_path,
                    "delete",
                    {"thought_id": arguments["thought_id"]},
                ),
                locked_error_content_factory,
            )
            if error_content:
                return error_content
            return _mcp_text_content(
                json.dumps({"success": True, "deleted": arguments["thought_id"]})
            )

        elif tool_name == "neurotrace_searchThoughts":
            results, error_content = _normalize_backend_result(
                send_command(
                    workspace_path,
                    "search",
                    {"term": arguments["term"]},
                ),
                locked_error_content_factory,
            )
            if error_content:
                return error_content
            return _mcp_text_content(
                json.dumps(
                    {"results": results, "count": len(results) if results else 0}
                )
            )

        elif tool_name == "neurotrace_semanticSearch":
            results, error_content = _normalize_backend_result(
                send_command(
                    workspace_path,
                    "semantic-search",
                    {"query": arguments["query"]},
                ),
                locked_error_content_factory,
            )
            if error_content:
                return error_content
            return _mcp_text_content(
                json.dumps(
                    {"results": results, "count": len(results) if results else 0}
                )
            )

        elif tool_name == "neurotrace_suggestRelated":
            results, error_content = _normalize_backend_result(
                send_command(
                    workspace_path,
                    "suggest",
                    {"thought_id": arguments["thought_id"]},
                ),
                locked_error_content_factory,
            )
            if error_content:
                return error_content
            return _mcp_text_content(
                json.dumps(
                    {"related": results, "count": len(results) if results else 0}
                )
            )

        elif tool_name == "neurotrace_getGraphData":
            data, error_content = _normalize_backend_result(
                send_command(workspace_path, "graph-data", {}),
                locked_error_content_factory,
            )
            if error_content:
                return error_content
            if not arguments.get("include_semantic") and data and data.get("edges"):
                data["edges"] = [e for e in data["edges"] if e.get("rel") != "semantic"]
            return _mcp_text_content(
                json.dumps(
                    {
                        "nodes": data.get("nodes", []),
                        "edges": data.get("edges", []),
                        "node_count": len(data.get("nodes", [])),
                        "edge_count": len(data.get("edges", [])),
                    }
                )
            )

        elif tool_name == "neurotrace_getGraphInsights":
            insights, error_content = _normalize_backend_result(
                send_command(workspace_path, "graph-insights", {}),
                locked_error_content_factory,
            )
            if error_content:
                return error_content
            return _mcp_text_content(json.dumps(insights))

        elif tool_name == "neurotrace_addRelation":
            result, error_content = _normalize_backend_result(
                send_command(
                    workspace_path,
                    "add-relation",
                    {
                        "src": arguments["source_id"],
                        "dst": arguments["target_id"],
                        "rel": arguments["relation_type"],
                    },
                ),
                locked_error_content_factory,
            )
            if error_content:
                return error_content
            return _mcp_text_content(
                json.dumps(
                    {
                        "success": True,
                        "source": arguments["source_id"],
                        "target": arguments["target_id"],
                        "relation": arguments["relation_type"],
                    }
                )
            )

        elif tool_name == "neurotrace_deleteRelation":
            result, error_content = _normalize_backend_result(
                send_command(
                    workspace_path,
                    "delete-relation",
                    {"id": arguments["relation_id"]},
                ),
                locked_error_content_factory,
            )
            if error_content:
                return error_content
            return _mcp_text_content(
                json.dumps({"success": True, "deleted": arguments["relation_id"]})
            )

        elif tool_name == "neurotrace_getDatabaseStatus":
            status_result, error_content = _normalize_backend_result(
                send_command(workspace_path, "check_db_status", {}),
                locked_error_content_factory,
            )
            if error_content:
                return error_content
            status = status_result.get("status", "UNKNOWN")
            out = {"database_status": status, "backend_running": True}
            if status in ("UNENCRYPTED", "UNLOCKED"):
                count, count_error_content = _normalize_backend_result(
                    send_command(workspace_path, "get_total_count", {}),
                    locked_error_content_factory,
                )
                if count_error_content:
                    return count_error_content
                out["total_thoughts"] = count.get("total", 0)
            return _mcp_text_content(json.dumps(out))

        raise ValueError(f"Unknown tool: {tool_name}")
    except unavailable_error:
        return unavailable_content(workspace_path)


def _handle_mcp_tool_call_via_bridge(workspace_path, tool_name, arguments):
    return _handle_mcp_tool_call_via_remote(
        workspace_path,
        tool_name,
        arguments,
        _send_bridge_command,
        BridgeUnavailableError,
        lambda _workspace_path: _bridge_unavailable_content(),
        _locked_database_error_content,
    )


def _handle_mcp_tool_call_via_daemon(workspace_path, tool_name, arguments):
    return _handle_mcp_tool_call_via_remote(
        workspace_path,
        tool_name,
        arguments,
        _send_daemon_command,
        DaemonUnavailableError,
        _daemon_unavailable_content,
        _codex_locked_database_error_content,
    )


COMMAND_MAPPING = {
    "list": "list_thoughts",
    "add_thought": "add_thought",
    "edit": "edit_thought",
    "delete": "delete_thought",
    "search": "search_entries",
    "semantic-search": "semantic_search",
    "suggest": "suggest_related",
    "process-one": "process_single_embedding",
    "init": "init",
    "export-bundle": "export_bundle",
    "count_thoughts": "count_thoughts",
    "exit": "cleanup_and_exit",
    "set_workspace": "set_workspace",
    "build_index": "build_faiss_index",
    "load_model": "load_model",
    "graph-data": "get_graph_data",
    "get-graph-layout": "get_graph_layout",
    "save-graph-layout": "save_graph_layout",
    "graph-insights": "get_graph_insights",
    "get_memories_by_file": "get_memories_by_file",
    "add-relation": "add_relation",
    "delete-relation": "delete_relation",
    "update-edge-type": "update_edge_type",
    "get_total_count": "get_total_count",
    "check_db_status": "check_db_status",
    "unlock_database": "unlock_database",
    "encrypt_database": "encrypt_database",
    "decrypt_database": "decrypt_database",
}


def execute_backend_command(server, command, payload):
    with server.command_lock:
        method_name = COMMAND_MAPPING.get(command)
        if not method_name:
            raise ValueError(f"Unknown command: {command}")

        if command == "set_workspace":
            result = server.set_workspace(payload.get("workspace"))
            server.ensure_schema()
            server.start_bridge_server()
            return result

        method_to_call = getattr(server, method_name, None)
        if not callable(method_to_call):
            raise ValueError(f"Method {method_name} not found for command: {command}")

        result = method_to_call(**payload)
        if command == "init":
            server.build_faiss_index()
        return result


def _handle_mcp_tool_call(server, tool_name, arguments):
    """
    Dispatch an MCP tools/call to the appropriate NeuroTraceServer method.
    Returns MCP content dict or raises on error.
    """
    if server.conn is None:
        status = server.check_db_status().get("status", "UNKNOWN")
        if status == "NO_DB":
            return _no_database_error_content()
        elif status == "LOCKED":
            return _locked_database_error_content()

    if tool_name == "neurotrace_addThought":
        result, error_content = _normalize_backend_result(
            server.add_thought(**arguments)
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps(
                {
                    "success": True,
                    "id": result.get("id"),
                    "timestamp": result.get("timestamp"),
                }
            )
        )

    elif tool_name == "neurotrace_listThoughts":
        page = arguments.get("page", 0)
        page_size = arguments.get("page_size", 20)
        type_filter = arguments.get("type_filter")
        result, error_content = _normalize_backend_result(
            server.list_thoughts(page=page, page_size=page_size)
        )
        if error_content:
            return error_content
        thoughts = result.get("thoughts", [])
        if type_filter:
            thoughts = [t for t in thoughts if t.get("type") == type_filter]
        return _mcp_text_content(
            json.dumps(
                {
                    "thoughts": thoughts,
                    "total": result.get("total", 0),
                    "page": result.get("page", 0),
                    "page_size": page_size,
                    "has_more": (result.get("page", 0) + 1) * page_size
                    < result.get("total", 0),
                }
            )
        )

    elif tool_name == "neurotrace_editThought":
        thought_id = arguments["thought_id"]
        new_text = arguments.get("new_text")
        new_tags = arguments.get("new_tags")
        new_file_path = arguments.get("new_file_path")
        new_line = arguments.get("new_line")
        new_snippet = arguments.get("new_snippet")
        new_priority = arguments.get("new_priority")
        new_status = arguments.get("new_status")
        updated, error_content = _normalize_backend_result(
            server.edit_thought(
                thought_id=thought_id,
                new_text=new_text,
                new_tags=new_tags,
                new_file_path=new_file_path,
                new_line=new_line,
                new_snippet=new_snippet,
                new_priority=new_priority,
                new_status=new_status,
            )
        )
        if error_content:
            return error_content
        if new_text and updated and updated.get("id"):
            server.process_single_embedding(thought_id=updated["id"])
        return _mcp_text_content(json.dumps({"success": True, "thought": updated}))

    elif tool_name == "neurotrace_getMemoriesByFile":
        result, error_content = _normalize_backend_result(
            server.get_memories_by_file(file_path=arguments["file_path"])
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps(
                {
                    "file_path": result.get("file_path", arguments["file_path"]),
                    "memories": result.get("memories", []),
                    "count": result.get("count", 0),
                }
            )
        )

    elif tool_name == "neurotrace_deleteThought":
        result, error_content = _normalize_backend_result(
            server.delete_thought(thought_id=arguments["thought_id"])
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps({"success": True, "deleted": arguments["thought_id"]})
        )

    elif tool_name == "neurotrace_searchThoughts":
        results, error_content = _normalize_backend_result(
            server.search_entries(term=arguments["term"])
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps({"results": results, "count": len(results) if results else 0})
        )

    elif tool_name == "neurotrace_semanticSearch":
        results, error_content = _normalize_backend_result(
            server.semantic_search(query=arguments["query"])
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps({"results": results, "count": len(results) if results else 0})
        )

    elif tool_name == "neurotrace_suggestRelated":
        results, error_content = _normalize_backend_result(
            server.suggest_related(thought_id=arguments["thought_id"])
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps({"related": results, "count": len(results) if results else 0})
        )

    elif tool_name == "neurotrace_getGraphData":
        data, error_content = _normalize_backend_result(server.get_graph_data())
        if error_content:
            return error_content
        if not arguments.get("include_semantic") and data and data.get("edges"):
            data["edges"] = [e for e in data["edges"] if e.get("rel") != "semantic"]
        return _mcp_text_content(
            json.dumps(
                {
                    "nodes": data.get("nodes", []),
                    "edges": data.get("edges", []),
                    "node_count": len(data.get("nodes", [])),
                    "edge_count": len(data.get("edges", [])),
                }
            )
        )

    elif tool_name == "neurotrace_getGraphInsights":
        insights, error_content = _normalize_backend_result(server.get_graph_insights())
        if error_content:
            return error_content
        return _mcp_text_content(json.dumps(insights))

    elif tool_name == "neurotrace_addRelation":
        result, error_content = _normalize_backend_result(
            server.add_relation(
                src=arguments["source_id"],
                dst=arguments["target_id"],
                rel=arguments["relation_type"],
            )
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps(
                {
                    "success": True,
                    "source": arguments["source_id"],
                    "target": arguments["target_id"],
                    "relation": arguments["relation_type"],
                }
            )
        )

    elif tool_name == "neurotrace_deleteRelation":
        result, error_content = _normalize_backend_result(
            server.delete_relation(id=arguments["relation_id"])
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps({"success": True, "deleted": arguments["relation_id"]})
        )

    elif tool_name == "neurotrace_getDatabaseStatus":
        status_result, error_content = _normalize_backend_result(
            server.check_db_status()
        )
        if error_content:
            return error_content
        status = status_result.get("status", "UNKNOWN")
        out = {"database_status": status, "backend_running": True}
        if status in ("UNENCRYPTED", "UNLOCKED"):
            count, count_error_content = _normalize_backend_result(
                server.get_total_count()
            )
            if count_error_content:
                return count_error_content
            out["total_thoughts"] = count.get("total", 0)
        return _mcp_text_content(json.dumps(out))

    else:
        raise ValueError(f"Unknown tool: {tool_name}")


def main_mcp():
    """MCP stdio server main loop (JSON-RPC 2.0)."""
    # Parse workspace from CLI args
    workspace_path = None
    args = sys.argv[1:]
    bridge_required = "--bridge-required" in args
    for i, arg in enumerate(args):
        if arg == "--workspace" and i + 1 < len(args):
            workspace_path = args[i + 1]

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method", "")

            if method == "initialize":
                response = _mcp_response(
                    req_id,
                    {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "neurotrace", "version": BACKEND_VERSION},
                    },
                )

            elif method == "notifications/initialized":
                # Client acknowledgement — no response needed
                continue

            elif method == "tools/list":
                response = _mcp_response(req_id, {"tools": MCP_TOOL_DEFINITIONS})

            elif method == "tools/call":
                params = req.get("params", {})
                tool_name = params.get("name", "")
                arguments = params.get("arguments", {})
                if bridge_required:
                    content = _handle_mcp_tool_call_via_bridge(
                        workspace_path, tool_name, arguments
                    )
                else:
                    content = _handle_mcp_tool_call_via_daemon(
                        workspace_path, tool_name, arguments
                    )
                response = _mcp_response(req_id, content)

            elif method == "ping":
                response = _mcp_response(req_id, {})

            else:
                response = _mcp_error(req_id, -32601, f"Method not found: {method}")

        except json.JSONDecodeError as e:
            response = _mcp_error(req_id, -32700, f"Parse error: {e}")
        except Exception as e:
            response = _mcp_error(
                req_id, -32603, f"Internal error: {type(e).__name__}: {e}"
            )

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


def _parse_workspace_arg(args) -> Optional[str]:
    for i, arg in enumerate(args):
        if arg == "--workspace" and i + 1 < len(args):
            return args[i + 1]
    return None


def main_daemon():
    workspace_path = _parse_workspace_arg(sys.argv[1:])
    if not workspace_path:
        print("Missing required --workspace argument.", file=sys.stderr)
        sys.exit(1)

    server = NeuroTraceServer(None)
    server.set_workspace(workspace_path)
    daemon_token = uuid.uuid4().hex

    class ThreadedDaemonServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    class DaemonHandler(socketserver.StreamRequestHandler):
        def handle(self):
            while True:
                line = self.rfile.readline()
                if not line:
                    break

                req_id = None
                try:
                    req = json.loads(line.decode("utf-8"))
                    req_id = req.get("id")
                    if req.get("token") != daemon_token:
                        response = {
                            "id": req_id,
                            "error": "Unauthorized daemon request.",
                            "success": False,
                        }
                    else:
                        result = execute_backend_command(
                            server,
                            req.get("command", ""),
                            req.get("payload", {}),
                        )
                        response = {"id": req_id, "data": result, "success": True}
                except Exception as e:
                    response = {
                        "id": req_id,
                        "error": f"Python Error: {type(e).__name__}: {e}",
                        "success": False,
                    }

                self.wfile.write((json.dumps(response) + "\n").encode("utf-8"))
                self.wfile.flush()

    daemon_server = ThreadedDaemonServer(("127.0.0.1", 0), DaemonHandler)
    daemon_port = int(daemon_server.server_address[1])
    _write_daemon_info(workspace_path, "127.0.0.1", daemon_port, daemon_token)

    try:
        daemon_server.serve_forever()
    finally:
        try:
            daemon_server.server_close()
        except Exception:
            pass
        _remove_daemon_info(workspace_path)
        try:
            server.cleanup_and_exit()
        except Exception:
            pass


def main_unlock():
    workspace_path = _parse_workspace_arg(sys.argv[1:])
    if not workspace_path:
        print("Missing required --workspace argument.", file=sys.stderr)
        sys.exit(1)

    try:
        password = getpass.getpass("NeuroTrace passphrase: ")
        result = _send_daemon_command(
            workspace_path, "unlock_database", {"password": password}
        )
        if isinstance(result, dict) and result.get("status") == "ok":
            print("Database unlocked successfully.")
            return

        message = (
            result.get("message")
            if isinstance(result, dict)
            else "Failed to unlock NeuroTrace database."
        )
        print(message, file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"Failed to unlock database: {exc}", file=sys.stderr)
        sys.exit(1)


def main():
    """Main loop of the server (custom protocol for VS Code extension)."""
    # 1. Initialize the server without a database yet.
    bridge_enabled = os.environ.get("NEUROTRACE_ENABLE_BRIDGE") == "1"
    server = NeuroTraceServer(None, bridge_enabled=bridge_enabled)

    # 3. Start the loop to listen to all commands.
    for line in sys.stdin:
        req_id = None
        try:
            req = json.loads(line)
            command = req.get("command", "")
            payload = req.get("payload", {})
            req_id = req.get("id")

            result = execute_backend_command(server, command, payload)

            response = {"id": req_id, "data": result, "success": True}

        except Exception as e:
            response = {
                "id": req_id,
                "error": f"Python Error: {type(e).__name__}: {e}",
                "success": False,
            }

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    if "--version" in sys.argv:
        print(BACKEND_VERSION)
    elif "--daemon" in sys.argv:
        main_daemon()
    elif "--unlock" in sys.argv:
        main_unlock()
    elif "--mcp" in sys.argv:
        main_mcp()
    else:
        main()
