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

    def test_sync_tls_trusts_bundled_roots_without_system_paths(self):
        import ssl
        from neurotrace_sync import tls
        tls.client_context.cache_clear()
        with patch.dict('os.environ', {'SSL_CERT_FILE': '/nonexistent/cert.pem', 'SSL_CERT_DIR': '/nonexistent'}):
            context = tls.client_context()
        tls.client_context.cache_clear()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        subjects = {value for cert in context.get_ca_certs() for rdn in cert['subject'] for key, value in rdn if key == 'commonName'}
        self.assertIn('ISRG Root X1', subjects)

    def test_remote_uses_the_sync_tls_context(self):
        from urllib.request import HTTPSHandler
        from neurotrace_sync import tls
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.read.return_value = b'{}'
        with patch('neurotrace_sync.profile.build_opener', return_value=opener) as build:
            Remote('https://memory.example.com').request('/v1/status')
        handlers = [handler for handler in build.call_args.args if isinstance(handler, HTTPSHandler)]
        self.assertEqual(len(handlers), 1)
        self.assertIs(handlers[0]._context, tls.client_context())

    def _run_worker_until_connector_fails(self, failure):
        import asyncio
        import threading
        from neurotrace_sync import worker as worker_module
        server = MagicMock(command_lock=threading.Lock(), event_sink=None)
        profile = {'server_url': 'https://memory.example.com', 'project_id': 'project', 'repository': {'id': 'repository'}}
        sync = worker_module.SyncWorker(server, profile, 'token', MagicMock())

        def connector(**kwargs):
            sync.stop_event.set()
            sync.wake_event.set()
            connector.kwargs = kwargs
            raise failure

        with patch.object(worker_module.aiohttp, 'TCPConnector', side_effect=connector):
            asyncio.run(asyncio.wait_for(sync.synchronize(), 5))
        return sync, connector.kwargs

    def test_worker_uses_the_sync_tls_context(self):
        import aiohttp
        from neurotrace_sync import tls
        _, kwargs = self._run_worker_until_connector_fails(aiohttp.ClientConnectionError('offline'))
        self.assertIs(kwargs['ssl'], tls.client_context())

    def test_worker_treats_certificate_failures_as_offline_not_repository_mismatch(self):
        import ssl
        import aiohttp
        failure = aiohttp.ClientConnectorCertificateError(MagicMock(host='memory.example.com', port=443, ssl=True),
                                                          ssl.SSLCertVerificationError(1, 'certificate verify failed'))
        self.assertIsInstance(failure, ValueError)
        sync, _ = self._run_worker_until_connector_fails(failure)
        self.assertEqual(sync.state, 'paused')
        self.assertIn('certificate verify failed', sync.error)
