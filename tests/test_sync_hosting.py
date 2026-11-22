"""Public endpoint verification never manages the administrator tunnel."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
from neurotrace_sync.endpoints import PublicEndpoint
from neurotrace_sync.server_info import inspect_server


class TunnelSetupTests(unittest.TestCase):
    @patch('neurotrace_sync.server_info.Remote')
    def test_server_check_reports_existing_network_without_claiming_it(self, remote):
        remote.return_value.request.return_value = {'instance_id': 'ours', 'protocol': 1, 'initialized': True}
        self.assertEqual(inspect_server('https://memory.example.com'), {'server_url': 'https://memory.example.com', 'initialized': True})
        remote.return_value.request.assert_called_once_with('/v1/status', timeout=5)

    @patch('neurotrace_sync.server_info.Remote')
    def test_server_check_rejects_incompatible_endpoint(self, remote):
        remote.return_value.request.return_value = {'initialized': False}
        with self.assertRaisesRegex(ValueError, 'compatible'):
            inspect_server('https://memory.example.com')

    @patch('neurotrace_sync.hosting.verify')
    @patch('neurotrace_sync.server_info.Remote')
    def test_local_setup_requires_endpoint_identity_check(self, remote, verify):
        verify.side_effect = ValueError('different server')
        with self.assertRaisesRegex(ValueError, 'different server'):
            inspect_server('https://memory.example.com', local=True)
        remote.assert_not_called()

    @patch('neurotrace_sync.endpoints.Remote')
    def test_public_endpoint_must_match_this_server(self, remote):
        remote.return_value.request.side_effect = [{'instance_id': 'ours'}, {'instance_id': 'another'}]
        tunnel = PublicEndpoint()
        with self.assertRaisesRegex(ValueError, 'different server'):
            tunnel.verify('https://memory.example.com', 'http://127.0.0.1:9473')
        self.assertFalse(tunnel.verified)

    @patch('neurotrace_sync.endpoints.Remote')
    def test_matching_endpoint_is_verified(self, remote):
        remote.return_value.request.return_value = {'instance_id': 'ours'}
        result = PublicEndpoint().verify('https://memory.example.com', 'http://127.0.0.1:9473')
        self.assertTrue(result['verified'])

    @patch('subprocess.Popen')
    @patch('neurotrace_sync.endpoints.Remote')
    def test_endpoint_verification_never_starts_a_connector(self, remote, popen):
        remote.return_value.request.return_value = {'instance_id': 'ours'}
        PublicEndpoint().verify('https://memory.example.com', 'http://127.0.0.1:9473')
        popen.assert_not_called()
