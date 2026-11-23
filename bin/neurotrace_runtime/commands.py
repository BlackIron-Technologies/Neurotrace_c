
from pathlib import Path


def validate_workspace_request(request, workspace):
    supplied = request.get('workspace')
    if not isinstance(supplied, str) or not Path(supplied).is_absolute() or not workspace or Path(supplied).resolve() != Path(workspace).resolve():
        raise ValueError('MCP workspace mismatch or outdated client. Reconnect NeuroTrace from the intended workspace.')
    if request.get('command') == 'set_workspace':
        raise ValueError('An MCP connection cannot switch its workspace')


COMMAND_MAPPING = {
    "sync_status": "sync_status",
    "get_thought": "get_thought",
    'sync_repository': 'repository_control',
    'repository_context': 'repository_context',
    'preview_connection': 'preview_connection',
    "host": "host",
    "connect": "connect",
    "team": "team",
    "sync_edit_context": "sync_edit_context",
    "sync_text_update": "sync_text_update",
    "sync_connect": "sync_connect",
    "sync_recover": "sync_recover",
    "sync_pause": "sync_pause",
    "sync_manage": "sync_manage",
    "sync_drafts": "sync_drafts",
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
    if command == 'sync':
        return server.sync_control(**payload)
    with server.command_lock:
        if command in {'list', 'add_thought', 'edit', 'delete', 'search', 'semantic-search', 'suggest', 'get_thought',
                       'graph-data', 'graph-insights', 'get_memories_by_file', 'sync_edit_context', 'sync_text_update',
                       'add-relation', 'delete-relation', 'update-edge-type'}:
            server.guard_repository()
        if command == 'sync_import_preview':
            from neurotrace_sync.import_validation import preview_import
            return preview_import(server.conn, server.workspace_path, **payload)
        if command == 'sync_service':
            from neurotrace_sync.services import service_control
            return service_control(**payload)
        if command == 'sync_server_info':
            from neurotrace_sync.server_info import inspect_server
            return inspect_server(**payload)
        if command in ("unlock_database", "encrypt_database", "decrypt_database") and server.sync_worker:
            server.sync_worker.stop()
            server.sync_worker = None
        if command.startswith("sync_host_"):
            from neurotrace_sync import hosting
            method = {"sync_host_start": hosting.start,
                      "sync_host_verify": hosting.verify,
                      "sync_host_stop": hosting.stop, "sync_host_status": hosting.status}.get(command)
            if not method:
                raise ValueError("Unknown hosting command")
            return method(**payload)
        method_name = COMMAND_MAPPING.get(command)
        if not method_name:
            raise ValueError(f"Unknown command: {command}")

        if command == "set_workspace":
            result = server.set_workspace(payload.get("workspace"))
            server.ensure_schema()
            server.start_bridge_server()
            server.sync_start()
            return result

        method_to_call = getattr(server, method_name, None)
        if not callable(method_to_call):
            raise ValueError(f"Method {method_name} not found for command: {command}")

        result = method_to_call(**payload)
        if command in ("init", "unlock_database", "encrypt_database", "decrypt_database"):
            server.sync_start()
        if command == "init":
            from neurotrace_sync.repository import workspace_repository, pin_database
            if server.conn.execute('SELECT COUNT(*) FROM thoughts').fetchone()[0] == 0:
                try:
                    repository = workspace_repository(server.workspace_path)
                except ValueError:
                    repository = None
                if repository:
                    with server.conn:
                        pin_database(server.conn, repository)
            server.build_faiss_index()
        return result
