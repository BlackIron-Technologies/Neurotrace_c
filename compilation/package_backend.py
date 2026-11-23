"""Build and verify platform backend release archives."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import zipfile

PLATFORMS = ('windows', 'macos', 'linux')


def verify_archive(path, version, target):
    executable = 'neurotrace.exe' if target == 'windows' else 'neurotrace'
    with zipfile.ZipFile(path) as archive:
        required = {executable, 'backend-binary-version.txt', 'THIRD_PARTY_BACKEND_NOTICES.txt', 'build-info.json'}
        if not required <= set(archive.namelist()):
            raise ValueError('Release archive is missing required files: ' + str(path))
        if archive.read('backend-binary-version.txt').decode('utf-8').strip() != version:
            raise ValueError('Release version metadata mismatch')
        info = json.loads(archive.read('build-info.json'))
        if info['version'] != version or info['platform'] != target:
            raise ValueError('Release build identity mismatch')
        if not any(name.startswith('_internal/onnx_model/') for name in archive.namelist()):
            raise ValueError('Release archive is missing the embedding model')
        if archive.testzip() is not None:
            raise ValueError('Release archive failed CRC verification')


def build_archive(directory, output, version, target):
    directory = Path(directory).resolve()
    executable = directory / ('neurotrace.exe' if target == 'windows' else 'neurotrace')
    result = subprocess.run([str(executable), '--version'], check=True, capture_output=True, text=True, timeout=10)
    if result.stdout.strip() != version:
        raise ValueError('Executable version does not match requested release')
    if not (directory / '_internal').is_dir() or not (directory / 'THIRD_PARTY_BACKEND_NOTICES.txt').is_file():
        raise ValueError('Backend dependencies or third-party notices are missing')
    (directory / 'backend-binary-version.txt').write_text(version + '\n', encoding='utf-8')
    (directory / 'build-info.json').write_text(json.dumps({'version': version, 'platform': target,
        'architecture': platform.machine(), 'commit': os.environ.get('GITHUB_SHA', '')}, indent=2), encoding='utf-8')
    (directory / 'README.txt').write_text('NeuroTrace backend ' + version + '\nPlatform: ' + target +
        '\nInstalled automatically by the NeuroTrace extension into its per-user backend directory.\n', encoding='utf-8')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    destination = output / ('neurotrace-' + target + '.zip')
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for parent, directories, files in os.walk(directory, followlinks=True):
            for name in directories + files:
                if not (Path(parent) / name).resolve().is_relative_to(directory):
                    raise ValueError('A bundled link points outside the backend distribution')
            for name in files:
                path = Path(parent) / name
                archive.write(path, path.relative_to(directory).as_posix())
    verify_archive(destination, version, target)
    print(destination)


def verify_release(directory, version):
    directory = Path(directory)
    hashes = []
    commits = set()
    for target in PLATFORMS:
        path = directory / ('neurotrace-' + target + '.zip')
        verify_archive(path, version, target)
        with zipfile.ZipFile(path) as archive:
            commits.add(json.loads(archive.read('build-info.json'))['commit'])
        with path.open('rb') as stream:
            hashes.append(hashlib.file_digest(stream, 'sha256').hexdigest() + '  ' + path.name)
    if len(commits) != 1 or not next(iter(commits)):
        raise ValueError('Platform archives were not built from one identified commit')
    (directory / 'SHA256SUMS.txt').write_text('\n'.join(hashes) + '\n', encoding='utf-8')
    print('Verified all three platform archives for ' + version)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('build', 'verify'))
    parser.add_argument('--directory', required=True)
    parser.add_argument('--output', default='releases')
    parser.add_argument('--version', required=True)
    parser.add_argument('--platform', choices=PLATFORMS)
    args = parser.parse_args()
    if args.action == 'build':
        if not args.platform:
            parser.error('--platform is required when building')
        build_archive(args.directory, args.output, args.version, args.platform)
    else:
        verify_release(args.directory, args.version)


if __name__ == '__main__':
    main()
