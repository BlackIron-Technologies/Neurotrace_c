"""Ordered project operations and automatic text convergence."""
import json
import time
from pathlib import PurePosixPath

from .store import digest, require
from .text import merge_text

FIELDS = {"timestamp", "type", "tags", "file_path", "line", "snippet", "priority", "status"}
TYPES = {"note", "task", "decision", "hypothesis", "insight", "risk", "discard"}
STATUSES = {"open", "in-progress", "blocked", "closed", "obsolete"}


def validate_fields(fields):
    require(isinstance(fields, dict) and set(fields) <= FIELDS, "Unknown memory fields")
    for key, value in fields.items():
        if key == "line":
            require(value is None or (type(value) is int and 0 < value <= 10000000), "Invalid line number")
        else:
            require(value is None or (isinstance(value, str) and len(value) <= 100000), "Invalid " + key)
    path = fields.get("file_path")
    if path:
        require(not PurePosixPath(path).is_absolute() and ".." not in PurePosixPath(path).parts
                and ":" not in path and "\\" not in path, "Code references must be project-relative")
    require("type" not in fields or fields["type"] in TYPES, "Invalid memory type")
    require(fields.get("status") is None or fields["status"] in STATUSES, "Invalid task status")
    require(fields.get("priority") is None or fields["priority"] in ("Low", "Moderate", "High"), "Invalid priority")


class Domain:
    def __init__(self, store, identity):
        self.store = store
        self.identity = identity

    def record(self, project, record_id):
        row = self.store.one("SELECT * FROM records WHERE project=? AND id=?", (project, record_id))
        if row:
            row["data"] = json.loads(row["data"])
            row["deleted"] = bool(row["deleted"])
        return row

    def snapshot(self, actor, project):
        role = self.identity.role(actor, project)
        rows = self.store.all("SELECT * FROM records WHERE project=?", (project,))
        for row in rows:
            row["data"] = json.loads(row["data"])
            row["deleted"] = bool(row["deleted"])
        cursor = self.store.one("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project=?", (project,))["seq"]
        return {"records": rows, "cursor": cursor, "role": role}

    def changes(self, actor, project, after):
        role = self.identity.role(actor, project)
        require(type(after) is int and after >= 0, "Invalid cursor")
        head = self.store.one("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project=?", (project,))["seq"]
        require(after <= head, "Server history is older than this device. Export pending work and reconnect from a fresh workspace", 409)
        events = self.store.all("SELECT * FROM events WHERE project=? AND seq>? ORDER BY seq LIMIT 100", (project, after))
        for event in events:
            event["payload"] = json.loads(event["payload"])
        return {"events": events, "cursor": events[-1]["seq"] if events else after, "has_more": len(events) == 100, "role": role}

    def apply(self, actor, project, operation):
        self.identity.role(actor, project, "editor")
        require(isinstance(operation, dict), "Invalid operation")
        op_id, record_id, action = (operation.get(k) for k in ("op_id", "id", "action"))
        require(all(isinstance(v, str) and 0 < len(v) <= 100 for v in (op_id, record_id, action)), "Invalid operation identity")
        fingerprint = digest(json.dumps(operation, sort_keys=True))
        with self.store.transaction():
            receipt = self.store.one("SELECT * FROM receipts WHERE project=? AND operation=?", (project, op_id))
            if receipt:
                require(receipt["actor"] == actor["id"] and receipt["request_hash"] == fingerprint,
                        "Operation identifier was already used for another request", 409)
                return json.loads(receipt["result"])
            current = self.record(project, record_id)
            outcome = "applied"
            deleted_relations = []
            if current and current["deleted"]:
                # Preserve late edits in audit; deletion never resurrects an object.
                outcome = "deleted"
            elif action in ("create", "edit"):
                fields = operation.get("fields", {})
                validate_fields(fields)
                require(action != "create" or current is None, "Memory ID already exists", 409)
                require(action != "edit" or (current and current["kind"] == "thought"), "Memory not found", 404)
                data = dict(current["data"]) if current else {"type": "note", "tags": ""}
                data.update(fields)
                document = current["document"] if current else None
                if operation.get("text_update"):
                    document, data["text"] = merge_text(document, operation["text_update"])
                require(isinstance(data.get("text"), str) and (1 if action == "create" else 0) <= len(data["text"]) <= 100000,
                        "Memory text exceeds its allowed length")
                if data["type"] != "task":
                    data["status"], data["priority"] = None, None
                elif not data.get("status"):
                    data["status"] = "open"
                self.save(project, record_id, "thought", data, document)
            elif action == "delete":
                require(current and current["kind"] == "thought", "Memory not found", 404)
                self.store.conn.execute("UPDATE records SET deleted=1 WHERE project=? AND id=?", (project, record_id))
                # Relationship tombstones are part of this same event transaction.
                for row in self.store.all("SELECT id,data FROM records WHERE project=? AND kind='relation' AND deleted=0", (project,)):
                    edge = json.loads(row["data"])
                    if record_id in (edge["src"], edge["dst"]):
                        self.store.conn.execute("UPDATE records SET deleted=1 WHERE project=? AND id=?", (project, row["id"]))
                        deleted_relations.append(self.record(project, row["id"]))
            elif action == "relation":
                data = operation.get("fields", {})
                require(isinstance(data, dict) and set(data) <= {"src", "dst", "rel", "meta"}, "Invalid relationship fields")
                for field in ("src", "dst", "rel"):
                    require(isinstance(data.get(field), str) and 0 < len(data[field]) <= 100, "Invalid relationship " + field)
                require(data.get("meta") is None or (isinstance(data["meta"], str) and len(data["meta"]) <= 10000), "Invalid relationship metadata")
                for endpoint in (data["src"], data["dst"]):
                    node = self.record(project, endpoint)
                    require(node and not node["deleted"] and node["kind"] == "thought", "Relationship endpoint is unavailable", 409)
                require(not current or current["kind"] == "relation", "Record kind cannot change", 409)
                self.save(project, record_id, "relation", data, None)
            elif action == "delete_relation":
                require(current and current["kind"] == "relation", "Relationship not found", 404)
                self.store.conn.execute("UPDATE records SET deleted=1 WHERE project=? AND id=?", (project, record_id))
            else:
                require(False, "Unknown operation")
            payload = {"record": self.record(project, record_id), "outcome": outcome}
            if action == "delete":
                payload["relations"] = deleted_relations
            seq = self.store.conn.execute("INSERT INTO events(project,actor,operation,record,payload,at) VALUES(?,?,?,?,?,?)",
                                          (project, actor["id"], op_id, record_id, json.dumps(payload), time.time())).lastrowid
            result = {"seq": seq, "op_id": op_id, **payload}
            self.store.conn.execute("INSERT INTO receipts VALUES(?,?,?,?,?)", (project, op_id, actor["id"], fingerprint, json.dumps(result)))
            self.store.log(project, actor["id"], action, {"operation": operation, "outcome": outcome, "seq": seq})
        return result

    def save(self, project, record_id, kind, data, document):
        self.store.conn.execute("INSERT INTO records VALUES(?,?,?,?,?,0) ON CONFLICT(project,id) DO UPDATE SET data=excluded.data,document=excluded.document",
                                (project, record_id, kind, json.dumps(data), document))
