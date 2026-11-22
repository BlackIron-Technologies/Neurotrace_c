"""User-controlled local hosting with an administrator-provided public endpoint."""
import os
import secrets
import subprocess
import sys
import time
import socket
from pathlib import Path

from .profile import Remote, sync_home
from .endpoints import PublicEndpoint

_server = None
_endpoint = PublicEndpoint()
_setup_key = None
_url = None


def status():
    return {"running": bool(_server and _server.poll() is None), "url": _url, **_endpoint.status()}



def start(port=9473):
    global _server, _setup_key, _url
    if _server and _server.poll() is None:
        return {**status(), "setup_key": _setup_key}
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("Choose a port between 1024 and 65535")
    home = sync_home() / "host"
    home.mkdir(parents=True, exist_ok=True)
    _setup_key = secrets.token_urlsafe(32)
    env = {**os.environ, "NEUROTRACE_SYNC_SETUP_KEY": _setup_key}
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))
    entry = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, str(Path(__file__).resolve().parent.parent / "neurotrace.py")]
    args = entry + ["--sync-server", "--database", str(home / "server.db"), "--port", str(port)]
    log = open(home / "server.log", "a", encoding="utf-8")
    try:
        _server = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    finally:
        log.close()
    _url = "http://127.0.0.1:" + str(port)
    for _ in range(60):
        if _server.poll() is not None:
            raise RuntimeError("Server failed to start. Check " + str(home / "server.log"))
        try:
            Remote(_url).request("/v1/status")
            return {**status(), "setup_key": _setup_key}
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("Server did not become ready")


def verify(public_url):
    if not _server or _server.poll() is not None:
        raise ValueError('Start your local server first')
    return _endpoint.verify(public_url, _url)


def stop():
    global _server, _url, _setup_key
    _endpoint.stop()
    if _server and _server.poll() is None:
        _server.terminate()
        _server.wait(timeout=10)
    _server = _url = _setup_key = None
    return status()
