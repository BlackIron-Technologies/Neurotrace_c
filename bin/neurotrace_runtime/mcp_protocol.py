from .common import (Optional, json)

MCP_TOOL_DEFINITIONS = [
    {
        "name": "neurotrace_addThought",
        "description": (
            "Create a memory in NeuroTrace. "
            "Use only for durable, high-signal context that will help in a later session: decisions, non-obvious insights, concrete risks, real follow-up tasks, validated hypotheses, discards, or important notes. "
            "Include file_path, line, and snippet when the memory is tied to code. For tasks, include priority and status when applicable. "
            "Do not use for routine progress updates, trivial bug fixes, obvious code changes, or temporary debugging notes. "
            "Prefer fewer, higher-value memories."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["text", "type"],
            "properties": {
                "text": {
                    "type": "string",
                    "description": "Memory text to store.",
                },
                "type": {
                    "type": "string",
                    "enum": [
                        "hypothesis",
                        "decision",
                        "insight",
                        "task",
                        "risk",
                        "discard",
                        "note",
                    ],
                    "description": "Memory type.",
                },
                "tags": {
                    "type": "string",
                    "description": "Comma-separated tags.",
                },
                "file_path": {
                    "type": "string",
                    "description": "Absolute file path linked to this memory.",
                },
                "line": {
                    "type": "number",
                    "description": "1-based line number in file_path.",
                },
                "snippet": {
                    "type": "string",
                    "description": "Related code snippet.",
                },
                "priority": {
                    "type": "string",
                    "enum": ["Low", "Moderate", "High"],
                    "description": "Task priority only.",
                },
                "status": {
                    "type": "string",
                    "enum": [
                        "open",
                        "in-progress",
                        "blocked",
                        "closed",
                        "obsolete",
                    ],
                    "description": (
                        "Task status only: open=pending, in-progress=active, blocked=waiting, "
                        "closed=done, obsolete=no longer relevant."
                    ),
                },
            },
        },
    },
    {
        "name": "neurotrace_listThoughts",
        "description": (
            "List memories with pagination and optional type filter."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "page": {
                    "type": "number",
                    "description": "0-based page number.",
                },
                "page_size": {
                    "type": "number",
                    "description": "Items per page.",
                },
                "type_filter": {
                    "type": "string",
                    "enum": [
                        "hypothesis",
                        "decision",
                        "insight",
                        "task",
                        "risk",
                        "discard",
                        "note",
                    ],
                    "description": "Optional memory type filter.",
                },
            },
        },
    },
    {
        "name": "neurotrace_editThought",
        "description": (
            "Update an existing memory by id. "
            "Use to change text, tags, code reference, task priority, or task status."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["thought_id"],
            "properties": {
                "thought_id": {
                    "type": "string",
                    "description": "Memory id to edit.",
                },
                "base_text": {
                    "type": "string",
                    "description": "Original text from the memory you read. Required for text edits in a shared project; preserves concurrent edits.",
                },
                "new_text": {
                    "type": "string",
                    "description": "New memory text.",
                },
                "new_tags": {
                    "type": "string",
                    "description": "New comma-separated tags.",
                },
                "new_file_path": {
                    "type": "string",
                    "description": "New absolute file path.",
                },
                "new_line": {
                    "type": "number",
                    "description": "New 1-based line number.",
                },
                "new_snippet": {
                    "type": "string",
                    "description": "New related code snippet.",
                },
                "new_priority": {
                    "type": "string",
                    "enum": ["Low", "Moderate", "High"],
                    "description": "New task priority only.",
                },
                "new_status": {
                    "type": "string",
                    "enum": [
                        "open",
                        "in-progress",
                        "blocked",
                        "closed",
                        "obsolete",
                    ],
                    "description": (
                        "New task status only: open=pending, in-progress=active, blocked=waiting, "
                        "closed=done, obsolete=no longer relevant."
                    ),
                },
            },
        },
    },
    {
        "name": "neurotrace_deleteThought",
        "description": (
            "Permanently delete a memory by id."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["thought_id"],
            "properties": {
                "thought_id": {
                    "type": "string",
                    "description": "Memory id to delete.",
                },
            },
        },
    },
    {
        "name": "neurotrace_searchThoughts",
        "description": (
            "Keyword search across memory text, tags, file path, and task status."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["term"],
            "properties": {
                "term": {
                    "type": "string",
                    "description": "Search term.",
                },
            },
        },
    },
    {
        "name": "neurotrace_semanticSearch",
        "description": (
            "Semantic search for conceptually related memories."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language search query.",
                },
            },
        },
    },
    {
        "name": "neurotrace_suggestRelated",
        "description": (
            "Find memories related to a specific memory id."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["thought_id"],
            "properties": {
                "thought_id": {
                    "type": "string",
                    "description": "Memory id to expand from.",
                },
            },
        },
    },
    {
        "name": "neurotrace_getGraphData",
        "description": (
            "Return memory graph nodes and edges for the current workspace."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "include_semantic": {
                    "type": "boolean",
                    "description": "Include semantic similarity edges.",
                },
            },
        },
    },
    {
        "name": "neurotrace_getMemoriesByFile",
        "description": (
            "List memories linked to one exact file path. "
            "Active tasks are returned first, then non-task memories, then closed tasks."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["file_path"],
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute file path.",
                }
            },
        },
    },
    {
        "name": "neurotrace_getGraphInsights",
        "description": (
            "Return graph analytics such as hubs, isolated nodes, and communities."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "neurotrace_addRelation",
        "description": (
            "Create a manual relation between two memories."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["source_id", "target_id", "relation_type"],
            "properties": {
                "source_id": {
                    "type": "string",
                    "description": "Source memory id.",
                },
                "target_id": {
                    "type": "string",
                    "description": "Target memory id.",
                },
                "relation_type": {
                    "type": "string",
                    "enum": [
                        "causes",
                        "blocks",
                        "contradicts",
                        "supports",
                        "related",
                    ],
                    "description": "Relation type.",
                },
            },
        },
    },
    {
        "name": "neurotrace_deleteRelation",
        "description": (
            "Delete a manual relation by relation id."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["relation_id"],
            "properties": {
                "relation_id": {
                    "type": "string",
                    "description": "Relation id to delete.",
                },
            },
        },
    },
    {
        "name": "neurotrace_getDatabaseStatus",
        "description": (
            "Check whether NeuroTrace is ready in this workspace."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _mcp_response(req_id, result):
    """Build a JSON-RPC 2.0 success response."""
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _mcp_error(req_id, code, message):
    """Build a JSON-RPC 2.0 error response."""
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def _mcp_text_content(text):
    """Wrap text in MCP content format."""
    return {"content": [{"type": "text", "text": text}]}


def _locked_database_error_content(
    message: str = "Database is encrypted and locked. Open the NeuroTrace sidebar in your IDE and unlock it there.",
):
    return _mcp_text_content(
        json.dumps(
            {
                "error": "database_locked",
                "message": message,
            }
        )
    )


def _no_database_error_content():
    return _mcp_text_content(
        json.dumps(
            {
                "error": "no_database",
                "message": "No NeuroTrace database exists. Initialize it from the NeuroTrace sidebar.",
            }
        )
    )


def _codex_locked_database_error_content():
    return _locked_database_error_content(
        "Database is encrypted and locked. Open the NeuroTrace sidebar in your IDE and use `Unlock for Codex` to launch the unlock flow in the integrated terminal."
    )


def _normalize_backend_result(result, locked_error_content_factory=None):
    if locked_error_content_factory is None:
        locked_error_content_factory = _locked_database_error_content
    if isinstance(result, dict):
        error_value = result.get("error")
        if error_value:
            error_text = str(error_value).lower().replace("_", " ")
            if "locked" in error_text:
                return None, locked_error_content_factory()
            if "no database" in error_text or error_text == "no_database":
                return None, _no_database_error_content()
            message = result.get("message") or str(error_value)
            return None, _mcp_text_content(
                json.dumps({"error": error_value, "message": message})
            )
    return result, None


class BridgeUnavailableError(RuntimeError):
    pass


class DaemonUnavailableError(RuntimeError):
    pass


def _bridge_unavailable_content():
    return _mcp_text_content(
        json.dumps(
            {
                "error": "bridge_unavailable",
                "message": "Open the NeuroTrace sidebar in your IDE and wait for the backend to start.",
            }
        )
    )


def _daemon_unavailable_content(workspace_path: Optional[str]):
    return _mcp_text_content(
        json.dumps(
            {
                "error": "daemon_unavailable",
                "message": "NeuroTrace standalone daemon did not respond. Retry after it finishes starting or inspect the workspace daemon process. Unlock is only needed when the database reports LOCKED.",
            }
        )
    )



from .sync_tools import SYNC_TOOL_DEFINITIONS

MCP_TOOL_DEFINITIONS += SYNC_TOOL_DEFINITIONS
