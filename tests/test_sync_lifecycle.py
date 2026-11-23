"""Real local server discovery, restart and authenticated shutdown."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
from neurotrace_sync import hosting
from neurotrace_sync.local_server import discover
from neurotrace_sync.profile import Remote
from neurotrace_sync.store import Store


class ServerLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {'NEUROTRACE_SYNC_HOME': self.temp.name})
        self.environment.start()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]

    def tearDown(self):
        hosting.stop()
        self.environment.stop()
        self.temp.cleanup()

    def test_another_backend_discovers_reuses_verifies_and_stops(self):
        started = hosting.start(self.port)
        entry = str(Path(__file__).resolve().parents[1] / 'bin')
        script = f"import sys,json;sys.path.insert(0,{entry!r});from neurotrace_sync import hosting; print(json.dumps(hosting.start({self.port})))"
        result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=15, check=True)
        self.assertEqual(json.loads(result.stdout)['pid'], started['pid'])
        record = discover(hosting.database_path())
        with self.assertRaises(HTTPError) as denied:
            urlopen(Request(record['url'] + '/v1/local-stop', data=b'{}'), timeout=5)
        self.assertEqual(denied.exception.code, 403)
        # Initialize, then prove restart works without any bootstrap secret.
        Remote(record['url']).request('/v1/bootstrap', {'key': started['setup_key'], 'name': 'Owner', 'network_name': 'Network'})
        hosting.stop()
        env = dict(os.environ)
        env.pop('NEUROTRACE_SYNC_SETUP_KEY', None)
        process = subprocess.Popen([sys.executable, str(Path(entry) / 'neurotrace.py'), '--sync-server',
                                    '--database', str(hosting.database_path()), '--port', str(self.port)],
                                   env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            import time
            deadline = time.monotonic() + 10
            while not hosting.status()['running'] and time.monotonic() < deadline:
                time.sleep(.1)
            self.assertTrue(hosting.status()['running'])
            with self.assertRaisesRegex(Exception, 'already initialized'):
                Remote(record['url']).request('/v1/bootstrap', {'key': '', 'name': 'Other', 'network_name': 'Other'})
            hosting.stop()
            self.assertEqual(process.wait(timeout=10), 0)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)

    def test_new_network_requires_key_and_releases_database_lock(self):
        from neurotrace_sync.http_server import create_app
        path = Path(self.temp.name) / 'new.db'
        with self.assertRaisesRegex(ValueError, 'SETUP_KEY'):
            create_app(path)
        store = Store(path)
        store.close()

    def test_tampered_instance_is_never_reused(self):
        hosting.start(self.port)
        path = Path(str(hosting.database_path()) + '.info.json')
        original = path.read_text(encoding='utf-8')
        try:
            record = json.loads(original)
            record['instance_id'] = 'wrong'
            path.write_text(json.dumps(record), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'another database'):
                hosting.start(self.port)
        finally:
            path.write_text(original, encoding='utf-8')
