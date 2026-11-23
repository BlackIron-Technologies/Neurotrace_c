"""Local server lifecycle with cross-process discovery."""
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
import json

from neurotrace_platform.processes import ProcessLock, wait_pid_exit, pid_alive
from .profile import Remote, sync_home
from .endpoints import PublicEndpoint
from .local_server import discover

_endpoint = PublicEndpoint()
_setup_key = None
_children = {}


def database_path():
    return sync_home() / 'host' / 'server.db'


def status():
    from .services import service_status
    record = discover(database_path())
    return {'running': bool(record), 'url': record['url'] if record else None,
            'pid': record['pid'] if record else None, 'initialized': record['initialized'] if record else False,
            **_endpoint.status(), 'service': service_status()}


def start(port=9473, service_managed=False):
    global _setup_key
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError('Choose a port between 1024 and 65535')
    database = database_path()
    database.parent.mkdir(parents=True, exist_ok=True)
    with ProcessLock(database.parent / 'start.lock'):
        existing = discover(database)
        if existing:
            if existing['url'] != 'http://127.0.0.1:' + str(port):
                raise ValueError('The server is already running on ' + existing['url'])
            return {**status(), 'setup_key': _setup_key if existing['pid'] in _children else None}
        from .services import service_status
        if not service_managed and service_status()['installed']:
            raise ValueError('The background service owns this server. Start it from the background service controls.')
        _setup_key = secrets.token_urlsafe(32)
        env = {**os.environ, 'NEUROTRACE_SYNC_SETUP_KEY': _setup_key}
        entry = [sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, str(Path(__file__).resolve().parent.parent / 'neurotrace.py')]
        args = entry + ['--sync-server', '--database', str(database), '--port', str(port)]
        kwargs = {'start_new_session': True} if os.name != 'nt' else {
            'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
        with open(database.parent / 'server.log', 'a', encoding='utf-8') as log:
            process = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True, **kwargs)
        _children[process.pid] = process
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('Server failed to start. Check ' + str(database.parent / 'server.log'))
            try:
                ready = discover(database)
            except RuntimeError:
                ready = None
            if ready:
                return {**status(), 'setup_key': _setup_key}
            time.sleep(0.1)
        raise RuntimeError('Server process started but is not responding. Inspect server.log before retrying.')


def verify(public_url):
    record = discover(database_path())
    if not record:
        raise ValueError('Start your local server first')
    return _endpoint.verify(public_url, record['url'])


def stop():
    global _setup_key
    from .services import service_status
    if service_status()['installed']:
        raise ValueError('Remove the background service before stopping its server')
    record = discover(database_path())
    if record:
        request = Request(record['url'] + '/v1/local-stop', data=b'{}',
                          headers={'X-NeuroTrace-Control': record['control_token'], 'Content-Type': 'application/json'})
        with urlopen(request, timeout=5) as response:
            json.load(response)
        if record['pid'] in _children:
            _children.pop(record['pid']).wait(timeout=10)
        elif os.name == 'nt':
            wait_pid_exit(record['pid'], 10)
        else:
            from .local_server import info_path
            deadline = time.monotonic() + 10
            while info_path(database_path()).exists() and pid_alive(record['pid']):
                if time.monotonic() >= deadline:
                    raise RuntimeError('Server shutdown did not finish; inspect the process before retrying')
                time.sleep(.1)
    _endpoint.stop()
    _setup_key = None
    return status()
