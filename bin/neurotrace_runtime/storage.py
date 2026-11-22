from .common import (ACTIVE_TASK_STATUSES, CLOSED_TASK_STATUSES, Optional, PRIORITY_CANONICAL, PRIORITY_ORDER, TASK_STATUS_CLOSED, TASK_STATUS_OPEN, _apply_sqlcipher_key, datetime, get_db_connection, get_sqlcipher_connection, os, shutil, sqlite3, sqlite_cipher, sys)

class StorageMixin:
    def init(self):
        """Initialize workspace storage and its local search index."""
        setup_error = self._ensure_database_ready()
        if setup_error:
            return setup_error
        self.load_model()
        self.process_all_embeddings()
        return "Initialized database and created 'thoughts' table."

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


    def ensure_schema(self):
        """Ensure the database schema is created."""
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
