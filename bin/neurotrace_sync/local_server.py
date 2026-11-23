"""Discover the process that owns a local server database."""
import json
import os
from pathlib import Path
import secrets
import sqlite3
from contextlib import closing
from urllib.parse import urlsplit

from neurotrace_platform.processes import atomic_json, pid_alive
from .profile import Remote


def info_path(database):
    return Path(str(database) + '.info.json')


def publish(database, host, port, instance_id):
    record = {'database': str(Path(database).resolve()), 'pid': os.getpid(),
              'url': 'http://' + host + ':' + str(port), 'instance_id': instance_id,
              'control_token': secrets.token_urlsafe(32)}
    atomic_json(info_path(database), record)
    return record


def forget(database):
    path = info_path(database)
    if path.exists():
        record = json.loads(path.read_text(encoding='utf-8'))
        if record.get('pid') == os.getpid():
            path.unlink(missing_ok=True)


def discover(database):
    database = Path(database).resolve()
    try:
        record = json.loads(info_path(database).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return None
    if record.get('database') != str(database) or not pid_alive(record.get('pid')):
        return None
    url = urlsplit(record.get('url', ''))
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.path or url.query or url.fragment or url.username:
        raise ValueError('Invalid local server descriptor')
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as conn:
        row = conn.execute("SELECT value FROM server_metadata WHERE key='instance_id'").fetchone()
    if not row or row[0] != record.get('instance_id'):
        raise ValueError('Local server descriptor belongs to another database')
    try:
        status = Remote(record['url']).request('/v1/status', timeout=2)
    except OSError as exc:
        raise RuntimeError('The existing local server process is alive but not responding; retry without starting another server') from exc
    if status.get('protocol') != 1 or status.get('instance_id') != record['instance_id']:
        raise ValueError('The local endpoint belongs to a different server')
    return {**record, 'initialized': status.get('initialized', False)}
