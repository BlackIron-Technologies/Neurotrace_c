"""Agent sync barriers exercise the real worker without holding its database lock."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))

from aiohttp import ClientSession
from aiohttp.test_utils import TestServer
from neurotrace_runtime.commands import execute_backend_command
from neurotrace_runtime.server import NeuroTraceServer
from neurotrace_sync.http_server import create_app
from neurotrace_sync.profile import Profile, RemoteError
from neurotrace_sync.repository import pin_database
from sync_fixtures import REPOSITORY, git_workspace


class AgentSyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.environment = patch.dict(os.environ, {'NEUROTRACE_SYNC_HOME': str(self.root / 'bindings')})
        self.environment.start()
        self.tokens = {}
        self.credentials = patch.object(Profile, 'token', autospec=True, side_effect=lambda _, value: self.tokens[value['actor_id']])
        self.credentials.start()
        self.central = TestServer(create_app(self.root / 'central.db', 'test-key'))
        await self.central.start_server()
        self.url = str(self.central.make_url('')).rstrip('/')
        self.session = ClientSession()
        self.owner = await self.request('POST', '/v1/bootstrap', {'key': 'test-key', 'name': 'Owner', 'network_name': 'Test'})
        self.project = (await self.request('POST', '/v1/projects', {'name': 'Test', 'repository': REPOSITORY}, self.owner))['id']
        self.clients = []

    async def asyncTearDown(self):
        workers = [client.sync_worker for client in self.clients if client.sync_worker]
        for client in self.clients:
            with client.command_lock:
                client.cleanup_and_exit()
        for worker in workers:
            await asyncio.to_thread(worker.thread.join, 3)
        await self.session.close()
        await self.central.close()
        self.credentials.stop()
        self.environment.stop()
        self.temp.cleanup()

    async def request(self, method, path, data=None, actor=None):
        headers = {'X-NeuroTrace-Repository': REPOSITORY['id']}
        if actor:
            headers['Authorization'] = 'Bearer ' + actor['token']
        if path == '/v1/join' and data is not None:
            data = {**data, 'repository': REPOSITORY}
        async with self.session.request(method, self.url + path, json=data, headers=headers) as response:
            result = await response.json()
            self.assertEqual(response.status, 200, result)
            return result

    async def client(self, name, credentials=None):
        credentials = credentials or self.owner
        path = self.root / name
        git_workspace(path)
        server = NeuroTraceServer(None)
        server.set_workspace(str(path))
        server._ensure_database_ready()
        self.clients.append(server)
        self.tokens[credentials['actor_id']] = credentials['token']
        with server.conn:
            pin_database(server.conn, REPOSITORY)
        Profile(path).write({'server_url': self.url, 'project_id': self.project, 'actor_id': credentials['actor_id'],
                             'enabled': True, 'role': 'editor', 'actor_name': name, 'repository': REPOSITORY,
                             'server_instance_id': (await self.request('GET', '/v1/status'))['instance_id']})
        with server.command_lock:
            server.sync_start()
        return server

    async def peer(self):
        invitation = await self.request('POST', '/v1/projects/' + self.project + '/invite',
                                        {'kind': 'human', 'role': 'editor', 'name': 'Peer'}, self.owner)
        credentials = await self.request('POST', '/v1/join', {'code': invitation['code']})
        return await self.client('peer', credentials)

    async def command(self, server, command, payload=None):
        return await asyncio.to_thread(execute_backend_command, server, command, payload or {})

    async def test_wait_confirms_server_and_other_device_without_deadlock(self):
        owner, peer = await self.client('owner'), await self.peer()
        memory = await self.command(owner, 'add_thought', {'text': 'Agent handoff', 'type': 'note'})
        result = await self.command(owner, 'sync', {'action': 'wait', 'thought_id': memory['id'], 'wait_for_peers': 1, 'timeout_ms': 5000})
        self.assertTrue(result['success'], result)
        self.assertGreaterEqual(result['received_by_devices'], 1)
        value = await self.command(peer, 'get_thought', {'thought_id': memory['id']})
        self.assertEqual(value['base_text'], 'Agent handoff')
        self.assertEqual(value['thought']['id'], memory['id'])
        self.assertTrue(value['sync']['server_confirmed'])

    async def test_wait_times_out_when_other_device_has_not_received_new_change(self):
        owner, peer = await self.client('owner'), await self.peer()
        await self.command(peer, 'sync_pause', {'paused': True})
        memory = await self.command(owner, 'add_thought', {'text': 'Not delivered to peer', 'type': 'note'})
        result = await self.command(owner, 'sync', {'action': 'wait', 'thought_id': memory['id'], 'wait_for_peers': 1, 'timeout_ms': 800})
        self.assertFalse(result['success'], result)
        self.assertTrue(result['timed_out'])
        self.assertTrue(result['server_confirmed'])
        self.assertEqual(result['delivery']['received_by_devices'], 0)

    async def test_retry_does_not_resume_user_pause(self):
        owner = await self.client('owner')
        await self.command(owner, 'sync_pause', {'paused': True})
        await self.command(owner, 'add_thought', {'text': 'Remain private until resume', 'type': 'note'})
        result = await self.command(owner, 'sync', {'action': 'retry'})
        self.assertFalse(result['retry_scheduled'])
        self.assertEqual(result['reason'], 'paused')
        self.assertEqual(result['pending_operations'], 1)
        self.assertFalse(result['caught_up'])

    async def test_status_read_is_local_only_and_reports_unconfigured(self):
        path = self.root / 'local'
        git_workspace(path)
        server = NeuroTraceServer(None)
        server.set_workspace(str(path))
        server._ensure_database_ready()
        self.clients.append(server)
        result = await self.command(server, 'sync', {'action': 'status'})
        self.assertEqual(result['state'], 'unconfigured')
        self.assertFalse(result['server_confirmed'])
        memory = await self.command(server, 'add_thought', {'text': 'Local memory'})
        self.assertEqual((await self.command(server, 'get_thought', {'thought_id': memory['id']}))['base_text'], 'Local memory')

    async def test_wait_rejects_invalid_limits(self):
        owner = await self.client('owner')
        for payload in ({'timeout_ms': 30001}, {'wait_for_peers': -1}, {'action': 'change-server'}):
            with self.assertRaises(ValueError):
                await self.command(owner, 'sync', payload)


    async def test_wrong_repository_mcp_join_does_not_consume_invite(self):
        invitation = await self.request('POST', '/v1/projects/' + self.project + '/invite',
                                        {'kind': 'human', 'role': 'editor', 'name': 'Peer'}, self.owner)
        path = git_workspace(self.root / 'wrong', 'https://github.com/other/project')
        server = NeuroTraceServer(None); server.set_workspace(str(path)); server._ensure_database_ready(); self.clients.append(server)
        with patch.object(Profile, 'prepare_credentials', return_value=None):
            with self.assertRaises(RemoteError):
                await self.command(server, 'connect', {'invitation_url': self.url + '/#join=' + invitation['code']})
        member = await self.request('POST', '/v1/join', {'code': invitation['code']})
        self.assertEqual(member['project_id'], self.project)
        self.assertEqual(server.conn.execute('SELECT COUNT(*) FROM thoughts').fetchone()[0], 0)
        self.assertIsNone(Profile(path).read())

    async def test_invalid_legacy_import_reports_all_errors_before_consuming_invite(self):
        from neurotrace_sync.import_validation import ImportValidationError
        invitation = await self.request('POST', '/v1/projects/' + self.project + '/invite',
                                        {'kind': 'human', 'role': 'editor', 'name': 'Peer'}, self.owner)
        path = git_workspace(self.root / 'legacy-import')
        server = NeuroTraceServer(None)
        server.set_workspace(str(path)); server._ensure_database_ready(); self.clients.append(server)
        with server.conn:
            server.conn.execute("INSERT INTO thoughts(id,text,type,file_path) VALUES('old','Preserve','finding','/other/checkout/src/file.ts')")
        link = self.url + '/#join=' + invitation['code']
        preview = await self.command(server, 'connect', {'invitation_url': link, 'preview_only': True})
        self.assertEqual(len(preview['import_validation']['issues']), 2)
        with self.assertRaises(ImportValidationError) as rejected:
            await self.command(server, 'connect', {'invitation_url': link, 'publish_existing': True, 'confirm_legacy_repository': True})
        self.assertEqual(len(rejected.exception.report['issues']), 2)
        member = await self.request('POST', '/v1/join', {'code': invitation['code']})
        self.assertEqual(member['project_id'], self.project)
        self.assertEqual(server.conn.execute('SELECT text FROM thoughts').fetchone()[0], 'Preserve')
        self.assertIsNone(Profile(path).read())

    async def test_git_origin_change_blocks_pending_writes_and_restoration_resumes(self):
        import subprocess
        owner = await self.client('owner')
        await self.command(owner, 'sync_pause', {'paused': True})
        memory = await self.command(owner, 'add_thought', {'text': 'Queued before origin changed'})
        subprocess.run(['git', '-C', str(owner.workspace_path), 'remote', 'set-url', 'origin', 'https://github.com/other/project'], check=True)
        await self.command(owner, 'sync_pause', {'paused': False})
        self.assertEqual((await self.command(owner, 'sync_status'))['state'], 'repository_mismatch')
        for command, payload in [('add_thought', {'text': 'Forbidden'}), ('list', {}), ('get_thought', {'thought_id': memory['id']})]:
            with self.assertRaises(ValueError):
                await self.command(owner, command, payload)
        snapshot = await self.request('GET', '/v1/projects/' + self.project + '/snapshot', actor=self.owner)
        self.assertEqual(snapshot['records'], [])
        self.assertEqual(owner.conn.execute("SELECT COUNT(*) FROM sync_outbox WHERE state='pending'").fetchone()[0], 1)
        subprocess.run(['git', '-C', str(owner.workspace_path), 'remote', 'set-url', 'origin', REPOSITORY['origin']], check=True)
        await self.command(owner, 'sync_pause', {'paused': False})
        result = await self.command(owner, 'sync', {'action': 'wait', 'timeout_ms': 5000})
        self.assertTrue(result['success'], result)

    async def test_copied_database_provenance_rejects_other_repository_before_network(self):
        path = git_workspace(self.root / 'copied', 'https://github.com/other/project')
        server = NeuroTraceServer(None); server.set_workspace(str(path)); server._ensure_database_ready(); self.clients.append(server)
        with server.conn:
            pin_database(server.conn, REPOSITORY)
        with self.assertRaises(ValueError):
            await self.command(server, 'preview_connection', {'server_url': self.url, 'code': 'not-even-used'})
        for command, payload in [('list', {}), ('add_thought', {'text': 'Wrong database'})]:
            with self.assertRaises(ValueError):
                await self.command(server, command, payload)
        self.assertIsNone(Profile(path).read())

    async def test_explicit_owner_adopts_legacy_project_without_reimport(self):
        owner = await self.client('owner')
        await self.command(owner, 'sync_pause', {'paused': True})
        profile = Profile(owner.workspace_path).read(); profile.pop('repository'); profile['enabled'] = True; Profile(owner.workspace_path).write(profile)
        import sqlite3
        connection = sqlite3.connect(self.root / 'central.db'); connection.execute('UPDATE projects SET repository=NULL WHERE id=?', (self.project,)); connection.commit(); connection.close()
        self.assertEqual((await self.command(owner, 'sync_status'))['state'], 'repository_mismatch')
        result = await self.command(owner, 'sync_repository', {'action': 'protect_project'})
        self.assertTrue(result['success'])
        self.assertEqual(Profile(owner.workspace_path).read()['repository'], REPOSITORY)
        result = await self.command(owner, 'sync', {'action': 'wait', 'timeout_ms': 5000})
        self.assertTrue(result['success'], result)

class McpContracts(unittest.TestCase):
    def test_tools_are_registered_in_stdio_and_vscode_with_matching_contracts(self):
        from neurotrace_runtime.mcp_protocol import MCP_TOOL_DEFINITIONS
        package = json.loads((Path(__file__).resolve().parents[1] / 'package.json').read_text())
        vscode = {tool['name']: tool['inputSchema'] for tool in package['contributes']['languageModelTools']}
        stdio = {tool['name']: tool['inputSchema'] for tool in MCP_TOOL_DEFINITIONS}
        for name in ('neurotrace_sync', 'neurotrace_getThought', 'neurotrace_host', 'neurotrace_connect', 'neurotrace_team'):
            self.assertEqual(vscode[name], stdio[name])

    def test_host_start_never_returns_setup_secret(self):
        from neurotrace_sync.administration import SyncAdministration
        with patch('neurotrace_sync.administration.hosting.start', return_value={'running': True, 'setup_key': 'private'}):
            self.assertEqual(SyncAdministration().host('start'), {'running': True})
