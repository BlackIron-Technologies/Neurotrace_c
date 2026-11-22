"""Preserve command rejection errors and identify API clients to proxies."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))

from neurotrace_runtime import daemon_client
from neurotrace_sync.profile import Remote, USER_AGENT


class TransportTests(unittest.TestCase):
    def test_copied_or_outdated_mcp_endpoints_are_rejected(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as temporary:
            first, second = Path(temporary) / 'first', Path(temporary) / 'second'
            first.mkdir(); second.mkdir()
            with self.assertRaises(daemon_client.BackendCommandError):
                daemon_client._validate_endpoint_workspace({'protocol': 2, 'workspace': str(second)}, str(first))
            with self.assertRaises(daemon_client.BackendCommandError):
                daemon_client._validate_endpoint_workspace({'workspace': str(first)}, str(first))
            self.assertEqual(daemon_client._validate_endpoint_workspace({'protocol': 2, 'workspace': str(first)}, str(first))['protocol'], 2)

    def test_ipc_requires_the_callers_workspace_and_forbids_switching(self):
        from neurotrace_runtime.commands import validate_workspace_request
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as temporary:
            validate_workspace_request({'workspace': temporary, 'command': 'list'}, temporary)
            for request in [{'command': 'list'}, {'workspace': '.', 'command': 'list'}, {'workspace': temporary, 'command': 'set_workspace'}]:
                with self.assertRaises(ValueError):
                    validate_workspace_request(request, temporary)

    def test_backend_rejection_is_not_reported_as_unavailable(self):
        rejection = daemon_client.BackendCommandError('Server rejected request (HTTP 403)')
        with patch.object(daemon_client, '_ensure_standalone_daemon_running', return_value={}), \
                patch.object(daemon_client, '_send_socket_command', side_effect=rejection):
            with self.assertRaises(daemon_client.BackendCommandError) as caught:
                daemon_client._send_daemon_command('workspace', 'host', {})
            self.assertIs(caught.exception, rejection)

    def test_broken_socket_is_reported_as_unavailable(self):
        with patch.object(daemon_client, '_ensure_standalone_daemon_running', return_value={}), \
                patch.object(daemon_client, '_send_socket_command', side_effect=ConnectionRefusedError()):
            with self.assertRaises(daemon_client.DaemonUnavailableError):
                daemon_client._send_daemon_command('workspace', 'host', {})

    def test_remote_identifies_neurotrace_without_changing_credentials(self):
        opener = MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.read.return_value = json.dumps({'protocol': 1}).encode()
        with patch('neurotrace_sync.profile.build_opener', return_value=opener):
            self.assertEqual(Remote('https://memory.example.com', 'private').request('/v1/status'), {'protocol': 1})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header('User-agent'), USER_AGENT)
        self.assertEqual(request.get_header('Authorization'), 'Bearer private')
