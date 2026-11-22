"""Explicitly requested local hosting, connection and team administration."""
import getpass
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import hosting
from .profile import Profile


class SyncAdministration:
    def host(self, action='status', port=9473, public_url='', network_name='NeuroTrace team',
             project_name='', owner_name='', invite_name='Teammate', invite_role='editor', publish_existing=False):
        if action == 'status':
            return hosting.status()
        if action == 'stop':
            return hosting.stop()
        if action == 'start':
            result = hosting.start(port)
            return {key: value for key, value in result.items() if key != 'setup_key'}
        if action == 'verify':
            return hosting.verify(public_url)
        if action != 'setup':
            raise ValueError('Choose status, start, verify, setup or stop')
        if not public_url:
            raise ValueError('Ask the administrator for the public HTTPS URL. NeuroTrace does not create tunnels.')
        if not self.workspace_path:
            raise ValueError('Open a workspace before configuring its shared memory')
        if self.conn is None:
            error = self._ensure_database_ready()
            if error:
                raise ValueError(error)
        if self.conn.execute('SELECT COUNT(*) FROM thoughts').fetchone()[0] and not publish_existing and not Profile(self.workspace_path).read():
            raise ValueError('This workspace contains memories. Set publish_existing only with explicit authorization to share them.')
        started = hosting.start(port)
        verified = hosting.verify(public_url)
        existing = Profile(self.workspace_path).read()
        if existing and existing['server_url'] != verified['public_url']:
            raise ValueError('This workspace belongs to another server. Use a separate workspace.')
        imported = None
        if not existing:
            connected = self.sync_connect(verified['public_url'], mode='create', setup_key=started['setup_key'],
                                           name=owner_name or getpass.getuser(), network_name=network_name,
                                           project_name=project_name or self.workspace_path.name, publish=publish_existing)
            imported = connected.get('import_report')
        invitation = self.sync_manage('invite', {'name': invite_name, 'kind': 'human', 'role': invite_role})
        return {'success': True, 'server_url': verified['public_url'], 'project': self.sync_status()['project_id'],
                'invitation_url': verified['public_url'] + '/#join=' + invitation['code'], 'expires_in': 3600,
                'import_report': imported, 'sync': self.sync_status(),
                'hosting': 'Local process; administrator manages public tunnel and always-on service separately.'}

    def connect(self, invitation_url='', server_url='', setup_key_file='', name='', network_name='',
                project_name='', publish_existing=False):
        if self.conn is None:
            error = self._ensure_database_ready()
            if error:
                raise ValueError(error)
        if invitation_url:
            invitation = urlsplit(invitation_url)
            code = parse_qs(invitation.fragment).get('join', [''])[0]
            if not code:
                raise ValueError('Provide the complete invitation link')
            return self.sync_connect(invitation.scheme + '://' + invitation.netloc, code=code, publish=publish_existing)
        if not setup_key_file:
            raise ValueError('Provide an invitation URL, or a server URL and private bootstrap key file for a new network')
        key = Path(setup_key_file)
        if not key.is_file() or key.stat().st_size > 4096:
            raise ValueError('Choose a small, private file containing only the server setup key')
        return self.sync_connect(server_url, mode='create', setup_key=key.read_text(encoding='utf-8').strip(),
                                 name=name or getpass.getuser(), network_name=network_name, project_name=project_name,
                                 publish=publish_existing)

    def team(self, action='members', name='', role='editor', kind='human', member_id=''):
        if action == 'members':
            return self.sync_manage('members')
        if action == 'invite':
            result = self.sync_manage('invite', {'name': name, 'role': role, 'kind': kind})
            return {'invitation_url': self.sync_status()['server_url'] + '/#join=' + result['code'], 'expires_in': 3600}
        if action in ('set_role', 'remove'):
            return self.sync_manage('member', {'member': member_id, 'role': None if action == 'remove' else role})
        if action == 'transfer':
            return self.sync_manage('transfer', {'member': member_id})
        if action == 'create_project':
            return self.sync_manage('create_project', {'name': name})
        raise ValueError('Unsupported team action')
