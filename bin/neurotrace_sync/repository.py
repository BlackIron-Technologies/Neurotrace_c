"""Stable Git repository identities independent of branch and checkout location."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
from urllib.parse import unquote, urlsplit


class RepositoryMismatch(ValueError):
    pass


def repository_identity(origin, scope=''):
    if not isinstance(origin, str) or not origin.strip() or len(origin) > 4096:
        raise ValueError('Configure one HTTPS or SSH origin remote for this repository')
    value = origin.strip()
    if '://' not in value:
        match = re.fullmatch(r'(?:[^/@\s]+@)?([^/:\s]+):(.+)', value)
        if not match or len(match[1]) == 1:
            raise ValueError('Local-path remotes are not portable; configure an HTTPS or SSH origin')
        value = 'ssh://' + match[1] + '/' + match[2]
    try:
        url = urlsplit(value)
        if url.scheme not in ('https', 'http', 'ssh', 'git') or not url.hostname or url.query or url.fragment:
            raise ValueError()
        host = url.hostname.lower().rstrip('.').encode('idna').decode()
        if ':' in host:
            host = '[' + host + ']'
        port = url.port
    except (ValueError, UnicodeError):
        raise ValueError('Origin must be an HTTPS or SSH repository URL without a query or fragment') from None
    if port and port != {'https': 443, 'http': 80, 'ssh': 22, 'git': 9418}[url.scheme]:
        host += ':' + str(port)
    path = unquote(url.path).strip('/')
    if host == 'github.com':
        path = path.lower()
    if path.endswith('.git'):
        path = path[:-4]
    if not path or any(part in ('', '.', '..') for part in path.split('/')) or '\\' in path or any(ord(c) < 32 for c in path):
        raise ValueError('Origin contains an invalid repository path')
    scope = str(scope).replace('\\', '/')
    if scope.startswith('/'):
        raise ValueError('Workspace scope must be relative')
    scope = scope.rstrip('/')
    if scope and (PurePosixPath(scope).is_absolute() or any(p in ('', '.', '..') for p in scope.split('/')) or ':' in scope):
        raise ValueError('Workspace scope must be a project-relative directory')
    canonical = host + '/' + path
    fingerprint = hashlib.sha256((canonical + '\n' + scope).encode()).hexdigest()
    return {'id': fingerprint, 'origin': 'https://' + canonical, 'scope': scope}


def validate_repository(value):
    if not isinstance(value, dict) or set(value) != {'id', 'origin', 'scope'}:
        raise ValueError('A Git repository identity is required; upgrade the client')
    normalized = repository_identity(value['origin'], value['scope'])
    if normalized != value:
        raise ValueError('Invalid repository identity')
    return normalized


def workspace_repository(workspace):
    if not workspace:
        raise ValueError('Open the Git repository before connecting shared memory')
    root = Path(workspace).resolve()
    environment = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    environment['GIT_OPTIONAL_LOCKS'] = '0'
    def git(*args):
        try:
            result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True,
                                    encoding='utf-8', timeout=5, env=environment,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        except (OSError, subprocess.TimeoutExpired):
            raise ValueError('Git is required to verify this workspace before synchronization') from None
        if result.returncode:
            raise ValueError('Open a Git checkout with a configured origin remote before synchronizing')
        return result.stdout.strip()
    top = Path(git('rev-parse', '--show-toplevel')).resolve()
    origins = git('remote', 'get-url', '--all', 'origin').splitlines()
    if len(origins) != 1:
        raise ValueError('Origin has multiple URLs; configure one unambiguous repository')
    try:
        scope = root.relative_to(top).as_posix()
    except ValueError:
        raise ValueError('Workspace is outside its Git working tree') from None
    return repository_identity(origins[0], '' if scope == '.' else scope)


def require_same_repository(expected, actual):
    validate_repository(expected)
    validate_repository(actual)
    if expected['id'] != actual['id']:
        raise RepositoryMismatch('Wrong repository or workspace folder. Expected ' + expected['origin'] +
                                 (' / ' + expected['scope'] if expected['scope'] else '') +
                                 '. Open the matching checkout; no memories were exchanged.')


def database_repository(conn):
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='sync_repository'").fetchone():
        return None
    row = conn.execute('SELECT value FROM sync_repository WHERE key=\'identity\'').fetchone()
    return json.loads(row[0]) if row else None


def pin_database(conn, repository):
    previous = database_repository(conn)
    if previous:
        require_same_repository(previous, repository)
    conn.execute('CREATE TABLE IF NOT EXISTS sync_repository(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    conn.execute('INSERT OR IGNORE INTO sync_repository VALUES(\'identity\',?)', (json.dumps(repository),))
