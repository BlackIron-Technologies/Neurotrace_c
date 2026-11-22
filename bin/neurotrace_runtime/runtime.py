from .common import (BACKEND_VERSION, Optional, getpass, json, os, socketserver, sys, threading, uuid)

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

from .server import NeuroTraceServer
from .commands import execute_backend_command
from .mcp_remote import _handle_mcp_tool_call_via_bridge, _handle_mcp_tool_call_via_daemon
def main_mcp():
    """MCP stdio server main loop (JSON-RPC 2.0)."""
    # Parse workspace from CLI args
    workspace_path = None
    args = sys.argv[1:]
    bridge_required = "--bridge-required" in args
    for i, arg in enumerate(args):
        if arg == "--workspace" and i + 1 < len(args):
            workspace_path = args[i + 1]

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method", "")

            if method == "initialize":
                response = _mcp_response(
                    req_id,
                    {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "neurotrace", "version": BACKEND_VERSION},
                    },
                )

            elif method == "notifications/initialized":
                # Client acknowledgement — no response needed
                continue

            elif method == "tools/list":
                response = _mcp_response(req_id, {"tools": MCP_TOOL_DEFINITIONS})

            elif method == "tools/call":
                params = req.get("params", {})
                tool_name = params.get("name", "")
                arguments = params.get("arguments", {})
                if bridge_required:
                    content = _handle_mcp_tool_call_via_bridge(
                        workspace_path, tool_name, arguments
                    )
                else:
                    content = _handle_mcp_tool_call_via_daemon(
                        workspace_path, tool_name, arguments
                    )
                response = _mcp_response(req_id, content)

            elif method == "ping":
                response = _mcp_response(req_id, {})

            else:
                response = _mcp_error(req_id, -32601, f"Method not found: {method}")

        except json.JSONDecodeError as e:
            response = _mcp_error(req_id, -32700, f"Parse error: {e}")
        except Exception as e:
            response = _mcp_error(
                req_id, -32603, f"Internal error: {type(e).__name__}: {e}"
            )

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


def _parse_workspace_arg(args) -> Optional[str]:
    for i, arg in enumerate(args):
        if arg == "--workspace" and i + 1 < len(args):
            return args[i + 1]
    return None


def main_daemon():
    workspace_path = _parse_workspace_arg(sys.argv[1:])
    if not workspace_path:
        print("Missing required --workspace argument.", file=sys.stderr)
        sys.exit(1)

    server = NeuroTraceServer(None)
    execute_backend_command(server, 'set_workspace', {'workspace': workspace_path})
    daemon_token = uuid.uuid4().hex

    class ThreadedDaemonServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    class DaemonHandler(socketserver.StreamRequestHandler):
        def handle(self):
            while True:
                line = self.rfile.readline()
                if not line:
                    break

                req_id = None
                try:
                    req = json.loads(line.decode("utf-8"))
                    req_id = req.get("id")
                    if req.get("token") != daemon_token:
                        response = {
                            "id": req_id,
                            "error": "Unauthorized daemon request.",
                            "success": False,
                        }
                    else:
                        from .commands import validate_workspace_request
                        validate_workspace_request(req, server.workspace_path)
                        result = execute_backend_command(
                            server,
                            req.get("command", ""),
                            req.get("payload", {}),
                        )
                        response = {"id": req_id, "data": result, "success": True}
                except Exception as e:
                    response = {
                        "id": req_id,
                        "error": f"Python Error: {type(e).__name__}: {e}",
                        "success": False,
                    }

                self.wfile.write((json.dumps(response) + "\n").encode("utf-8"))
                self.wfile.flush()

    daemon_server = ThreadedDaemonServer(("127.0.0.1", 0), DaemonHandler)
    daemon_port = int(daemon_server.server_address[1])
    _write_daemon_info(workspace_path, "127.0.0.1", daemon_port, daemon_token)

    try:
        daemon_server.serve_forever()
    finally:
        try:
            daemon_server.server_close()
        except Exception:
            pass
        _remove_daemon_info(workspace_path)
        try:
            server.cleanup_and_exit()
        except Exception:
            pass


def main_unlock():
    workspace_path = _parse_workspace_arg(sys.argv[1:])
    if not workspace_path:
        print("Missing required --workspace argument.", file=sys.stderr)
        sys.exit(1)

    try:
        password = getpass.getpass("NeuroTrace passphrase: ")
        result = _send_daemon_command(
            workspace_path, "unlock_database", {"password": password}
        )
        if isinstance(result, dict) and result.get("status") == "ok":
            print("Database unlocked successfully.")
            return

        message = (
            result.get("message")
            if isinstance(result, dict)
            else "Failed to unlock NeuroTrace database."
        )
        print(message, file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"Failed to unlock database: {exc}", file=sys.stderr)
        sys.exit(1)


def main():
    """Main loop of the server (custom protocol for VS Code extension)."""
    # 1. Initialize the server without a database yet.
    bridge_enabled = os.environ.get("NEUROTRACE_ENABLE_BRIDGE") == "1"
    server = NeuroTraceServer(None, bridge_enabled=bridge_enabled)
    output_lock = threading.Lock()

    def emit(event):
        with output_lock:
            sys.stdout.write(json.dumps(event) + "\n")
            sys.stdout.flush()

    server.event_sink = emit

    # 3. Start the loop to listen to all commands.
    for line in sys.stdin:
        req_id = None
        try:
            req = json.loads(line)
            command = req.get("command", "")
            payload = req.get("payload", {})
            req_id = req.get("id")

            result = execute_backend_command(server, command, payload)

            response = {"id": req_id, "data": result, "success": True}

        except Exception as e:
            response = {
                "id": req_id,
                "error": f"Python Error: {type(e).__name__}: {e}",
                "success": False,
            }

        emit(response)
