"""One authenticated standalone backend per workspace."""
import os
import socketserver
import sys
import uuid
import json

from neurotrace_platform.processes import ProcessLock
from .daemon_client import _write_daemon_info, _remove_daemon_info
from .server import NeuroTraceServer
from .commands import execute_backend_command


def main_daemon():
    from .runtime import _parse_workspace_arg
    from pathlib import Path
    workspace = _parse_workspace_arg(sys.argv[1:])
    if not workspace:
        raise ValueError('Missing required --workspace argument')
    workspace = str(Path(workspace).resolve())
    try:
        ownership = ProcessLock(Path(workspace) / '.neurotrace' / 'daemon-owner.lock')
    except BlockingIOError:
        return
    with ownership:
        serve_daemon(workspace)


def serve_daemon(workspace_path):
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
        daemon_server.server_close()
        try:
            _remove_daemon_info(workspace_path, expected_pid=os.getpid())
        finally:
            server.cleanup_and_exit()
