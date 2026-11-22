"""Network ownership, project roles, invitations and device credentials."""
import hmac
import time
import json

from .store import digest, identifier, require, secret

ROLES = {"viewer": 0, "editor": 1, "admin": 2, "owner": 3}


class Identity:
    def __init__(self, store, setup_key):
        self.store = store
        self.setup_key = setup_key

    def issue_token(self, actor, project=None):
        token = secret()
        self.store.conn.execute("INSERT INTO tokens(hash,actor,project,expires,device) VALUES(?,?,?,?,?)",
                                (digest(token), actor, project, time.time() + 90 * 86400, identifier()))
        return token

    def authenticate(self, token):
        row = self.store.one("SELECT a.*,t.project AS scope,t.device AS device_id FROM tokens t JOIN actors a ON a.id=t.actor "
                             "WHERE t.hash=? AND t.expires>?", (digest(token), time.time()))
        require(row, "Session expired or revoked. Reconnect this device.", 401)
        return row

    def role(self, actor, project, minimum="viewer"):
        require(not actor["scope"] or actor["scope"] == project, "Credential is scoped to another project", 403)
        row = self.store.one("SELECT role FROM members WHERE actor=? AND project=?", (actor["id"], project))
        require(row, "You no longer have access to this project", 403)
        rank = ROLES[row["role"]]
        if actor["kind"] == "agent":
            sponsor = self.store.one("SELECT role FROM members WHERE actor=? AND project=?", (actor["sponsor"], project))
            require(sponsor, "Agent sponsor no longer has access", 403)
            rank = min(rank, ROLES[sponsor["role"]])
        require(rank >= ROLES[minimum], "This action requires " + minimum + " permission", 403)
        return row["role"] if actor["kind"] != "agent" else ("editor" if rank >= 1 else "viewer")

    def bootstrap(self, key, name, display_name):
        require(self.setup_key and hmac.compare_digest(key, self.setup_key), "Invalid setup key", 403)
        require(not self.store.one("SELECT * FROM network"), "Network already initialized", 409)
        require(isinstance(name, str) and 0 < len(name.strip()) <= 100, "Enter a network name")
        require(isinstance(display_name, str) and 0 < len(display_name.strip()) <= 100, "Enter your name")
        with self.store.transaction():
            actor = identifier()
            self.store.conn.execute("INSERT INTO actors VALUES(?,?,?,NULL)", (actor, display_name.strip(), "human"))
            self.store.conn.execute("INSERT INTO network VALUES(?,?,?)", (identifier(), name.strip(), actor))
            token = self.issue_token(actor)
        return {"token": token, "actor_id": actor}

    def network(self, actor):
        net = self.store.one("SELECT * FROM network")
        projects = self.store.all("SELECT p.*,m.role FROM projects p JOIN members m ON m.project=p.id WHERE m.actor=?", (actor["id"],))
        return {"network": {"id": net["id"], "name": net["name"], "is_owner": net["owner"] == actor["id"]},
                "actor": {k: actor[k] for k in ("id", "name", "kind")}, "projects": projects}

    def create_project(self, actor, name, repository=None):
        require(actor["kind"] == "human" and not actor["scope"], "Agents cannot create projects", 403)
        net = self.store.one("SELECT * FROM network")
        require(net["owner"] == actor["id"], "Only the network owner can create a shared project", 403)
        require(isinstance(name, str) and 0 < len(name.strip()) <= 100, "Enter a project name")
        if repository is not None:
            from .repository import validate_repository
            repository = validate_repository(repository)
        with self.store.transaction():
            project = identifier()
            self.store.conn.execute("INSERT INTO projects(id,name,repository) VALUES(?,?,?)", (project, name.strip(), json.dumps(repository) if repository else None))
            self.store.conn.execute("INSERT INTO members VALUES(?,?,?)", (project, actor["id"], "owner"))
            self.store.log(project, actor["id"], "project_created", {"name": name.strip()})
        return {"id": project, "name": name.strip(), "role": "owner"}

    def invite(self, actor, project, role, kind, name):
        current = self.role(actor, project, "viewer" if kind == "device" else "admin")
        require(actor["kind"] == "human", "Agents cannot invite members", 403)
        require(kind in ("human", "agent", "device"), "Invalid member type")
        require(role in ("viewer", "editor", "admin"), "Invalid invitation role")
        require(kind == "device" or ROLES[role] <= ROLES[current], "Cannot grant more permissions than you hold", 403)
        require(kind != "agent" or role in ("viewer", "editor"), "Agents can only read or edit")
        require(isinstance(name, str) and 0 < len(name.strip()) <= 100, "Enter a member name")
        code = secret()
        with self.store.transaction():
            self.store.conn.execute("INSERT INTO invites(hash,project,role,sponsor,kind,name,expires) VALUES(?,?,?,?,?,?,?)",
                                    (digest(code), project, role, actor["id"], kind, name.strip(), time.time() + 3600))
            self.store.log(project, actor["id"], "invitation_created", {"name": name, "role": role, "kind": kind})
        return {"code": code, "expires_in": 3600}

    def redeem(self, code, repository=None):
        with self.store.transaction():
            from .repository_policy import RepositoryPolicy
            RepositoryPolicy(self.store, self).preview(code, repository)
            invite = self.store.one("SELECT * FROM invites WHERE hash=? AND used=0 AND expires>?", (digest(code), time.time()))
            require(invite, "Invitation expired or already used", 403)
            sponsor = self.store.one("SELECT *, NULL AS scope FROM actors WHERE id=?", (invite["sponsor"],))
            self.role(sponsor, invite["project"], "viewer" if invite["kind"] == "device" else "admin")
            if invite["kind"] == "device":
                actor = sponsor["id"]
            else:
                role = self.role(sponsor, invite["project"])
                require(ROLES[role] >= ROLES[invite["role"]], "Invitation sponsor permissions changed", 403)
                actor = identifier()
                self.store.conn.execute("INSERT INTO actors VALUES(?,?,?,?)",
                                        (actor, invite["name"], invite["kind"], sponsor["id"]))
                self.store.conn.execute("INSERT INTO members VALUES(?,?,?)", (invite["project"], actor, invite["role"]))
            self.store.conn.execute("UPDATE invites SET used=1 WHERE hash=?", (digest(code),))
            token = self.issue_token(actor, invite["project"] if invite["kind"] == "agent" else None)
            self.store.log(invite["project"], actor, "device_joined" if invite["kind"] == "device" else "member_joined", {})
        return {"token": token, "project_id": invite["project"], "actor_id": actor}

    def members(self, actor, project):
        self.role(actor, project)
        return self.store.all("SELECT a.id,a.name,a.kind,a.sponsor,m.role FROM members m JOIN actors a ON a.id=m.actor WHERE m.project=?", (project,))

    def change_member(self, actor, project, target, role):
        self.role(actor, project, "admin")
        require(actor["kind"] == "human", "Agents cannot manage members", 403)
        existing = self.store.one("SELECT m.role,a.kind FROM members m JOIN actors a ON a.id=m.actor WHERE project=? AND actor=?", (project, target))
        require(existing, "Member not found", 404)
        require(existing["role"] != "owner", "Transfer ownership before removing or changing the owner", 409)
        current = self.role(actor, project)
        require(current == "owner" or existing["role"] != "admin", "Only the owner can change administrators", 403)
        require(role is None or role in ("viewer", "editor", "admin"), "Invalid role")
        require(role != "admin" or current == "owner", "Only the owner can appoint administrators", 403)
        require(existing["kind"] != "agent" or role in (None, "viewer", "editor"), "Agents cannot administer a project")
        with self.store.transaction():
            if role is None:
                self.store.conn.execute("DELETE FROM members WHERE project=? AND actor=?", (project, target))
            else:
                self.store.conn.execute("UPDATE members SET role=? WHERE project=? AND actor=?", (role, project, target))
            self.store.log(project, actor["id"], "member_changed", {"member": target, "role": role})
        return {"ok": True}

    def transfer(self, actor, project, target):
        self.role(actor, project, "owner")
        member = self.store.one("SELECT a.kind FROM actors a JOIN members m ON a.id=m.actor WHERE m.project=? AND a.id=?", (project, target))
        require(member and member["kind"] == "human" and target != actor["id"], "Choose another human member")
        with self.store.transaction():
            self.store.conn.execute("UPDATE members SET role='admin' WHERE project=? AND actor=?", (project, actor["id"]))
            self.store.conn.execute("UPDATE members SET role='owner' WHERE project=? AND actor=?", (project, target))
            self.store.log(project, actor["id"], "ownership_transferred", {"member": target})
        return {"ok": True}

    def transfer_network(self, actor, target):
        net = self.store.one("SELECT * FROM network")
        require(net["owner"] == actor["id"] and actor["kind"] == "human", "Only the network owner can transfer this network", 403)
        member = self.store.one("SELECT kind FROM actors WHERE id=?", (target,))
        require(member and member["kind"] == "human", "Choose a human member")
        with self.store.transaction():
            self.store.conn.execute("UPDATE network SET owner=?", (target,))
            self.store.log(None, actor["id"], "network_transferred", {"member": target})
        return {"ok": True}
