"""Raw stdio encoding and standalone daemon concurrency regressions."""
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
from neurotrace_runtime import daemon_client
from neurotrace_runtime.mcp_protocol import DaemonUnavailableError

ENTRY = Path(__file__).resolve().parents[1] / 'bin/neurotrace.py'


def workspace(root):
    folder = Path(root) / '.neurotrace'
    folder.mkdir()
    conn = sqlite3.connect(folder / 'neurotrace.db')
    conn.executescript('CREATE TABLE thoughts(id TEXT PRIMARY KEY,timestamp TEXT,text TEXT,file_path TEXT,line INTEGER,type TEXT,tags TEXT,embedding BLOB,snippet TEXT,priority TEXT,status TEXT); CREATE TABLE relations(id TEXT PRIMARY KEY,src TEXT,dst TEXT,rel TEXT,meta TEXT);')
    conn.close()


class RuntimeLifecycleTests(unittest.TestCase):
    def test_upgrade_replaces_exited_legacy_daemon_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / '.neurotrace'
            directory.mkdir()
            info_path = directory / 'standalone_daemon.json'
            info_path.write_text(json.dumps({'pid': 12345, 'protocol': 1}), encoding='utf-8')
            def spawn(_args):
                info_path.write_text(json.dumps({'pid': os.getpid(), 'protocol': 2, 'workspace': str(Path(root).resolve())}), encoding='utf-8')
            with patch.object(daemon_client, 'pid_alive', side_effect=lambda pid: pid == os.getpid()), \
                 patch.object(daemon_client, '_spawn_detached_process', side_effect=spawn) as start, \
                 patch.object(daemon_client, '_send_socket_command', return_value={}):
                self.assertEqual(daemon_client._ensure_standalone_daemon_running(root)['protocol'], 2)
                start.assert_called_once()

    def test_live_legacy_daemon_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / '.neurotrace'
            directory.mkdir()
            (directory / 'standalone_daemon.json').write_text(json.dumps({'pid': os.getpid(), 'protocol': 1}), encoding='utf-8')
            with patch.object(daemon_client, '_spawn_detached_process') as start:
                with self.assertRaises(daemon_client.BackendCommandError):
                    daemon_client._ensure_standalone_daemon_running(root)
                start.assert_not_called()

    def test_version_paths_do_not_import_embedding_dependencies(self):
        for entry in (ENTRY, ENTRY.parents[1] / 'compilation/neurotrace.py'):
            result = subprocess.run([sys.executable, '-X', 'importtime', str(entry), '--version'],
                                    capture_output=True, text=True, timeout=5, check=True)
            self.assertEqual(result.stdout.strip(), '1.3.4')
            self.assertNotIn('numpy', result.stderr)
            self.assertNotIn('transformers', result.stderr)
        executable = os.environ.get('NEUROTRACE_TEST_EXECUTABLE')
        if executable:
            result = subprocess.run([executable, '--version'], capture_output=True, text=True, timeout=5, check=True)
            self.assertEqual(result.stdout.strip(), '1.3.4')

    def test_live_unresponsive_daemon_is_preserved(self):
        info = {'pid': os.getpid()}
        with patch.object(daemon_client, '_read_daemon_info', return_value=info), \
             patch.object(daemon_client, '_send_socket_command', side_effect=TimeoutError()), \
             patch.object(daemon_client, '_spawn_detached_process') as spawn, \
             patch.object(daemon_client, '_remove_daemon_info') as remove, \
             patch.object(daemon_client.time, 'monotonic', side_effect=[0, 0, 9]), \
             patch.object(daemon_client.time, 'sleep'):
            with self.assertRaisesRegex(DaemonUnavailableError, 'live process was preserved'):
                daemon_client._ensure_standalone_daemon_running(str(ENTRY.parent))
        spawn.assert_not_called()
        remove.assert_not_called()

    def test_concurrent_daemon_processes_have_one_database_owner(self):
        with tempfile.TemporaryDirectory() as root:
            workspace(root)
            processes = [subprocess.Popen([sys.executable, str(ENTRY), '--daemon', '--workspace', root],
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(4)]
            try:
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    alive = [p for p in processes if p.poll() is None]
                    if len(alive) == 1 and (Path(root) / '.neurotrace/standalone_daemon.json').exists():
                        break
                    time.sleep(.1)
                self.assertEqual(len(alive), 1)
                info = daemon_client._read_daemon_info(root)
                self.assertEqual(info['pid'], alive[0].pid)
                daemon_client._send_socket_command(info, 'check_db_status')
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=10)

    def test_raw_utf8_roundtrips_in_both_stdio_protocols(self):
        for mcp in (False, True):
            with self.subTest(mcp=mcp), tempfile.TemporaryDirectory() as root:
                workspace(root)
                env = {**os.environ, 'PYTHONUTF8': '0', 'PYTHONIOENCODING': 'cp1252',
                       'NEUROTRACE_SYNC_HOME': str(Path(root) / 'sync-home')}
                executable = os.environ.get('NEUROTRACE_TEST_EXECUTABLE')
                command = [executable] if executable else [sys.executable, str(ENTRY)]
                daemon = None
                if mcp:
                    daemon = subprocess.Popen(command + ['--daemon', '--workspace', root],
                                              env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    endpoint = Path(root) / '.neurotrace/standalone_daemon.json'
                    deadline = time.monotonic() + 30
                    while not endpoint.exists() and time.monotonic() < deadline:
                        if daemon.poll() is not None:
                            self.fail('The test daemon exited during startup')
                        time.sleep(.1)
                    self.assertTrue(endpoint.exists(), 'The test daemon did not become ready')
                command += ['--mcp', '--workspace', root] if mcp else []
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
                def call(value):
                    process.stdin.write((json.dumps(value, ensure_ascii=False) + '\n').encode('utf-8'))
                    process.stdin.flush()
                    return json.loads(process.stdout.readline())
                text = 'Español: acción, pingüino → — ⚡️ 😀 日本語'
                try:
                    if mcp:
                        response = call({'id': 1, 'method': 'tools/call', 'params': {'name': 'neurotrace_addThought', 'arguments': {'text': text, 'type': 'note'}}})
                        saved = json.loads(response['result']['content'][0]['text'])
                        response = call({'id': 2, 'method': 'tools/call', 'params': {'name': 'neurotrace_getThought', 'arguments': {'thought_id': saved['id']}}})
                        self.assertEqual(json.loads(response['result']['content'][0]['text'])['base_text'], text)
                    else:
                        call({'id': 1, 'command': 'set_workspace', 'payload': {'workspace': root}})
                        response = call({'id': 2, 'command': 'add_thought', 'payload': {'text': text, 'type': 'note'}})
                        self.assertTrue(response['success'], response)
                        self.assertEqual(response['data']['text'], text)
                        response = call({'id': 3, 'command': 'list', 'payload': {}})
                        self.assertIn(text, json.dumps(response, ensure_ascii=False))
                finally:
                    process.terminate()
                    process.wait(timeout=10)
                    process.stdin.close()
                    process.stdout.close()
                    if daemon is not None:
                        daemon.terminate()
                        daemon.wait(timeout=10)
                    endpoint = Path(root) / '.neurotrace/standalone_daemon.json'
                    if endpoint.exists():
                        info = json.loads(endpoint.read_text(encoding='utf-8'))
                        from neurotrace_platform.processes import pid_alive
                        if pid_alive(info['pid']):
                            os.kill(info['pid'], signal.SIGTERM)
                        deadline = time.monotonic() + 10
                        from neurotrace_platform.processes import ProcessLock
                        while time.monotonic() < deadline:
                            try:
                                with ProcessLock(Path(root) / '.neurotrace/daemon-owner.lock'):
                                    break
                            except BlockingIOError:
                                time.sleep(.1)
