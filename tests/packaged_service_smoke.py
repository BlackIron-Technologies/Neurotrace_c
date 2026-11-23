"""Install and remove an isolated background server through the built backend."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
from urllib.request import Request, urlopen


def main():
    task = 'NeuroTrace background sync'
    existing = subprocess.run(['schtasks.exe', '/Query', '/TN', task], capture_output=True)
    if existing.returncode == 0:
        raise RuntimeError('An existing user service must not be changed by this acceptance test')
    executable = os.environ['NEUROTRACE_TEST_EXECUTABLE']
    with tempfile.TemporaryDirectory(prefix='neurotrace-packaged-service-') as temporary:
        process = subprocess.Popen([executable], env={**os.environ, 'NEUROTRACE_SYNC_HOME': temporary},
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        def call(command, payload=None):
            process.stdin.write((json.dumps({'id': 1, 'command': command, 'payload': payload or {}}) + '\n').encode())
            process.stdin.flush()
            response = json.loads(process.stdout.readline())
            assert response['success'], response
            return response['data']
        try:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            started = call('sync_host_start', {'port': port})
            request = Request(started['url'] + '/v1/bootstrap',
                              data=json.dumps({'key': started['setup_key'], 'network_name': 'Acceptance', 'name': 'Acceptance owner'}).encode(),
                              headers={'Content-Type': 'application/json'})
            with urlopen(request, timeout=10) as response:
                assert response.status == 200
            assert call('sync_service', {'action': 'install', 'port': port})['installed']
            assert call('sync_host_status')['running']
            assert not call('sync_service', {'action': 'uninstall'})['installed']
            assert not call('sync_host_status')['running']
            assert (Path(temporary) / 'host/server.db').exists()
            print('PASS: final executable installs, starts and removes its native service while preserving the database.')
        finally:
            try:
                if call('sync_service')['installed']:
                    call('sync_service', {'action': 'uninstall'})
                call('sync_host_stop')
            finally:
                process.terminate()
                process.wait(timeout=10)
                process.stdin.close()
                process.stdout.close()


if __name__ == '__main__':
    main()
