from .common import (json)
from .sync_tools import SYNC_TOOL_COMMANDS

from .mcp_protocol import (
    _mcp_response,
    _mcp_error,
    _mcp_text_content,
    _locked_database_error_content,
    _no_database_error_content,
    _codex_locked_database_error_content,
    _normalize_backend_result,
    BridgeUnavailableError,
    DaemonUnavailableError,
    _bridge_unavailable_content,
    _daemon_unavailable_content,
    MCP_TOOL_DEFINITIONS
)

from .daemon_client import (
    _read_bridge_info,
    _send_bridge_command,
    _get_daemon_info_path,
    _write_daemon_info,
    _remove_daemon_info,
    _read_daemon_info,
    _send_socket_command,
    _build_daemon_spawn_args,
    _spawn_detached_process,
    _ensure_standalone_daemon_running,
    _send_daemon_command
)

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
        if tool_name in SYNC_TOOL_COMMANDS:
            result = send_command(workspace_path, SYNC_TOOL_COMMANDS[tool_name], arguments)
            return _mcp_text_content(json.dumps(result))
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
                        "saved_locally": True,
                        "sync": send_command(workspace_path, 'sync_status', {'thought_id': result.get('id')}),
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
                    "base_text": arguments.get("base_text"),
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
            return _mcp_text_content(json.dumps({"success": True, "thought": updated, "saved_locally": True,
                                                "sync": send_command(workspace_path, 'sync_status', {'thought_id': thought_id})}))

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
            out["sync"] = send_command(workspace_path, "sync_status", {})
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
