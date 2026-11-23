"""Install and remove an opt-in per-user sync server service."""
import getpass
import json
import os
from pathlib import Path
import sqlite3
from contextlib import closing
import subprocess
import sys
import time

from neurotrace_platform.processes import atomic_json, ProcessLock, wait_pid_exit
from .profile import sync_home
from .service_templates import windows_launcher, posix_launcher, windows_task, launch_agent, systemd_unit

TASK_NAME = 'NeuroTrace background sync'
LABEL = 'com.neurotrace.sync'
UNIT = 'neurotrace-sync.service'


def service_status():
    path = sync_home() / 'service' / 'service.json'
    record = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    return {'installed': bool(record), 'platform': sys.platform, 'port': record.get('port', 9473),
            'starts_at': 'user login', 'log': str(sync_home() / 'service' / 'server.log')}


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        raise RuntimeError('Service command failed: ' + (result.stderr or result.stdout).strip())
    return result.stdout


def definition(root, command, database, port, platform, home):
    log = root / 'server.log'
    if platform == 'win32':
        launcher = root / 'run-server.ps1'
        user = os.environ.get('USERDOMAIN', '') + '\\' + getpass.getuser()
        return launcher, windows_launcher(command, database, port, home, log), root / 'task.xml', windows_task(launcher, user), 'utf-16'
    launcher = root / 'run-server.sh'
    if platform == 'darwin':
        return launcher, posix_launcher(command, database, port, home, log), home / 'Library/LaunchAgents' / (LABEL + '.plist'), launch_agent(launcher, log, LABEL), None
    if platform == 'linux':
        config = Path(os.environ.get('XDG_CONFIG_HOME', str(home / '.config')))
        return launcher, posix_launcher(command, database, port, home, log), config / 'systemd/user' / UNIT, systemd_unit(launcher), 'utf-8'
    raise ValueError('Background hosting supports Windows, macOS and Linux')


def manager(action, path):
    if sys.platform == 'win32':
        if action == 'register':
            run(['schtasks.exe', '/Create', '/TN', TASK_NAME, '/XML', str(path), '/F'])
        elif action == 'start':
            run(['schtasks.exe', '/Run', '/TN', TASK_NAME])
        elif action == 'remove':
            run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                 "Stop-ScheduledTask -TaskName '" + TASK_NAME + "' -ErrorAction Stop"])
            run(['schtasks.exe', '/Delete', '/TN', TASK_NAME, '/F'])
    elif sys.platform == 'darwin':
        target = 'gui/' + str(os.getuid())
        if action == 'register':
            return
        run(['launchctl', 'bootstrap' if action == 'start' else 'bootout', target, str(path)])
    else:
        if action == 'register':
            run(['systemctl', '--user', 'daemon-reload'])
        elif action == 'start':
            run(['systemctl', '--user', 'enable', '--now', UNIT])
        else:
            run(['systemctl', '--user', 'disable', '--now', UNIT])


def service_control(action='status', port=9473):
    if action == 'status':
        return service_status()
    if action not in ('install', 'uninstall') or type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError('Choose install or uninstall with a port between 1024 and 65535')
    root = sync_home() / 'service'
    root.mkdir(parents=True, exist_ok=True)
    with ProcessLock(root / 'install.lock'):
        from . import hosting
        database = hosting.database_path()
        if action == 'uninstall':
            manifest = root / 'service.json'
            if not manifest.exists():
                return service_status()
            record = json.loads(manifest.read_text(encoding='utf-8'))
            path = Path(record['definition'])
            runner = root / 'runner.pid'
            runner_pid = int(runner.read_text(encoding='utf-8')) if runner.exists() else None
            manager('remove', path)
            if runner_pid:
                wait_pid_exit(runner_pid)
            manifest.unlink()
            path.unlink(missing_ok=True)
            if sys.platform == 'linux':
                run(['systemctl', '--user', 'daemon-reload'])
            hosting.stop()
            return service_status()
        existing_service = service_status()
        if existing_service['installed']:
            if existing_service['port'] != port:
                raise ValueError('Remove the existing background service before changing its port')
            return existing_service
        if not database.exists():
            raise ValueError('Set up a local network before installing its background service')
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as conn:
            if not conn.execute('SELECT 1 FROM network').fetchone():
                raise ValueError('Finish network setup before enabling background hosting')
        command = [sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, str(Path(__file__).resolve().parent.parent / 'neurotrace.py')]
        launcher, script, path, contents, encoding = definition(root, command, database, port, sys.platform, Path.home())
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            raise ValueError('A service definition already exists; remove or migrate it before installing')
        launcher.write_text(script, encoding='utf-8')
        if encoding:
            path.write_text(contents, encoding=encoding)
        else:
            path.write_bytes(contents)
        registered = False
        try:
            manager('register', path)
            registered = True
            hosting.stop()
            atomic_json(root / 'service.json', {'port': port, 'definition': str(path)})
            manager('start', path)
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                if hosting.status()['running']:
                    return service_status()
                time.sleep(0.2)
            raise RuntimeError('Background server did not become ready. Check ' + str(root / 'server.log'))
        except Exception:
            # Preserve the definition and ownership marker if registration succeeded.
            if not (root / 'service.json').exists():
                if registered:
                    manager('remove', path)
                path.unlink(missing_ok=True)
            raise
