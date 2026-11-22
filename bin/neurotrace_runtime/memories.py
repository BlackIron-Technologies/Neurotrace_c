from .common import (_sanitize_text_value, datetime, uuid)

class MemoryMixin:
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


    def get_total_count(self):
        """Get the total count of thoughts."""
        if self.conn is None:
            return {"total": 0}

        cursor = self.conn.cursor()
        cursor.execute("SELECT COUNT(*) as count FROM thoughts")
        total = cursor.fetchone()["count"]

        return {"total": total}
