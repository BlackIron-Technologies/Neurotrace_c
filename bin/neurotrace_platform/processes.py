"""Exclusive process locks and local process identity checks."""
import json
import os
from pathlib import Path
import tempfile
import time


class ProcessLock:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.file = open(path, 'a+b')
        try:
            self.file.seek(0, os.SEEK_END)
            if self.file.tell() == 0:
                self.file.write(b'0')
                self.file.flush()
            self.file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise BlockingIOError('Another process owns ' + str(path)) from None

    def close(self):
        if self.file.closed:
            return
        self.file.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.file, fcntl.LOCK_UN)
        self.file.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def pid_alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            if not kernel.GetExitCodeProcess(wintypes.HANDLE(handle), ctypes.byref(code)):
                raise OSError(ctypes.get_last_error(), 'Cannot inspect process')
            return code.value == 259
        finally:
            kernel.CloseHandle(wintypes.HANDLE(handle))
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def wait_pid_exit(pid, timeout=20):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        handle = kernel.OpenProcess(0x100000, False, pid)
        if not handle:
            if ctypes.get_last_error() == 87:
                return
            raise OSError(ctypes.get_last_error(), 'Cannot wait for process shutdown')
        try:
            result = kernel.WaitForSingleObject(wintypes.HANDLE(handle), int(timeout * 1000))
            if result != 0:
                raise TimeoutError('Process shutdown was not confirmed')
        finally:
            kernel.CloseHandle(wintypes.HANDLE(handle))
        return
    deadline = time.monotonic() + timeout
    while pid_alive(pid) and time.monotonic() < deadline:
        time.sleep(.1)
    if pid_alive(pid):
        raise TimeoutError('Process shutdown was not confirmed')
