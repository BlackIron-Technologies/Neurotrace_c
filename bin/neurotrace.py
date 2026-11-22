"""NeuroTrace backend entry point."""
import sys

BACKEND_VERSION = "1.3.2"

if __name__ == "__main__":
    if "--version" in sys.argv:
        print(BACKEND_VERSION)
    elif "--sync-server" in sys.argv:
        sys.argv.remove("--sync-server")
        from neurotrace_sync.http_server import main
        main()
    else:
        from neurotrace_runtime.runtime import main, main_daemon, main_mcp, main_unlock
        if "--daemon" in sys.argv:
            main_daemon()
        elif "--unlock" in sys.argv:
            main_unlock()
        elif "--mcp" in sys.argv:
            main_mcp()
        else:
            main()
