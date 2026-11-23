"""Exercise cross-backend hosting using the final executable."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile


def main():
    executable = os.environ['NEUROTRACE_TEST_EXECUTABLE']
    with tempfile.TemporaryDirectory(prefix='neurotrace-packaged-host-') as temporary:
        environment = {**os.environ, 'NEUROTRACE_SYNC_HOME': temporary}
        processes = []
        pid = None
        def backend():
            process = subprocess.Popen([executable], env=environment, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            processes.append(process)
            return process
        def call(process, command, payload=None):
            process.stdin.write((json.dumps({'id': 1, 'command': command, 'payload': payload or {}}) + '\n').encode())
            process.stdin.flush()
            response = json.loads(process.stdout.readline())
            assert response['success'], response
            return response['data']
        try:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            first = backend()
            started = call(first, 'sync_host_start', {'port': port})
            pid = started['pid']
            second = backend()
            assert call(second, 'sync_host_status')['pid'] == pid
            assert call(second, 'sync_host_start', {'port': port})['pid'] == pid
            assert call(second, 'sync_host_stop')['running'] is False
            pid = None
            print('PASS: final executable discovers, reuses and stops a server across backend processes.')
        finally:
            if pid:
                os.kill(pid, signal.SIGTERM)
            for process in processes:
                process.terminate()
                process.wait(timeout=10)
                process.stdin.close()
                process.stdout.close()


if __name__ == '__main__':
    main()
