"""Durable server state and transaction boundaries."""
import hashlib
import json
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from .lock import DatabaseLock


def identifier():
    return str(uuid.uuid4())


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def secret():
    return secrets.token_urlsafe(32)


class SyncError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def require(condition, message, status=400):
    if not condition:
        raise SyncError(message, status)


class Store:
    def __init__(self, path):
        from .platform_storage import require_native_storage
        require_native_storage(path)
        self.lock = DatabaseLock(path)
        self.conn = sqlite3.connect(path, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=FULL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS network(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS actors(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, sponsor TEXT);
            CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, actor TEXT NOT NULL, project TEXT, expires REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS members(project TEXT NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL,
                PRIMARY KEY(project,actor));
            CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY, project TEXT, role TEXT, sponsor TEXT NOT NULL,
                kind TEXT NOT NULL, name TEXT NOT NULL, expires REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS records(project TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
                data TEXT NOT NULL, document TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project,id));
            CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
                actor TEXT NOT NULL, operation TEXT NOT NULL, record TEXT, payload TEXT NOT NULL, at REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS event_project ON events(project,seq);
            CREATE TABLE IF NOT EXISTS receipts(project TEXT NOT NULL, operation TEXT NOT NULL, actor TEXT NOT NULL,
                request_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(project,operation));
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT,
                actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS client_acks(project TEXT NOT NULL, device TEXT NOT NULL, actor TEXT NOT NULL,
                cursor INTEGER NOT NULL, at REAL NOT NULL, PRIMARY KEY(project,device));
            CREATE TABLE IF NOT EXISTS server_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        """)
        if 'device' not in {row[1] for row in self.conn.execute('PRAGMA table_info(tokens)')}:
            self.conn.execute("ALTER TABLE tokens ADD COLUMN device TEXT")
        if 'repository' not in {row[1] for row in self.conn.execute('PRAGMA table_info(projects)')}:
            self.conn.execute('ALTER TABLE projects ADD COLUMN repository TEXT')
        for row in self.all("SELECT hash FROM tokens WHERE device IS NULL"):
            self.conn.execute("UPDATE tokens SET device=? WHERE hash=?", (identifier(), row['hash']))
        self.conn.execute("INSERT OR IGNORE INTO server_metadata VALUES('instance_id',?)", (identifier(),))

    @contextmanager
    def transaction(self):
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.conn.execute("COMMIT")
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise

    def one(self, query, args=()):
        row = self.conn.execute(query, args).fetchone()
        return dict(row) if row else None

    def all(self, query, args=()):
        return [dict(r) for r in self.conn.execute(query, args)]

    def log(self, project, actor, action, detail):
        self.conn.execute("INSERT INTO audit(project,actor,action,detail,at) VALUES(?,?,?,?,?)",
                          (project, actor, action, json.dumps(detail), time.time()))

    def close(self):
        self.conn.close()
        self.lock.close()
