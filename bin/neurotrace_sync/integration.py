"""Backend commands and team-aware mutations shared by IDE and MCP clients."""
import json
import uuid

from .profile import Profile, Remote
from .replica import Replica
from .worker import SyncWorker
from .control import SyncControl
from .administration import SyncAdministration


class SyncMixin(SyncControl, SyncAdministration):
    def _sync_basic_status(self):
        if not self.workspace_path:
            return {"state": "unconfigured"}
        profile = Profile(self.workspace_path).read()
        worker = getattr(self, "sync_worker", None)
        if not profile:
            return {"state": "unconfigured"}
        state = worker.state if worker else ("locked" if self.conn is None else "paused")
        return {"state": state, "server_url": profile["server_url"], "project_id": profile["project_id"],
                "project_name": profile.get("project_name", "Shared project"), "actor_name": profile.get("actor_name", ""),
                "role": worker.role if worker else profile.get("role", "viewer"),
                "error": worker.error if worker else "", "counts": {row[0]: row[1] for row in self.conn.execute('SELECT state,COUNT(*) FROM sync_outbox GROUP BY state')} if self.conn else {},
                "enabled": profile.get("enabled", True)}

    def sync_start(self):
        if not self.workspace_path or self.conn is None or getattr(self, "sync_worker", None):
            return
        profile_store = Profile(self.workspace_path)
        profile = profile_store.read()
        if not profile or not profile.get("enabled", True):
            return
        token = profile_store.token(profile)
        if not token:
            raise ValueError("Reconnect this device: its secure credential is missing")
        replica = Replica(self.conn, self.workspace_path, profile["project_id"])
        self.sync_worker = SyncWorker(self, profile, token, replica)
        self.sync_worker.start()

    def sync_connect(self, server_url, mode="join", code="", setup_key="", name="", network_name="", project_name="", project_id="", publish=False):
        if self.conn is None:
            raise ValueError("Initialize and unlock this workspace before connecting")
        if Profile(self.workspace_path).read():
            raise ValueError("This workspace is already connected. Pause or resume it from settings")
        remote = Remote(server_url)
        if mode not in ("join", "create", "recover"):
            raise ValueError("Choose Join or Create")
        count = self.conn.execute("SELECT COUNT(*) FROM thoughts").fetchone()[0]
        if count and not publish:
            raise ValueError("Choose Publish to share existing memories, or join from an empty workspace")
        if mode == "create" and not all(isinstance(v, str) and 0 < len(v.strip()) <= 100 for v in (name, network_name, project_name)):
            raise ValueError("Enter your name, network name and shared project name")
        status = remote.request("/v1/status")
        if status.get("protocol") != 1:
            raise ValueError("This server uses an unsupported synchronization protocol")
        profile_store = Profile(self.workspace_path)
        profile_store.prepare_credentials(remote.url)
        recovery_path = profile_store.path.with_suffix(".setup.json")
        recovery = json.loads(recovery_path.read_text(encoding="utf-8")) if recovery_path.exists() else None
        if recovery:
            if recovery["server_url"] != remote.url:
                raise ValueError("Finish connecting to the previous server before choosing another address")
            credentials = {"actor_id": recovery["actor_id"], "token": profile_store.token(recovery)}
            project_id = recovery.get("project_id", "")
            if not credentials["token"]:
                raise ValueError("The setup credential is missing from the OS credential store")
        elif mode == "recover":
            credentials = {"token": code, "actor_id": name}
        elif mode == "create":
            credentials = remote.request("/v1/bootstrap", {"key": setup_key, "name": name, "network_name": network_name})
        else:
            credentials = remote.request("/v1/join", {"code": code})
            project_id = credentials["project_id"]
        remote.token = credentials["token"]
        # Store credentials before further setup so a failed project/import can be recovered without losing the owner.
        profile_store.save_token(remote.url, credentials["actor_id"], remote.token)
        recovery = {"server_url": remote.url, "actor_id": credentials["actor_id"], "project_id": project_id}
        recovery_path.parent.mkdir(parents=True, exist_ok=True)
        recovery_path.write_text(json.dumps(recovery), encoding="utf-8")
        if mode == "create" and not project_id:
            project = remote.request("/v1/projects", {"name": project_name})
            project_id = project["id"]
            recovery["project_id"] = project_id
            recovery_path.write_text(json.dumps(recovery), encoding="utf-8")
        network = remote.request("/v1/network")
        project = next(p for p in network["projects"] if p["id"] == project_id)
        snapshot = remote.request("/v1/projects/" + project_id + "/snapshot")
        replica = Replica(self.conn, self.workspace_path, project_id)
        import_report = replica.initialize(snapshot, publish=publish)
        profile = {"server_url": remote.url, "project_id": project_id, "actor_id": credentials["actor_id"],
                   "actor_name": network["actor"]["name"], "project_name": project["name"], "role": snapshot["role"], "enabled": True}
        profile_store.write(profile)
        recovery_path.unlink(missing_ok=True)
        self.sync_start()
        return {**self.sync_status(), 'import_report': import_report}

    def sync_recover(self, file_path):
        from pathlib import Path
        recovery = json.loads(Path(file_path).read_text(encoding="utf-8"))
        return self.sync_connect(recovery["server_url"], mode="recover", code=recovery["token"],
                                 name=recovery["actor_id"], project_id=recovery["project_id"])

    def sync_pause(self, paused=True):
        profile_store = Profile(self.workspace_path)
        profile = profile_store.read()
        if not profile:
            return self.sync_status()
        profile["enabled"] = not paused
        profile_store.write(profile)
        worker = getattr(self, "sync_worker", None)
        if worker:
            worker.stop()
            self.sync_worker = None
        if not paused:
            self.sync_start()
        return self.sync_status()

    def sync_manage(self, action, data=None):
        profile_store = Profile(self.workspace_path)
        profile = profile_store.read()
        if not profile:
            raise ValueError("Connect a shared project first")
        remote = Remote(profile["server_url"], profile_store.token(profile))
        allowed = {"members", "activity", "invite", "member", "transfer", "network", "network_transfer", "create_project"}
        if action not in allowed:
            raise ValueError("Unsupported team action")
        if action == "network":
            return remote.request("/v1/network")
        if action == "network_transfer":
            return remote.request("/v1/network/transfer", data)
        if action == "create_project":
            project = remote.request("/v1/projects", {"name": data["name"]})
            invitation = remote.request("/v1/projects/" + project["id"] + "/invite", {"name": profile["actor_name"], "role": "viewer", "kind": "device"})
            return {"invitation": remote.url + "/#join=" + invitation["code"], "name": project["name"]}
        return remote.request("/v1/projects/" + profile["project_id"] + "/" + action, data)

    def sync_drafts(self):
        if self.conn is None:
            return []
        return [dict(row) for row in self.conn.execute("SELECT operation,draft,error,state FROM sync_outbox WHERE state IN ('pending','recovered') ORDER BY seq")]

    def sync_edit_context(self, thought_id):
        profile = Profile(self.workspace_path).read()
        if not profile or not self.conn:
            raise ValueError("Connect and unlock this workspace first")
        replica = Replica(self.conn, self.workspace_path, profile["project_id"])
        row = self.conn.execute("SELECT id,text FROM thoughts WHERE id=?", (thought_id,)).fetchone()
        return {"id": thought_id, "deleted": row is None, "document": replica.document(thought_id), "sync": self.sync_status(thought_id)}

    def sync_text_update(self, thought_id, update):
        replica = self._shared_replica()
        if not replica or not self.conn.execute("SELECT 1 FROM thoughts WHERE id=?", (thought_id,)).fetchone():
            raise ValueError("This memory was deleted. Copy your draft to a new memory.")
        replica.enqueue_update(thought_id, update)
        self.faiss_index = None
        return self.sync_edit_context(thought_id)

    def _shared_replica(self):
        if not self.workspace_path or not Profile(self.workspace_path).read():
            return None
        if self.conn is None:
            raise ValueError("Unlock the workspace before editing")
        profile = Profile(self.workspace_path).read()
        worker = getattr(self, "sync_worker", None)
        role = worker.role if worker else profile.get("role", "viewer")
        if role == "viewer" or (worker and worker.state == "access_denied"):
            raise PermissionError("Your shared project is read-only or access has been revoked")
        return worker.replica if worker else Replica(self.conn, self.workspace_path, profile["project_id"])

    def add_thought(self, text, file_path=None, line=None, type=None, tags="", snippet=None, priority=None, status=None):
        replica = self._shared_replica()
        if not replica:
            return super().add_thought(text, file_path, line, type, tags, snippet, priority, status)
        row = replica.create(text, file_path=file_path, line=line, type=type, tags=tags, snippet=snippet, priority=priority, status=status)
        row.pop("embedding", None)
        return row

    def edit_thought(self, thought_id, new_text=None, new_tags=None, new_file_path=None, new_line=None, new_snippet=None, new_priority=None, new_status=None, base_text=None):
        replica = self._shared_replica()
        if not replica:
            return super().edit_thought(thought_id, new_text, new_tags, new_file_path, new_line, new_snippet, new_priority, new_status)
        row = self.conn.execute("SELECT * FROM thoughts WHERE id=?", (thought_id,)).fetchone()
        if not row:
            raise ValueError("This memory was deleted; your editor content can be saved as a new memory")
        if new_text is not None and base_text is None:
            raise ValueError("Shared text edits require base_text from the memory you read; this preserves concurrent edits")
        fields = {k: v for k, v in {"tags": new_tags, "file_path": new_file_path, "line": new_line,
                                    "snippet": new_snippet, "priority": new_priority, "status": new_status}.items() if v is not None}
        replica.enqueue(thought_id, "edit", fields, new_text, base_text)
        self.faiss_index = None
        return self._strip_embedding_from_row(self.conn.execute("SELECT * FROM thoughts WHERE id=?", (thought_id,)).fetchone())

    def delete_thought(self, thought_id):
        replica = self._shared_replica()
        if not replica:
            return super().delete_thought(thought_id)
        replica.enqueue(thought_id, "delete")
        self.faiss_index = None
        return "Memory deleted; synchronization queued."

    def add_relation(self, src, dst, rel, meta=None):
        replica = self._shared_replica()
        if not replica:
            return super().add_relation(src, dst, rel, meta)
        record = str(uuid.uuid4())
        replica.enqueue(record, "relation", {"src": src, "dst": dst, "rel": rel or "manual", "meta": meta})
        return {"status": "ok", "id": record}

    def delete_relation(self, id):
        replica = self._shared_replica()
        if not replica:
            return super().delete_relation(id)
        replica.enqueue(id, "delete_relation")
        return {"status": "ok", "id": id}

    def update_edge_type(self, id, rel):
        replica = self._shared_replica()
        if not replica:
            return super().update_edge_type(id, rel)
        row = self.conn.execute("SELECT * FROM relations WHERE id=?", (id,)).fetchone()
        if not row:
            raise ValueError("Relationship not found")
        data = {k: row[k] for k in ("src", "dst", "rel", "meta")}
        data["rel"] = rel
        replica.enqueue(id, "relation", data)
        return {"status": "ok", "id": id}
