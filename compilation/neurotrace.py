"""Build entry point for the shared backend implementation."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
if "--sync-server" in sys.argv:
    sys.argv.remove("--sync-server")
    from neurotrace_sync.http_server import main
    main()
    sys.exit(0)
from neurotrace_runtime.common import BACKEND_VERSION
from neurotrace_runtime.runtime import main, main_daemon, main_mcp, main_unlock

if __name__ == "__main__":
    if "--version" in sys.argv:
        print(BACKEND_VERSION)
    elif "--daemon" in sys.argv:
        main_daemon()
    elif "--unlock" in sys.argv:
        main_unlock()
    elif "--mcp" in sys.argv:
        main_mcp()
    else:
        main()
