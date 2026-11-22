"""Keep SQLite access on the filesystem's native operating system."""
import re
import sys
from pathlib import Path


def require_native_storage(path, platform=None):
    platform = platform or sys.platform
    resolved = str(Path(path).resolve()) if platform == sys.platform else str(path)
    normalized = resolved.replace('\\', '/')
    if platform == 'linux' and re.match(r'^/mnt/[a-z](?:/|$)', normalized, re.IGNORECASE):
        raise ValueError('Do not open a Windows workspace database with a Linux backend. Use the Windows MCP bridge through WSL interop.')
    if platform == 'win32' and normalized.lower().startswith(('//wsl.localhost/', '//wsl$/')):
        raise ValueError('Use a native Linux NeuroTrace backend for a Linux workspace; do not share SQLite across Windows and WSL.')
