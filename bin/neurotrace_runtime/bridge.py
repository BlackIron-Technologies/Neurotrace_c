from .common import (Optional, Path, json, os, socketserver, sys, threading, uuid)

from .commands import execute_backend_command, validate_workspace_request

class BridgeMixin:
    def _get_bridge_info_path(self) -> Optional[Path]:
        if self.workspace_path is None:
            return None
        return self.workspace_path / ".neurotrace" / "backend_bridge.json"


    def _remove_bridge_info_file(self) -> None:
        if self.bridge_info_path and self.bridge_info_path.exists():
            try:
                self.bridge_info_path.unlink()
            except OSError:
                pass


    def _write_bridge_info(self) -> None:
        info_path = self._get_bridge_info_path()
        if info_path is None or self.bridge_port is None or self.bridge_token is None:
            return

        info_path.parent.mkdir(parents=True, exist_ok=True)
        info = {
            'protocol': 2,
            "host": "127.0.0.1",
            "port": self.bridge_port,
            "token": self.bridge_token,
            "pid": os.getpid(),
            "workspace": str(self.workspace_path.resolve()) if self.workspace_path else None,
        }
        info_path.write_text(json.dumps(info), encoding="utf-8")
        self.bridge_info_path = info_path


    def stop_bridge_server(self) -> None:
        if self.bridge_server is not None:
            try:
                self.bridge_server.shutdown()
            except Exception:
                pass
            try:
                self.bridge_server.server_close()
            except Exception:
                pass

        self.bridge_server = None
        self.bridge_thread = None
        self.bridge_port = None
        self.bridge_token = None
        self._remove_bridge_info_file()
        self.bridge_info_path = None


    def start_bridge_server(self) -> None:
        if not self.bridge_enabled:
            return

        info_path = self._get_bridge_info_path()
        if info_path is None:
            return

        if self.bridge_server is not None and self.bridge_info_path == info_path:
            self._write_bridge_info()
            return

        self.stop_bridge_server()
        self.bridge_token = uuid.uuid4().hex
        neurotrace_server = self

        class ThreadedBridgeServer(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        class BridgeHandler(socketserver.StreamRequestHandler):
            def handle(self):
                while True:
                    line = self.rfile.readline()
                    if not line:
                        break

                    req_id = None
                    try:
                        req = json.loads(line.decode("utf-8"))
                        req_id = req.get("id")
                        if req.get("token") != neurotrace_server.bridge_token:
                            response = {
                                "id": req_id,
                                "error": "Unauthorized bridge request.",
                                "success": False,
                            }
                        else:
                            validate_workspace_request(req, neurotrace_server.workspace_path)
                            result = execute_backend_command(
                                neurotrace_server,
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

        self.bridge_server = ThreadedBridgeServer(("127.0.0.1", 0), BridgeHandler)
        self.bridge_port = int(self.bridge_server.server_address[1])
        self.bridge_thread = threading.Thread(
            target=self.bridge_server.serve_forever,
            daemon=True,
            name="NeuroTraceBridge",
        )
        self.bridge_thread.start()
        self._write_bridge_info()
        print(
            f"NeuroTrace bridge listening on 127.0.0.1:{self.bridge_port}",
            file=sys.stderr,
        )
