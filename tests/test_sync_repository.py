"""Repository isolation, portable origins and branch-independent checkout tests."""
import asyncio
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

from aiohttp import ClientSession, WSServerHandshakeError
from aiohttp.test_utils import TestServer
from sync_fixtures import REPOSITORY, git_workspace
from neurotrace_sync.http_server import create_app
from neurotrace_sync.repository import repository_identity, workspace_repository, require_same_repository, RepositoryMismatch


class RepositoryIdentityTests(unittest.TestCase):
    def test_cross_os_sqlite_paths_are_rejected(self):
        from neurotrace_sync.platform_storage import require_native_storage
        for path, platform in [('/mnt/c/projects/repo', 'linux'), (r'\\wsl.localhost\Ubuntu\home\user\repo', 'win32')]:
            with self.assertRaises(ValueError):
                require_native_storage(path, platform)
        require_native_storage('/home/user/repo', 'linux')
        require_native_storage('C:/Projects/repo', 'win32')

    def test_transport_credentials_suffix_and_github_case_are_normalized(self):
        expected = repository_identity('https://github.com/Owner/Repo.git')
        for url in ['git@github.com:owner/repo.git', 'ssh://git@github.com:22/OWNER/REPO', 'https://user:private@GITHUB.COM/Owner/Repo/']:
            self.assertEqual(expected, repository_identity(url))
        self.assertNotIn('private', json.dumps(expected))

    def test_forks_hosts_ports_and_monorepo_scopes_remain_distinct(self):
        first = repository_identity('https://github.com/team/repo')
        for url, scope in [('https://github.com/fork/repo', ''), ('https://git.example.com/team/repo', ''),
                           ('ssh://git@github.com:2222/team/repo', ''), ('https://github.com/team/repo', 'packages/api')]:
            with self.assertRaises(RepositoryMismatch):
                require_same_repository(first, repository_identity(url, scope))

    def test_unsafe_origins_and_scopes_are_rejected(self):
        for value in ['C:/local/repo', '/tmp/repo', 'file:///tmp/repo', 'https://host/team/../other', 'https://host/team/repo?token=private']:
            with self.assertRaises(ValueError):
                repository_identity(value)
        for scope in ['../other', '/absolute', 'a/../b', 'C:/other']:
            with self.assertRaises(ValueError):
                repository_identity(REPOSITORY['origin'], scope)

    def test_branches_detached_head_and_worktrees_share_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = git_workspace(Path(temporary) / 'checkout')
            def git(*args):
                subprocess.run(['git', '-C', str(repo), *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial')
            first = workspace_repository(repo)
            git('checkout', '-b', 'feature/other-branch')
            self.assertEqual(first, workspace_repository(repo))
            other = Path(temporary) / 'worktree'
            git('worktree', 'add', '-b', 'feature/worktree', str(other))
            self.assertEqual(first, workspace_repository(other))
            git('checkout', '--detach')
            self.assertEqual(first, workspace_repository(repo))
            nested = repo / 'packages/api'; nested.mkdir(parents=True)
            self.assertNotEqual(first['id'], workspace_repository(nested)['id'])

    def test_missing_ambiguous_and_changed_origins(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(ValueError):
                workspace_repository(root)
            repo = git_workspace(root / 'checkout')
            original = workspace_repository(repo)
            subprocess.run(['git', '-C', str(repo), 'remote', 'set-url', 'origin', 'https://github.com/other/repo'], check=True)
            with self.assertRaises(RepositoryMismatch):
                require_same_repository(original, workspace_repository(repo))
            subprocess.run(['git', '-C', str(repo), 'config', '--add', 'remote.origin.url', REPOSITORY['origin']], check=True)
            with self.assertRaisesRegex(ValueError, 'multiple'):
                workspace_repository(repo)


class RepositoryApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'server.db'
        self.server = TestServer(create_app(self.path, 'setup'))
        await self.server.start_server()
        self.session = ClientSession()
        self.owner = await self.request('POST', '/v1/bootstrap', {'key':'setup','name':'Owner','network_name':'Network'})
        self.project = (await self.request('POST', '/v1/projects', {'name':'Project','repository':REPOSITORY}, self.owner))['id']

    async def asyncTearDown(self):
        await self.session.close(); await self.server.close(); self.temp.cleanup()

    async def request(self, method, path, data=None, actor=None, repository=REPOSITORY, expected=200):
        headers = {'Authorization':'Bearer '+actor['token']} if actor else {}
        if repository: headers['X-NeuroTrace-Repository'] = repository['id']
        async with self.session.request(method, self.server.make_url(path), json=data, headers=headers) as response:
            result = await response.json(); self.assertEqual(response.status, expected, result); return result

    async def invitation(self, role='editor'):
        return await self.request('POST', '/v1/projects/'+self.project+'/invite', {'name':'Member','kind':'human','role':role}, self.owner)

    async def test_wrong_repository_cannot_preview_join_or_consume_invitation(self):
        invite = await self.invitation()
        wrong = repository_identity('https://github.com/another/project')
        for endpoint in ['/v1/invitations/inspect','/v1/join']:
            await self.request('POST', endpoint, {'code':invite['code'],'repository':wrong}, expected=409)
        preview = await self.request('POST','/v1/invitations/inspect',{'code':invite['code'],'repository':REPOSITORY})
        self.assertEqual(preview['project_id'], self.project)
        self.assertNotIn('token', preview)
        member = await self.request('POST','/v1/join',{'code':invite['code'],'repository':REPOSITORY})
        self.assertEqual(member['project_id'], self.project)
        await self.request('POST','/v1/join',{'code':invite['code'],'repository':REPOSITORY},expected=403)

    async def test_old_or_wrong_clients_cannot_read_write_or_open_websocket(self):
        base='/v1/projects/'+self.project
        wrong=repository_identity('https://github.com/other/project')
        for repository in [None, wrong]:
            await self.request('GET',base+'/snapshot',actor=self.owner,repository=repository,expected=409)
            await self.request('POST',base+'/operations',{'id':'x'},self.owner,repository=repository,expected=409)
            headers={'Authorization':'Bearer '+self.owner['token']}
            if repository:headers['X-NeuroTrace-Repository']=repository['id']
            with self.assertRaises(WSServerHandshakeError):
                await self.session.ws_connect(self.server.make_url(base+'/ws'),headers=headers)
        snapshot=await self.request('GET',base+'/snapshot',actor=self.owner)
        self.assertEqual(snapshot['records'],[])

    async def test_membership_is_still_required_with_correct_repository(self):
        project=(await self.request('POST','/v1/projects',{'name':'Private','repository':REPOSITORY},self.owner))['id']
        invite=await self.invitation('viewer')
        member=await self.request('POST','/v1/join',{'code':invite['code'],'repository':REPOSITORY})
        await self.request('GET','/v1/projects/'+project+'/snapshot',actor=member,expected=403)

    async def test_legacy_project_requires_owner_and_binding_cannot_be_changed(self):
        invite=await self.invitation('viewer')
        member=await self.request('POST','/v1/join',{'code':invite['code'],'repository':REPOSITORY})
        conn=sqlite3.connect(self.path);conn.execute('UPDATE projects SET repository=NULL WHERE id=?',(self.project,));conn.commit();conn.close()
        base='/v1/projects/'+self.project
        await self.request('GET',base+'/snapshot',actor=self.owner,expected=409)
        await self.request('POST',base+'/repository',{'repository':REPOSITORY},member,expected=403)
        await self.request('POST',base+'/repository',{'repository':REPOSITORY},self.owner,repository=None)
        await self.request('POST',base+'/repository',{'repository':repository_identity('https://github.com/wrong/repo')},self.owner,expected=409)
        await self.request('GET',base+'/snapshot',actor=self.owner)
