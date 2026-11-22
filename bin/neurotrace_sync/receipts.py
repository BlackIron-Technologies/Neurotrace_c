"""Authenticated device acknowledgements of locally applied server events."""
import time

from .store import SyncError, require


class Receipts:
    def __init__(self, store, identity):
        self.store, self.identity = store, identity

    def checkpoint(self, actor, project):
        self.identity.role(actor, project)
        head = self.store.one("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project=?", (project,))["seq"]
        candidates = self.store.all("SELECT c.device,c.actor,c.cursor,c.at,a.name,a.kind,a.sponsor,t.project AS scope "
                                    "FROM client_acks c JOIN tokens t ON t.device=c.device JOIN actors a ON a.id=c.actor "
                                    "WHERE c.project=? AND t.expires>? ORDER BY c.at DESC LIMIT 1000", (project, time.time()))
        peers = []
        for peer in candidates:
            if peer['device'] == actor['device_id']:
                continue
            try:
                self.identity.role({**peer, "id": peer['actor']}, project)
            except SyncError:
                continue
            peers.append({key: peer[key] for key in ('device', 'actor', 'name', 'kind', 'cursor', 'at')})
        return {"head": head, "checked_at": time.time(), "device_id": actor['device_id'], "peers": peers}

    def acknowledge(self, actor, project, cursor):
        self.identity.role(actor, project)
        require(type(cursor) is int and cursor >= 0, "Invalid acknowledgement cursor")
        head = self.store.one("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project=?", (project,))["seq"]
        require(cursor <= head, "Cannot acknowledge events beyond the server history", 409)
        previous = self.store.one("SELECT cursor FROM client_acks WHERE project=? AND device=?", (project, actor['device_id']))
        with self.store.transaction():
            self.store.conn.execute("INSERT INTO client_acks VALUES(?,?,?,?,?) ON CONFLICT(project,device) DO UPDATE SET "
                                    "cursor=MAX(cursor,excluded.cursor),at=excluded.at", (project, actor['device_id'], actor['id'], cursor, time.time()))
        return self.checkpoint(actor, project), previous is None or cursor > previous['cursor']
