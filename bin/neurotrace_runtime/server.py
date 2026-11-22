from .common import (Optional, Path, get_db_connection, socketserver, threading)

from neurotrace_sync.integration import SyncMixin
from .bridge import BridgeMixin
from .storage import StorageMixin
from .embeddings import EmbeddingMixin
from .memories import MemoryMixin
from .graph import GraphMixin


class NeuroTraceServer(SyncMixin, BridgeMixin, StorageMixin, EmbeddingMixin, MemoryMixin, GraphMixin):
    def __init__(self, db_path, bridge_enabled: bool = False):
        self.sync_worker = None
        self.event_sink = None
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


    def cleanup_and_exit(self):
        """Cleanly closes connections before exiting."""
        if self.sync_worker:
            self.sync_worker.stop()
            self.sync_worker = None
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
        from neurotrace_sync.platform_storage import require_native_storage
        require_native_storage(workspace)
        new_workspace_path = Path(workspace)
        if self.sync_worker:
            self.sync_worker.stop()
            self.sync_worker = None
        if self.conn:
            self.conn.close()
            self.conn = None
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
