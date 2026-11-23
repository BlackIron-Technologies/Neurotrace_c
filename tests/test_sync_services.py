"""Per-user service definitions and isolated native Windows lifecycle."""
import json
import os
from pathlib import Path
import plistlib
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from sync_fixtures import REPOSITORY
from neurotrace_sync import hosting, services
from neurotrace_sync.identity import Identity
from neurotrace_sync.service_templates import windows_task, launch_agent, systemd_unit
from neurotrace_sync.store import Store


class ServiceDefinitionTests(unittest.TestCase):
    def test_all_platform_definitions_are_user_scoped_and_restartable(self):
        root = Path('/Users/name with spaces/service')
        tree = ET.fromstring(windows_task(root / 'run.ps1', 'DOMAIN\\user'))
        ns = {'t': 'http://schemas.microsoft.com/windows/2004/02/mit/task'}
        self.assertEqual(tree.find('.//t:LogonType', ns).text, 'InteractiveToken')
        self.assertEqual(tree.find('.//t:MultipleInstancesPolicy', ns).text, 'IgnoreNew')
        self.assertEqual(tree.find('.//t:ExecutionTimeLimit', ns).text, 'PT0S')
        agent = plistlib.loads(launch_agent(root / 'run.sh', root / 'log', 'com.neurotrace.test'))
        self.assertTrue(agent['KeepAlive'])
        self.assertTrue(agent['RunAtLoad'])
        self.assertEqual(agent['ProgramArguments'], ['/bin/sh', str(root / 'run.sh')])
        unit = systemd_unit(root / '100% server.sh')
        self.assertIn('Restart=on-failure', unit)
        self.assertIn('WantedBy=default.target', unit)
        self.assertIn('100%% server.sh', unit)

    @unittest.skipUnless(sys.platform == 'win32' and os.environ.get('NEUROTRACE_TEST_SERVICES') == '1', 'Explicit native service acceptance run')
    def test_native_install_restart_reuse_and_uninstall_preserve_database(self):
        with tempfile.TemporaryDirectory(prefix='neurotrace-service-') as folder, \
             patch.dict(os.environ, {'NEUROTRACE_SYNC_HOME': folder}), \
             patch.object(services, 'TASK_NAME', 'NeuroTrace acceptance ' + Path(folder).name):
            database = hosting.database_path()
            database.parent.mkdir(parents=True)
            store = Store(database)
            Identity(store, 'key').bootstrap('key', 'Test network', 'Test owner')
            store.close()
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            executable = os.environ.get('NEUROTRACE_TEST_EXECUTABLE')
            definition = services.definition
            def launch_definition(root, command, *args):
                return definition(root, [executable] if executable else command, *args)
            launcher_patch = patch.object(services, 'definition', side_effect=launch_definition)
            launcher_patch.start()
            try:
                result = services.service_control('install', port)
                self.assertTrue(result['installed'])
                original = hosting.status()['pid']
                self.assertEqual(hosting.start(port)['pid'], original)
                self.assertEqual(services.service_control('install', port), services.service_status())
                with self.assertRaisesRegex(ValueError, 'changing its port'):
                    services.service_control('install', port + 1 if port < 65535 else port - 1)
                with self.assertRaisesRegex(ValueError, 'background service'):
                    hosting.stop()
                # Kill just this isolated server; its supervisor must replace it.
                subprocess.run(['taskkill.exe', '/PID', str(original), '/F'], check=True, capture_output=True)
                import time
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    current = hosting.status()
                    if current['running'] and current['pid'] != original:
                        break
                    time.sleep(.2)
                self.assertTrue(current['running'])
                self.assertNotEqual(current['pid'], original)
            except Exception:
                log = Path(folder) / 'service/server.log'
                print(log.read_text(encoding='utf-8', errors='replace') if log.exists() else 'No service log created')
                print(subprocess.run(['schtasks.exe', '/Query', '/TN', services.TASK_NAME, '/V', '/FO', 'LIST'], capture_output=True, text=True).stdout)
                raise
            finally:
                services.service_control('uninstall')
                launcher_patch.stop()
            self.assertFalse(hosting.status()['running'])
            self.assertTrue(database.exists())
            self.assertFalse(services.service_status()['installed'])
