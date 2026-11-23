"""Exclusive process ownership of a central server database."""
from neurotrace_platform.processes import ProcessLock


class DatabaseLock(ProcessLock):
    def __init__(self, path):
        try:
            super().__init__(str(path) + '.lock')
        except BlockingIOError:
            raise RuntimeError('Another sync server already owns this database') from None
