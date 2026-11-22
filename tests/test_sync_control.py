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
from neurotrace_sync.profile import Profile


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
        self.project = (await self.request('POST', '/v1/projects', {'name': 'Test'}, self.owner))['id']
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
        headers = {'Authorization': 'Bearer ' + actor['token']} if actor else {}
        async with self.session.request(method, self.url + path, json=data, headers=headers) as response:
            result = await response.json()
            self.assertEqual(response.status, 200, result)
            return result

    async def client(self, name, credentials=None):
        credentials = credentials or self.owner
        path = self.root / name
        path.mkdir()
        server = NeuroTraceServer(None)
        server.set_workspace(str(path))
        server._ensure_database_ready()
        self.clients.append(server)
        self.tokens[credentials['actor_id']] = credentials['token']
        Profile(path).write({'server_url': self.url, 'project_id': self.project, 'actor_id': credentials['actor_id'],
                             'enabled': True, 'role': 'editor', 'actor_name': name})
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
        path.mkdir()
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
