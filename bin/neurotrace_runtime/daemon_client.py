from neurotrace_platform.processes import ProcessLock, pid_alive, atomic_json
from .common import (BACKEND_ROOT, Optional, Path, STANDALONE_DAEMON_INFO_FILENAME, json, os, socket, subprocess, sys, time, uuid)

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

def _validate_endpoint_workspace(info, workspace):
    if info.get('protocol') != 2:
        raise BackendCommandError('The NeuroTrace backend is outdated. Reload the IDE or restart the upgraded standalone backend.')
    recorded = info.get('workspace')
    if not recorded or not Path(recorded).is_absolute() or Path(recorded).resolve() != Path(workspace).resolve():
        raise BackendCommandError('Saved MCP endpoint belongs to another workspace. Reconnect NeuroTrace in this project.')
    return info

class BackendCommandError(RuntimeError):
    """A reachable backend rejected a command."""


def _read_bridge_info(workspace_path: Optional[str]):
    if not workspace_path:
        raise BridgeUnavailableError(
            "Open the NeuroTrace sidebar in your IDE and wait for the backend to start."
        )

    info_path = Path(workspace_path) / ".neurotrace" / "backend_bridge.json"
    try:
        return _validate_endpoint_workspace(json.loads(info_path.read_text(encoding="utf-8")), workspace_path)
    except BackendCommandError:
        raise
    except Exception as exc:
        raise BridgeUnavailableError(
            "Open the NeuroTrace sidebar in your IDE and wait for the backend to start."
        ) from exc


def _send_bridge_command(workspace_path: Optional[str], command: str, payload=None):
    bridge_info = _read_bridge_info(workspace_path)
    request = {
        "id": f"bridge-{uuid.uuid4().hex}",
        "token": bridge_info.get("token"),
        'workspace': str(Path(workspace_path).resolve()),
        "command": command,
        "payload": payload or {},
    }

    try:
        with socket.create_connection(
            (bridge_info.get("host", "127.0.0.1"), int(bridge_info["port"])),
            timeout=2.0,
        ) as sock:
            if command in ('sync', 'host', 'connect', 'team'):
                sock.settimeout(40 if command == 'sync' else 120)
            sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
            response_buffer = b""
            while b"\n" not in response_buffer:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                response_buffer += chunk
    except Exception as exc:
        raise BridgeUnavailableError(
            "Open the NeuroTrace sidebar in your IDE and wait for the backend to start."
        ) from exc

    if not response_buffer:
        raise BridgeUnavailableError(
            "Open the NeuroTrace sidebar in your IDE and wait for the backend to start."
        )

    response = json.loads(response_buffer.split(b"\n", 1)[0].decode("utf-8"))
    if not response.get("success"):
        raise BackendCommandError(response.get("error", "Bridge request failed."))

    return response.get("data")


def _get_daemon_info_path(workspace_path: str) -> Path:
    return Path(workspace_path) / ".neurotrace" / STANDALONE_DAEMON_INFO_FILENAME


def _write_daemon_info(workspace_path: str, host: str, port: int, token: str) -> Path:
    info_path = _get_daemon_info_path(workspace_path)
    info_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(info_path, {'protocol': 2, 'host': host, 'port': port, 'token': token,
                            'pid': os.getpid(), 'workspace': str(Path(workspace_path).resolve())})
    return info_path


def _remove_daemon_info(workspace_path: str, expected_pid=None) -> None:
    info_path = _get_daemon_info_path(workspace_path)
    if not info_path.exists():
        return
    try:
        if expected_pid is not None and json.loads(info_path.read_text(encoding='utf-8')).get('pid') != expected_pid:
            return
        info_path.unlink()
    except OSError:
        pass


def _read_daemon_info(workspace_path: Optional[str]):
    if not workspace_path:
        raise DaemonUnavailableError("Workspace path is required to use NeuroTrace standalone mode.")

    info_path = _get_daemon_info_path(workspace_path)
    try:
        info = json.loads(info_path.read_text(encoding="utf-8"))
        if type(info.get('pid')) is not int or info['pid'] <= 0:
            raise DaemonUnavailableError('Daemon metadata has no verifiable process owner; inspect it before restarting.')
        if not pid_alive(info['pid']):
            raise DaemonUnavailableError('The recorded NeuroTrace daemon process has exited.')
        return _validate_endpoint_workspace(info, workspace_path)
    except BackendCommandError:
        raise
    except Exception as exc:
        raise DaemonUnavailableError(
            "NeuroTrace standalone daemon is not running for this workspace."
        ) from exc


def _send_socket_command(
    endpoint_info, command: str, payload=None, timeout: float = 2.0
):
    request = {
        "id": f"socket-{uuid.uuid4().hex}",
        "token": endpoint_info.get("token"),
        'workspace': endpoint_info.get('workspace'),
        "command": command,
        "payload": payload or {},
    }
    response_buffer = b""

    with socket.create_connection(
        (endpoint_info.get("host", "127.0.0.1"), int(endpoint_info["port"])),
        timeout=timeout,
    ) as sock:
        if command in ('sync', 'host', 'connect', 'team'):
            sock.settimeout(40 if command == 'sync' else 120)
        sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
        while b"\n" not in response_buffer:
            chunk = sock.recv(65536)
            if not chunk:
                break
            response_buffer += chunk

    if not response_buffer:
        raise RuntimeError("Empty response from NeuroTrace endpoint.")

    response = json.loads(response_buffer.split(b"\n", 1)[0].decode("utf-8"))
    if not response.get("success"):
        raise BackendCommandError(response.get("error", "Socket request failed."))

    return response.get("data")


def _build_daemon_spawn_args(workspace_path: str):
    if getattr(sys, "frozen", False):
        return [sys.executable, "--daemon", "--workspace", workspace_path]
    return [sys.executable, str(BACKEND_ROOT / "neurotrace.py"), "--daemon", "--workspace", workspace_path]


def _spawn_detached_process(args):
    kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(args, **kwargs)


def _ensure_standalone_daemon_running(workspace_path: Optional[str]):
    if not workspace_path:
        raise DaemonUnavailableError("Workspace path is required to use NeuroTrace standalone mode.")
    workspace_path = str(Path(workspace_path).resolve())
    deadline = time.monotonic() + 8.0
    spawned = False
    last_error = None
    while time.monotonic() < deadline:
        try:
            daemon_info = _read_daemon_info(workspace_path)
        except BackendCommandError:
            raise
        except DaemonUnavailableError:
            daemon_info = None
        if daemon_info:
            try:
                _send_socket_command(daemon_info, 'check_db_status', {})
                return daemon_info
            except BackendCommandError:
                raise
            except (OSError, RuntimeError) as exc:
                last_error = exc
                if pid_alive(daemon_info.get('pid')):
                    time.sleep(0.1)
                    continue
        try:
            with ProcessLock(Path(workspace_path) / '.neurotrace' / 'daemon-start.lock'):
                current = _get_daemon_info_path(workspace_path)
                if current.exists():
                    try:
                        info = json.loads(current.read_text(encoding='utf-8'))
                    except (OSError, ValueError):
                        raise DaemonUnavailableError('Daemon metadata is unreadable; inspect the existing process before restarting.') from None
                    if type(info.get('pid')) is not int or info['pid'] <= 0:
                        raise DaemonUnavailableError('Daemon metadata has no verifiable process owner; inspect it before restarting.')
                    if pid_alive(info.get('pid')):
                        time.sleep(0.1)
                        continue
                if not spawned:
                    _remove_daemon_info(workspace_path)
                    _spawn_detached_process(_build_daemon_spawn_args(workspace_path))
                    spawned = True
        except BlockingIOError:
            pass
        time.sleep(0.1)
    raise DaemonUnavailableError(
        'NeuroTrace daemon did not respond in time. A live process was preserved; retry or inspect its process. No database unlock is required by this error.'
    ) from last_error


def _send_daemon_command(workspace_path: Optional[str], command: str, payload=None):
    try:
        daemon_info = _ensure_standalone_daemon_running(workspace_path)
        return _send_socket_command(daemon_info, command, payload)
    except (DaemonUnavailableError, BackendCommandError):
        raise
    except Exception as exc:
        raise DaemonUnavailableError(
            "NeuroTrace standalone daemon is unavailable for this workspace."
        ) from exc
