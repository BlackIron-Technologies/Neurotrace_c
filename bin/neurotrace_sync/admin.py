"""Offline owner recovery for the operator of a stopped sync server."""
import argparse
import json
import os
from pathlib import Path

from .identity import Identity
from .profile import normalize_url
from .store import Store, require


def recover_owner(database, output, server_url, project=None):
    store = Store(database)
    try:
        network = store.one("SELECT * FROM network")
        require(network, "Network is not initialized")
        if project:
            owner = store.one("SELECT actor FROM members WHERE project=? AND role='owner'", (project,))
            require(owner, "Project owner not found")
            actor = owner["actor"]
        else:
            actor = network["owner"]
            membership = store.one("SELECT project FROM members WHERE actor=? LIMIT 1", (actor,))
            require(membership, "Network owner has no project; recover a project owner using --project")
            project = membership["project"]
        destination = Path(output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Never overwrite an existing credential export.
        with open(destination, "x", encoding="utf-8") as handle:
            os.chmod(destination, 0o600)
            with store.transaction():
                store.conn.execute("DELETE FROM tokens WHERE actor=?", (actor,))
                token = Identity(store, None).issue_token(actor)
                json.dump({"server_url": normalize_url(server_url), "actor_id": actor, "project_id": project, "token": token}, handle)
                handle.flush()
                os.fsync(handle.fileno())
                store.log(project, actor, "owner_recovered_offline", {})
        return destination
    finally:
        store.close()


def main():
    parser = argparse.ArgumentParser(description="Recover an owner device; stop the server first")
    parser.add_argument("--database", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--server-url", required=True)
    parser.add_argument("--project")
    args = parser.parse_args()
    recover_owner(args.database, args.output, args.server_url, args.project)
    print("Recovery file created. Import it from NeuroTrace Settings on a trusted device, then delete the file.")


if __name__ == "__main__":
    main()
