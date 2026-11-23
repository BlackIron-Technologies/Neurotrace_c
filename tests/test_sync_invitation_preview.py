"""Invitation previews reflect effective permissions and identity."""
from pathlib import Path
import tempfile
import unittest

from sync_fixtures import REPOSITORY
from neurotrace_sync.identity import Identity
from neurotrace_sync.repository_policy import RepositoryPolicy
from neurotrace_sync.store import Store, digest, SyncError


class InvitationPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / 'server.db')
        self.identity = Identity(self.store, 'key')
        credentials = self.identity.bootstrap('key', 'Network', 'Owner')
        self.owner = self.identity.authenticate(credentials['token'])
        self.project = self.identity.create_project(self.owner, 'Project', REPOSITORY)['id']
        self.policy = RepositoryPolicy(self.store, self.identity)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_device_preview_storage_and_redeem_match_owner(self):
        code = self.identity.invite(self.owner, self.project, 'viewer', 'device', 'Misleading name')['code']
        stored = self.store.one('SELECT * FROM invites WHERE hash=?', (digest(code),))
        self.assertEqual((stored['role'], stored['name']), ('owner', 'Owner'))
        preview = self.policy.preview(code, REPOSITORY)
        self.assertEqual((preview['role'], preview['kind'], preview['actor_name']), ('owner', 'device', 'Owner'))
        joined = self.identity.redeem(code, REPOSITORY)
        self.assertEqual(joined['actor_id'], self.owner['id'])

    def test_legacy_device_preview_uses_current_sponsor_role(self):
        code = self.identity.invite(self.owner, self.project, 'viewer', 'device', 'Owner')['code']
        self.store.conn.execute("UPDATE invites SET role='viewer'")
        self.assertEqual(self.policy.preview(code, REPOSITORY)['role'], 'owner')

    def test_person_preview_is_distinct_and_downgraded_sponsor_is_rejected(self):
        code = self.identity.invite(self.owner, self.project, 'admin', 'human', 'Teammate')['code']
        preview = self.policy.preview(code, REPOSITORY)
        self.assertEqual((preview['role'], preview['kind'], preview['actor_name']), ('admin', 'human', 'Teammate'))
        self.store.conn.execute("UPDATE members SET role='editor'")
        with self.assertRaises(SyncError):
            self.policy.preview(code, REPOSITORY)
