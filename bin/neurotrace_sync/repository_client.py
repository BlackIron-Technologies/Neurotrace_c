"""Client repository checks, invitation previews and legacy-project adoption."""
import json

from .profile import Profile, Remote
from .repository import (RepositoryMismatch, database_repository, pin_database, require_same_repository,
                         workspace_repository)


def compatible_server(remote):
    status = remote.request('/v1/status')
    if status.get('protocol') != 1 or 'repository_binding' not in status.get('capabilities', []):
        raise ValueError('Upgrade the NeuroTrace server to 1.3.3 or newer before connecting')
    return status


def check_local_project(conn, project):
    if conn.execute("SELECT 1 FROM sqlite_master WHERE name='sync_binding'").fetchone():
        row = conn.execute('SELECT project FROM sync_binding').fetchone()
        if row and row[0] != project:
            raise RepositoryMismatch('This database belongs to another shared project. Open its matching workspace.')


class RepositoryClientMixin:
    def repository_context(self):
        profile = Profile(self.workspace_path).read() if self.workspace_path else None
        try:
            repository = workspace_repository(self.workspace_path)
            previous = database_repository(self.conn) if self.conn else None
            if previous:
                require_same_repository(previous, repository)
            return {'repository': repository, 'legacy_unverified': bool(self.conn and not previous),
                    'needs_adoption': bool(profile and not profile.get('repository')),
                    'can_protect': bool(profile and profile.get('role') == 'owner'),
                    'protected': bool(profile and profile.get('repository'))}
        except ValueError as exc:
            return {'repository': None, 'error': str(exc), 'protected': False}

    def guard_repository(self):
        profile = Profile(self.workspace_path).read() if self.workspace_path else None
        previous = database_repository(self.conn) if self.conn else None
        if not profile and not previous:
            return
        current = workspace_repository(self.workspace_path)
        if previous:
            require_same_repository(previous, current)
        if not profile:
            return
        if not profile.get('repository'):
            raise RepositoryMismatch('This legacy project needs repository protection. Its owner must select Protect this project in Team sync.')
        require_same_repository(profile['repository'], current)
        if self.conn is None:
            return
        if not previous:
            raise RepositoryMismatch('Database repository identity is missing. Reconnect through a verified project import.')
        require_same_repository(previous, current)

    def preview_connection(self, server_url, code, path_policy='reject', type_map=None):
        repository = workspace_repository(self.workspace_path)
        previous = database_repository(self.conn) if self.conn else None
        if previous:
            require_same_repository(previous, repository)
        remote = Remote(server_url, repository=repository)
        compatible_server(remote)
        result = remote.request('/v1/invitations/inspect', {'code': code, 'repository': repository})
        if self.conn:
            check_local_project(self.conn, result['project_id'])
        from .import_validation import preview_import
        result['import_validation'] = preview_import(self.conn, self.workspace_path, path_policy, type_map)
        return result

    def repository_control(self, action='status'):
        if action == 'status':
            return self.repository_context()
        if action != 'protect_project':
            raise ValueError('Choose status or protect_project')
        store = Profile(self.workspace_path)
        profile = store.read()
        if not profile or self.conn is None:
            raise ValueError('Connect and unlock the legacy project before protecting its repository')
        repository = workspace_repository(self.workspace_path)
        previous = database_repository(self.conn)
        if previous:
            require_same_repository(previous, repository)
        remote = Remote(profile['server_url'], store.token(profile), repository)
        status = compatible_server(remote)
        remote.request('/v1/projects/' + profile['project_id'] + '/repository', {'repository': repository})
        with self.conn:
            pin_database(self.conn, repository)
        profile.update(repository=repository, server_instance_id=status['instance_id'])
        store.write(profile)
        if self.sync_worker:
            self.sync_worker.stop()
            self.sync_worker = None
        self.sync_start()
        return {'success': True, 'repository': repository, 'sync': self.sync_status()}
