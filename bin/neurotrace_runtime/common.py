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

from neurotrace_version import BACKEND_VERSION
STANDALONE_DAEMON_INFO_FILENAME = "standalone_daemon.json"


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

BACKEND_ROOT = Path(__file__).resolve().parent.parent
