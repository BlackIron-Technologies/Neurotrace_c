"""Verify HTTPS from an extracted release without system certificate paths."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    args = parser.parse_args()
    url = os.environ['NEUROTRACE_TEST_TLS_URL']
    with tempfile.TemporaryDirectory(prefix='neurotrace-release-tls-') as temporary:
        root = Path(temporary)
        with zipfile.ZipFile(args.archive) as archive:
            archive.extractall(root / 'backend')
        executable = root / 'backend' / ('neurotrace.exe' if os.name == 'nt' else 'neurotrace')
        if os.name != 'nt':
            executable.chmod(0o755)
        environment = {**os.environ, 'SSL_CERT_FILE': str(root / 'missing.pem'),
                       'SSL_CERT_DIR': str(root / 'missing-roots'),
                       'NEUROTRACE_SYNC_HOME': str(root / 'sync')}
        request = {'id': 'packaged-tls', 'command': 'sync_server_info', 'payload': {'server_url': url}}
        result = subprocess.run([str(executable)], input=json.dumps(request) + '\n', env=environment,
                                capture_output=True, text=True, encoding='utf-8', timeout=45, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
        response = next(item for item in responses if item.get('id') == 'packaged-tls')
        if response.get('success'):
            assert response['data']['server_url'] == url.rstrip('/'), response
            assert isinstance(response['data']['initialized'], bool), response
            print('PASS: extracted release verifies the HTTPS sync endpoint without system certificate paths.')
            return
        # An HTTP status only arrives after the certificate chain was verified with the
        # bundled roots. CI runner IPs can be refused by the server's edge (Cloudflare
        # answers 403 / error 1010), which proves TLS but not the API, so accept it.
        # Certificate and connection failures surface as other errors and still fail.
        error = response.get('error', '')
        assert error.startswith('Python Error: RemoteError: Server rejected request (HTTP '), response
        print('PASS: TLS verified with bundled roots; the server edge refused this runner (' + error + ').')


if __name__ == '__main__':
    main()
