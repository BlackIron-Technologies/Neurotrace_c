from .common import (json)
from .sync_tools import SYNC_TOOL_COMMANDS
from .commands import execute_backend_command

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

def _handle_mcp_tool_call(server, tool_name, arguments):
    """
    Dispatch an MCP tools/call to the appropriate NeuroTraceServer method.
    Returns MCP content dict or raises on error.
    """
    if tool_name in SYNC_TOOL_COMMANDS:
        return _mcp_text_content(json.dumps(execute_backend_command(server, SYNC_TOOL_COMMANDS[tool_name], arguments)))
    if tool_name != 'neurotrace_getDatabaseStatus':
        server.guard_repository()
    if server.conn is None:
        status = server.check_db_status().get("status", "UNKNOWN")
        if status == "NO_DB":
            return _no_database_error_content()
        elif status == "LOCKED":
            return _locked_database_error_content()

    if tool_name == "neurotrace_addThought":
        result, error_content = _normalize_backend_result(
            server.add_thought(**arguments)
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps(
                {
                    "success": True,
                    "id": result.get("id"),
                    "timestamp": result.get("timestamp"),
                }
            )
        )

    elif tool_name == "neurotrace_listThoughts":
        page = arguments.get("page", 0)
        page_size = arguments.get("page_size", 20)
        type_filter = arguments.get("type_filter")
        result, error_content = _normalize_backend_result(
            server.list_thoughts(page=page, page_size=page_size)
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
        updated, error_content = _normalize_backend_result(
            server.edit_thought(
                thought_id=thought_id,
                new_text=new_text,
                base_text=arguments.get("base_text"),
                new_tags=new_tags,
                new_file_path=new_file_path,
                new_line=new_line,
                new_snippet=new_snippet,
                new_priority=new_priority,
                new_status=new_status,
            )
        )
        if error_content:
            return error_content
        if new_text and updated and updated.get("id"):
            server.process_single_embedding(thought_id=updated["id"])
        return _mcp_text_content(json.dumps({"success": True, "thought": updated}))

    elif tool_name == "neurotrace_getMemoriesByFile":
        result, error_content = _normalize_backend_result(
            server.get_memories_by_file(file_path=arguments["file_path"])
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
            server.delete_thought(thought_id=arguments["thought_id"])
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps({"success": True, "deleted": arguments["thought_id"]})
        )

    elif tool_name == "neurotrace_searchThoughts":
        results, error_content = _normalize_backend_result(
            server.search_entries(term=arguments["term"])
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps({"results": results, "count": len(results) if results else 0})
        )

    elif tool_name == "neurotrace_semanticSearch":
        results, error_content = _normalize_backend_result(
            server.semantic_search(query=arguments["query"])
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps({"results": results, "count": len(results) if results else 0})
        )

    elif tool_name == "neurotrace_suggestRelated":
        results, error_content = _normalize_backend_result(
            server.suggest_related(thought_id=arguments["thought_id"])
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps({"related": results, "count": len(results) if results else 0})
        )

    elif tool_name == "neurotrace_getGraphData":
        data, error_content = _normalize_backend_result(server.get_graph_data())
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
        insights, error_content = _normalize_backend_result(server.get_graph_insights())
        if error_content:
            return error_content
        return _mcp_text_content(json.dumps(insights))

    elif tool_name == "neurotrace_addRelation":
        result, error_content = _normalize_backend_result(
            server.add_relation(
                src=arguments["source_id"],
                dst=arguments["target_id"],
                rel=arguments["relation_type"],
            )
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
            server.delete_relation(id=arguments["relation_id"])
        )
        if error_content:
            return error_content
        return _mcp_text_content(
            json.dumps({"success": True, "deleted": arguments["relation_id"]})
        )

    elif tool_name == "neurotrace_getDatabaseStatus":
        status_result, error_content = _normalize_backend_result(
            server.check_db_status()
        )
        if error_content:
            return error_content
        status = status_result.get("status", "UNKNOWN")
        out = {"database_status": status, "backend_running": True}
        if status in ("UNENCRYPTED", "UNLOCKED"):
            count, count_error_content = _normalize_backend_result(
                server.get_total_count()
            )
            if count_error_content:
                return count_error_content
            out["total_thoughts"] = count.get("total", 0)
        return _mcp_text_content(json.dumps(out))

    else:
        raise ValueError(f"Unknown tool: {tool_name}")
