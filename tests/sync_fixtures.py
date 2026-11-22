"""Shared Git identities for synchronization acceptance fixtures."""
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
from neurotrace_sync.repository import repository_identity

REPOSITORY = repository_identity('https://github.com/neurotrace-tests/shared.git')


def git_workspace(directory, origin=REPOSITORY['origin']):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for args in [('init',), ('remote', 'add', 'origin', origin)]:
        subprocess.run(['git', '-C', str(directory), *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return directory
