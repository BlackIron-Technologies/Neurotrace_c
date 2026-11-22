
COMMAND_MAPPING = {
    "sync_status": "sync_status",
    "get_thought": "get_thought",
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
            server.build_faiss_index()
        return result
