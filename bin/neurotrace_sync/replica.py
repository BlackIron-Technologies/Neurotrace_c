"""Atomic local edits, durable upload queue and incremental projections."""
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .domain import FIELDS, validate_fields
from .text import merge_text, replace_text


class Replica:
    def __init__(self, conn, workspace, project):
        self.conn, self.workspace, self.project = conn, Path(workspace).resolve(), project
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS sync_binding(project TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS sync_documents(id TEXT PRIMARY KEY, document TEXT);
            CREATE TABLE IF NOT EXISTS sync_versions(id TEXT NOT NULL, text TEXT NOT NULL, document TEXT NOT NULL,
                PRIMARY KEY(id,text));
            CREATE TABLE IF NOT EXISTS sync_canonical(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sync_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL,
                record TEXT NOT NULL, operation TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', error TEXT, draft TEXT);
        """)
        if 'draft' not in {r[1] for r in conn.execute('PRAGMA table_info(sync_outbox)')}:
            conn.execute("ALTER TABLE sync_outbox ADD COLUMN draft TEXT")
        if 'server_seq' not in {r[1] for r in conn.execute('PRAGMA table_info(sync_outbox)')}:
            conn.execute("ALTER TABLE sync_outbox ADD COLUMN server_seq INTEGER")
        if 'seq' not in {r[1] for r in conn.execute('PRAGMA table_info(sync_canonical)')}:
            conn.execute("ALTER TABLE sync_canonical ADD COLUMN seq INTEGER NOT NULL DEFAULT 0")
        binding = conn.execute("SELECT project FROM sync_binding").fetchone()
        if binding and binding[0] != project:
            raise ValueError("This local database is bound to another project; open a new workspace to connect elsewhere")
        conn.execute("INSERT OR IGNORE INTO sync_binding(project) VALUES(?)", (project,))
        conn.commit()

    def cursor(self):
        return self.conn.execute("SELECT cursor FROM sync_binding WHERE project=?", (self.project,)).fetchone()[0]

    def document(self, record):
        row = self.conn.execute("SELECT document FROM sync_documents WHERE id=?", (record,)).fetchone()
        return row[0] if row else None

    def remember(self, record, document, text):
        self.conn.execute("INSERT INTO sync_documents VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document", (record, document))
        if document:
            self.conn.execute("INSERT OR REPLACE INTO sync_versions VALUES(?,?,?)", (record, text, document))

    def fields_to_wire(self, fields):
        fields = dict(fields)
        path = fields.get("file_path")
        if path:
            absolute = Path(path).resolve() if Path(path).is_absolute() else (self.workspace / path).resolve()
            try:
                fields["file_path"] = absolute.relative_to(self.workspace).as_posix()
            except ValueError:
                raise ValueError("Shared code references must be inside this workspace") from None
        validate_fields(fields)
        return fields

    def enqueue(self, record, action, fields=None, text=None, base_text=None):
        with self.conn:
            return self._enqueue(record, action, fields, text, base_text)

    def _enqueue(self, record, action, fields=None, text=None, base_text=None):
        operation = {"op_id": str(uuid.uuid4()), "id": record, "action": action}
        if fields is not None:
            operation["fields"] = self.fields_to_wire(fields) if action in ("create", "edit") else fields
        document, merged = None, None
        if text is not None:
            if not isinstance(text, str) or not (1 if action == "create" else 0) <= len(text) <= 100000:
                raise ValueError("Memory text exceeds its allowed length")
            state = self.document(record)
            base = state
            if base_text is not None:
                row = self.conn.execute("SELECT document FROM sync_versions WHERE id=? AND text=?", (record, base_text)).fetchone()
                if not row:
                    raise ValueError("The editor base is no longer available; reload this memory before saving")
                base = row[0]
            _, operation["text_update"], _ = replace_text(base, text)
            document, merged = merge_text(state, operation["text_update"])
        self.conn.execute("INSERT INTO sync_outbox(op_id,record,operation,draft) VALUES(?,?,?,?)",
                          (operation["op_id"], record, json.dumps(operation), json.dumps({"text": merged, "fields": fields})))
        if document:
            self.remember(record, document, merged)
        self.project_record(record)
        return operation

    def pending(self):
        return [dict(r) for r in self.conn.execute("SELECT * FROM sync_outbox WHERE state='pending' ORDER BY seq")]

    def project_record(self, record_id):
        row = self.conn.execute("SELECT payload FROM sync_canonical WHERE id=?", (record_id,)).fetchone()
        canonical = json.loads(row[0]) if row else None
        pending = [json.loads(r[0]) for r in self.conn.execute("SELECT operation FROM sync_outbox WHERE record=? AND state='pending' ORDER BY seq", (record_id,))]
        if canonical and canonical["deleted"]:
            self.conn.execute("DELETE FROM thoughts WHERE id=?", (record_id,))
            self.conn.execute("DELETE FROM relations WHERE id=?", (record_id,))
            return
        data = dict(canonical["data"]) if canonical else {}
        kind = canonical["kind"] if canonical else None
        deleted = False
        for operation in pending:
            action = operation["action"]
            if action in ("create", "edit"):
                kind = "thought"
                data.update(operation.get("fields", {}))
            elif action == "relation":
                kind = "relation"
                data.update(operation["fields"])
            elif action in ("delete", "delete_relation"):
                deleted = True
        if deleted:
            self.conn.execute("DELETE FROM thoughts WHERE id=?", (record_id,))
            self.conn.execute("DELETE FROM relations WHERE id=? OR src=? OR dst=?", (record_id, record_id, record_id))
        elif kind == "thought":
            from .text import load_document
            data["text"] = str(load_document(self.document(record_id))["text"])
            if data.get("file_path"):
                data["file_path"] = str(self.workspace / data["file_path"])
            values = {k: data.get(k) for k in FIELDS | {"text"}}
            values.update(id=record_id)
            columns = ["id", "timestamp", "text", "file_path", "line", "type", "tags", "snippet", "priority", "status"]
            self.conn.execute("INSERT INTO thoughts(" + ",".join(columns) + ") VALUES(" + ",".join(":" + k for k in columns) + ") "
                              "ON CONFLICT(id) DO UPDATE SET " + ",".join(k + "=excluded." + k for k in columns if k != "id") + ",embedding=NULL", values)
        elif kind == "relation":
            endpoints = [self.conn.execute("SELECT 1 FROM thoughts WHERE id=?", (data[k],)).fetchone() for k in ("src", "dst")]
            if all(endpoints):
                self.conn.execute("INSERT INTO relations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET rel=excluded.rel,meta=excluded.meta",
                                  (record_id, data["src"], data["dst"], data["rel"], data.get("meta")))

    def apply_record(self, record, seq=0):
        if not record:
            return
        record_id = record["id"]
        self.conn.execute("INSERT INTO sync_canonical(id,payload,seq) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,seq=excluded.seq", (record_id, json.dumps(record), seq))
        if record["kind"] == "thought" and record["document"]:
            document, text = merge_text(self.document(record_id), record["document"])
            self.remember(record_id, document, text)
        self.project_record(record_id)

    def apply_page(self, page):
        with self.conn:
            for event in page["events"]:
                payload = event["payload"]
                state = "recovered" if payload["outcome"] == "deleted" else "delivered"
                self.conn.execute("UPDATE sync_outbox SET state=?,server_seq=? WHERE op_id=?", (state, event['seq'], event["operation"]))
                self.apply_record(payload["record"], event['seq'])
                for edge in payload.get("relations", []):
                    self.apply_record(edge, event['seq'])
            self.conn.execute("UPDATE sync_binding SET cursor=? WHERE project=?", (page["cursor"], self.project))

    def initialize(self, snapshot, publish=False):
        if self.cursor() or self.conn.execute("SELECT 1 FROM sync_canonical LIMIT 1").fetchone():
            return
        local = [dict(r) for r in self.conn.execute("SELECT * FROM thoughts")]
        relations = [dict(r) for r in self.conn.execute("SELECT * FROM relations")]
        if local and snapshot["records"] and not publish:
            raise ValueError("Both sides contain memories. Enable explicit import to preserve both sets, or use an empty workspace")
        if local and not publish:
            raise ValueError("Choose Publish to share the memories in this workspace")
        if local and snapshot["role"] == "viewer":
            raise ValueError("Read-only members cannot publish local memories")
        if local and publish:
            from .importing import import_existing
            return import_existing(self, snapshot, local, relations)
        # Import, outgoing operations and initial cursor share a single commit.
        with self.conn:
            self.conn.execute("UPDATE sync_binding SET cursor=? WHERE project=?", (snapshot["cursor"], self.project))
            for record in sorted(snapshot["records"], key=lambda r: r["kind"] == "relation"):
                self.apply_record(record, snapshot['cursor'])
            for row in local:
                if self.document(row["id"]):
                    continue
                self._enqueue(row["id"], "create", {k: row.get(k) for k in FIELDS}, row["text"])
            for row in relations:
                if not self.conn.execute("SELECT 1 FROM sync_outbox WHERE record=?", (row["id"],)).fetchone():
                    self._enqueue(row["id"], "relation", {k: row.get(k) for k in ("src", "dst", "rel", "meta")})

    def counts(self):
        return {r[0]: r[1] for r in self.conn.execute("SELECT state,COUNT(*) FROM sync_outbox GROUP BY state")}

    def enqueue_update(self, record, update):
        document, text = merge_text(self.document(record), update)
        if len(text) > 100000:
            raise ValueError("Memory text cannot exceed 100000 characters")
        operation = {"op_id": str(uuid.uuid4()), "id": record, "action": "edit", "text_update": update}
        with self.conn:
            self.conn.execute("INSERT INTO sync_outbox(op_id,record,operation,draft) VALUES(?,?,?,?)",
                              (operation["op_id"], record, json.dumps(operation), json.dumps({"text": text})))
            self.remember(record, document, text)
            self.project_record(record)
        return operation

    def create(self, text, **fields):
        record = str(uuid.uuid4())
        fields.update(timestamp=datetime.now(timezone.utc).isoformat(), type=fields.get("type") or "note")
        if fields["type"] == "task":
            fields["status"] = fields.get("status") or "open"
        self.enqueue(record, "create", fields, text)
        return dict(self.conn.execute("SELECT * FROM thoughts WHERE id=?", (record,)).fetchone())
