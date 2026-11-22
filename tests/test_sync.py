"""Concurrency, authorization and crash recovery acceptance tests."""
import asyncio
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bin"))

from aiohttp import ClientSession, WSMsgType, web
from aiohttp.test_utils import TestServer
from sync_fixtures import REPOSITORY
from neurotrace_sync.domain import Domain
from neurotrace_sync.http_server import create_app
from neurotrace_sync.identity import Identity
from neurotrace_sync.replica import Replica
from neurotrace_sync.store import Store, SyncError
from neurotrace_sync.text import replace_text, merge_text, load_document


def local_replica(path, project):
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS thoughts(id TEXT PRIMARY KEY,timestamp TEXT,text TEXT,file_path TEXT,line INTEGER,
            type TEXT,tags TEXT,embedding BLOB,snippet TEXT,priority TEXT,status TEXT);
        CREATE TABLE IF NOT EXISTS relations(id TEXT PRIMARY KEY,src TEXT,dst TEXT,rel TEXT,meta TEXT);
    """)
    return Replica(conn, Path(path).parent, project)


class SyncAcceptance(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.database = self.directory / "server.db"
        self.server = TestServer(create_app(self.database, "test-setup-key"))
        await self.server.start_server()
        self.url = str(self.server.make_url('')).rstrip('/')
        self.session = ClientSession()
        self.replicas = []
        self.owner = await self.call("POST", "/v1/bootstrap", data={"key": "test-setup-key", "network_name": "Test network", "name": "Owner"})
        project = await self.call("POST", "/v1/projects", self.owner, {"name": "Test project", "repository": REPOSITORY})
        self.project = project["id"]

    async def asyncTearDown(self):
        await self.session.close()
        await self.server.close()
        for replica in self.replicas:
            replica.conn.close()
        self.temp.cleanup()

    async def call(self, method, path, identity=None, data=None, expected=200):
        headers = {"X-NeuroTrace-Repository": REPOSITORY["id"]}
        if identity:
            headers["Authorization"] = "Bearer " + identity["token"]
        if path == "/v1/join" and data is not None:
            data = {**data, "repository": REPOSITORY}
        async with self.session.request(method, self.url + path, json=data, headers=headers) as response:
            body = await response.json()
            self.assertEqual(response.status, expected, body)
            return body

    def route(self, suffix):
        return "/v1/projects/" + self.project + "/" + suffix

    async def member(self, role="editor", kind="human", name="Member"):
        invitation = await self.call("POST", self.route("invite"), self.owner, {"role": role, "kind": kind, "name": name})
        return await self.call("POST", "/v1/join", data={"code": invitation["code"]})

    async def replica(self, identity=None):
        replica = local_replica(self.directory / (str(uuid.uuid4()) + ".db"), self.project)
        self.replicas.append(replica)
        replica.initialize(await self.call("GET", self.route("snapshot"), identity or self.owner))
        return replica

    async def flush(self, replica, identity=None):
        identity = identity or self.owner
        for row in replica.pending():
            await self.call("POST", self.route("operations"), identity, json.loads(row["operation"]))
        await self.pull(replica, identity)

    async def pull(self, replica, identity=None):
        while True:
            page = await self.call("GET", self.route("changes?after=" + str(replica.cursor())), identity or self.owner)
            replica.apply_page(page)
            if not page["has_more"]:
                break

    async def seed(self):
        replica = await self.replica()
        row = replica.create("Inicio 😀 final", type="task", status="open", tags="base")
        await self.flush(replica)
        return replica, row["id"]

    async def test_three_offline_writers_converge_unicode_and_metadata(self):
        first, record = await self.seed()
        editor, agent = await self.member(name="Editor"), await self.member(kind="agent", name="Agent")
        second, third = await self.replica(editor), await self.replica(agent)
        first.enqueue(record, "edit", {"tags": "owner"}, "Inicio 😀 humano final")
        second.enqueue(record, "edit", {"priority": "High"}, "Inicio 😀 final equipo")
        third.enqueue(record, "edit", {"status": "in-progress"}, "Agente Inicio 😀 final")
        await asyncio.gather(self.flush(first), self.flush(second, editor), self.flush(third, agent))
        for replica, identity in ((first, self.owner), (second, editor), (third, agent)):
            await self.pull(replica, identity)
        texts = [r.conn.execute("SELECT text FROM thoughts WHERE id=?", (record,)).fetchone()[0] for r in (first, second, third)]
        self.assertEqual(len(set(texts)), 1)
        self.assertTrue(all(word in texts[0] for word in ("humano", "equipo", "Agente", "😀")), texts)
        row = dict(first.conn.execute("SELECT * FROM thoughts WHERE id=?", (record,)).fetchone())
        self.assertEqual((row["tags"], row["priority"], row["status"]), ("owner", "High", "in-progress"))

    async def test_stale_editor_base_preserves_changes_received_while_typing(self):
        first, record = await self.seed()
        second = await self.replica()
        old_text = second.conn.execute("SELECT text FROM thoughts WHERE id=?", (record,)).fetchone()[0]
        first.enqueue(record, "edit", {}, old_text + " remoto")
        await self.flush(first)
        await self.pull(second)
        second.enqueue(record, "edit", {}, "local " + old_text, base_text=old_text)
        await self.flush(second)
        await self.pull(first)
        result = first.conn.execute("SELECT text FROM thoughts WHERE id=?", (record,)).fetchone()[0]
        self.assertEqual(result, "local " + old_text + " remoto")

    async def test_deletion_wins_late_edit_keeps_recoverable_draft_and_edges(self):
        first, record = await self.seed()
        other = first.create("Target", type="note")["id"]
        first.enqueue("edge", "relation", {"src": record, "dst": other, "rel": "supports"})
        await self.flush(first)
        second = await self.replica()
        second.enqueue(record, "edit", {}, "Recovered offline draft")
        first.enqueue(record, "delete")
        await self.flush(first)
        await self.flush(second)
        self.assertIsNone(second.conn.execute("SELECT * FROM thoughts WHERE id=?", (record,)).fetchone())
        self.assertEqual(second.conn.execute("SELECT COUNT(*) FROM relations").fetchone()[0], 0)
        self.assertEqual(second.counts().get("recovered"), 1)
        self.assertIn("text_update", second.conn.execute("SELECT operation FROM sync_outbox WHERE state='recovered'").fetchone()[0])

    async def test_dedup_survives_lost_ack_and_forbids_actor_replay(self):
        replica, record = await self.seed()
        replica.enqueue(record, "edit", {"tags": "exactly-once"})
        operation = json.loads(replica.pending()[0]["operation"])
        first = await self.call("POST", self.route("operations"), self.owner, operation)
        again = await self.call("POST", self.route("operations"), self.owner, operation)
        self.assertEqual(first, again)
        editor = await self.member()
        await self.call("POST", self.route("operations"), editor, operation, expected=409)
        operation["fields"]["tags"] = "other"
        await self.call("POST", self.route("operations"), self.owner, operation, expected=409)

    async def test_permissions_revocation_sponsor_and_owner_invariants(self):
        replica, record = await self.seed()
        viewer = await self.member("viewer", name="Reader")
        operation = {"op_id": "no-write", "id": record, "action": "delete"}
        await self.call("POST", self.route("operations"), viewer, operation, expected=403)
        await self.call("GET", self.route("snapshot"), expected=401)
        agent = await self.member(kind="agent", name="Bot")
        await self.call("POST", self.route("invite"), agent, {"role": "editor", "kind": "human", "name": "Invalid"}, expected=403)
        await self.call("POST", self.route("member"), self.owner, {"member": self.owner["actor_id"], "role": None}, expected=409)
        async with self.session.ws_connect(self.url + self.route("ws"), headers={"Authorization": "Bearer " + viewer["token"], "X-NeuroTrace-Repository": REPOSITORY["id"]}) as ws:
            self.assertEqual((await ws.receive_json())["type"], "changed")
            await self.call("POST", self.route("member"), self.owner, {"member": viewer["actor_id"], "role": None})
            message = await ws.receive(timeout=4)
            self.assertIn(message.type, (WSMsgType.CLOSE, WSMsgType.CLOSED))
        await self.call("GET", self.route("snapshot"), viewer, expected=403)
        # Transfer project ownership, then remove the agent's sponsor.
        admin = await self.member("admin", name="Next owner")
        await self.call("POST", self.route("transfer"), self.owner, {"member": admin["actor_id"]})
        await self.call("POST", self.route("member"), admin, {"member": self.owner["actor_id"], "role": None})
        await self.call("POST", self.route("operations"), agent, operation, expected=403)

    async def test_websocket_wakeup_and_cross_project_isolation(self):
        editor = await self.member()
        other = await self.call("POST", "/v1/projects", self.owner, {"name": "Private", 'repository': REPOSITORY})
        await self.call("GET", "/v1/projects/" + other["id"] + "/snapshot", editor, expected=403)
        replica = await self.replica()
        async with self.session.ws_connect(self.url + self.route("ws"), headers={"Authorization": "Bearer " + editor["token"], "X-NeuroTrace-Repository": REPOSITORY["id"]}) as ws:
            await ws.receive_json()
            row = replica.create("Broadcast", type="note")
            operation = json.loads(replica.pending()[0]["operation"])
            await self.call("POST", self.route("operations"), self.owner, operation)
            self.assertEqual((await ws.receive_json(timeout=3))["type"], "changed")
        snapshot = await self.call("GET", self.route("snapshot"), editor)
        self.assertIn(row["id"], [r["id"] for r in snapshot["records"]])

    async def test_malformed_update_rolls_back_and_invitation_is_single_use(self):
        replica, record = await self.seed()
        before = await self.call("GET", self.route("snapshot"), self.owner)
        await self.call("POST", self.route("operations"), self.owner,
                        {"op_id": "bad-update", "id": record, "action": "edit", "text_update": "invalid"}, expected=400)
        after = await self.call("GET", self.route("snapshot"), self.owner)
        self.assertEqual(before, after)
        invitation = await self.call("POST", self.route("invite"), self.owner, {"role": "viewer", "kind": "human", "name": "Once"})
        await self.call("POST", "/v1/join", data={"code": invitation["code"]})
        await self.call("POST", "/v1/join", data={"code": invitation["code"]}, expected=403)

    async def test_local_mutation_and_outbox_rollback_together(self):
        replica = await self.replica()
        replica.conn.execute("CREATE TRIGGER reject_test BEFORE INSERT ON thoughts BEGIN SELECT RAISE(ABORT,'disk test'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            replica.create("Must not survive half-written", type="note")
        self.assertEqual(replica.conn.execute("SELECT COUNT(*) FROM sync_outbox").fetchone()[0], 0)
        self.assertEqual(replica.conn.execute("SELECT COUNT(*) FROM sync_documents").fetchone()[0], 0)

    async def test_local_outbox_survives_restart_and_paths_are_relative(self):
        replica = await self.replica()
        row = replica.create("Persistent", type="note", file_path=str(self.directory / "src" / "index.ts"))
        self.assertEqual(json.loads(replica.pending()[0]["operation"])["fields"]["file_path"], "src/index.ts")
        path = replica.conn.execute("PRAGMA database_list").fetchone()[2]
        replica.conn.close()
        self.replicas.remove(replica)
        replica = local_replica(path, self.project)
        self.replicas.append(replica)
        self.assertEqual(len(replica.pending()), 1)
        await self.flush(replica)
        self.assertEqual(replica.counts().get("delivered"), 1)

    async def test_live_text_can_be_temporarily_empty(self):
        replica, record = await self.seed()
        _, update, _ = replace_text(replica.document(record), "")
        replica.enqueue_update(record, update)
        await self.flush(replica)
        self.assertEqual(replica.conn.execute("SELECT text FROM thoughts WHERE id=?", (record,)).fetchone()[0], "")

    async def test_existing_local_memories_are_backed_up_and_same_id_versions_preserved(self):
        first, record = await self.seed()
        reusable = first.create('Same on both machines', type='note')['id']
        await self.flush(first)
        second = local_replica(self.directory / 'preexisting.db', self.project)
        self.replicas.append(second)
        rows = [dict(row) for row in first.conn.execute('SELECT * FROM thoughts')]
        for row in rows:
            if row['id'] == record:
                row['text'] = 'Local work on another machine'
            columns = [key for key in row if key != 'embedding']
            second.conn.execute('INSERT INTO thoughts(' + ','.join(columns) + ') VALUES(' + ','.join('?' for _ in columns) + ')', [row[key] for key in columns])
        second.conn.execute('INSERT INTO relations VALUES(?,?,?,?,?)', ('local-edge', record, reusable, 'supports', None))
        second.conn.commit()
        snapshot = await self.call('GET', self.route('snapshot'), self.owner)
        with self.assertRaises(ValueError):
            second.initialize(snapshot)
        report = second.initialize(snapshot, publish=True)
        self.assertEqual(report['imported_memories'], 1)
        self.assertEqual(report['reused_memories'], 1)
        copied_id = report['preserved_versions'][0]['preserved_local_id']
        self.assertNotEqual(copied_id, record)
        self.assertEqual(second.conn.execute('SELECT src FROM relations WHERE id=?', ('local-edge',)).fetchone()[0], copied_id)
        backup = second.conn.execute('SELECT thoughts FROM sync_import_backups WHERE id=?', (report['backup_id'],)).fetchone()[0]
        self.assertIn('Local work on another machine', backup)
        await self.flush(second)
        await self.pull(first)
        values = [row[0] for row in first.conn.execute('SELECT text FROM thoughts')]
        self.assertIn('Local work on another machine', values)
        self.assertIn('Inicio 😀 final', values)

    async def test_cursor_from_future_is_not_silently_accepted(self):
        await self.call("GET", self.route("changes?after=999999"), self.owner, expected=409)

    async def test_second_process_cannot_rewind_database_with_stale_page(self):
        first, record = await self.seed()
        second = await self.replica()
        after = second.cursor()
        first.enqueue(record, 'edit', {'tags': 'older'})
        await self.flush(first)
        older = await self.call('GET', self.route('changes?after=' + str(after)), self.owner)
        first.enqueue(record, 'edit', {'tags': 'newer'})
        await self.flush(first)
        newer = await self.call('GET', self.route('changes?after=' + str(after)), self.owner)
        filename = second.conn.execute('PRAGMA database_list').fetchone()[2]
        other_connection = local_replica(filename, self.project)
        self.replicas.append(other_connection)
        second.apply_page(newer)
        other_connection.apply_page(older)
        self.assertEqual(other_connection.cursor(), newer['cursor'])
        self.assertEqual(other_connection.conn.execute('SELECT tags FROM thoughts WHERE id=?', (record,)).fetchone()[0], 'newer')

    async def test_device_receipts_are_monotonic_authenticated_and_revocable(self):
        replica, record = await self.seed()
        reader = await self.member('viewer', name='Reader device')
        head = (await self.call('GET', self.route('checkpoint'), self.owner))['head']
        await self.call('POST', self.route('ack'), reader, {'cursor': head + 1}, expected=409)
        await self.call('POST', self.route('ack'), reader, {'cursor': head, 'device': 'cannot-spoof'})
        await self.call('POST', self.route('ack'), reader, {'cursor': 0})
        checkpoint = await self.call('GET', self.route('checkpoint'), self.owner)
        self.assertEqual(len(checkpoint['peers']), 1)
        self.assertEqual(checkpoint['peers'][0]['cursor'], head)
        self.assertNotEqual(checkpoint['peers'][0]['device'], 'cannot-spoof')
        self.assertEqual(checkpoint['peers'][0]['actor'], reader['actor_id'])
        self.assertEqual((await self.call('GET', self.route('checkpoint'), reader))['peers'], [])
        await self.call('POST', self.route('member'), self.owner, {'member': reader['actor_id'], 'role': None})
        self.assertEqual((await self.call('GET', self.route('checkpoint'), self.owner))['peers'], [])


class StorageRegressions(unittest.TestCase):
    def test_offline_owner_recovery_revokes_previous_tokens(self):
        from neurotrace_sync.admin import recover_owner
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'server.db'
            store = Store(path)
            identity = Identity(store, 'setup')
            credentials = identity.bootstrap('setup', 'Network', 'Owner')
            actor = identity.authenticate(credentials['token'])
            project = identity.create_project(actor, 'Project')
            store.close()
            destination = Path(directory) / 'recovery.json'
            recover_owner(path, destination, 'https://memory.example.com')
            result = json.loads(destination.read_text())
            store = Store(path)
            identity = Identity(store, 'setup')
            with self.assertRaises(SyncError):
                identity.authenticate(credentials['token'])
            self.assertEqual(identity.role(identity.authenticate(result['token']), project['id']), 'owner')
            store.close()

    def test_workspace_reopen_preserves_manual_relations(self):
        from neurotrace_runtime.server import NeuroTraceServer
        from neurotrace_runtime.commands import execute_backend_command
        with tempfile.TemporaryDirectory() as directory:
            server = NeuroTraceServer(None)
            server.set_workspace(directory)
            server._ensure_database_ready()
            first = server.add_thought("First")["id"]
            second = server.add_thought("Second")["id"]
            server.add_relation(first, second, "supports")
            execute_backend_command(server, "set_workspace", {"workspace": directory})
            self.assertEqual(server.conn.execute("SELECT COUNT(*) FROM relations").fetchone()[0], 1)
            server.cleanup_and_exit()

    def test_unicode_text_updates_merge_without_replacing_other_inserts(self):
        state, _, _ = replace_text(None, "😀 café")
        _, first, _ = replace_text(state, "😀 café uno")
        _, second, _ = replace_text(state, "dos 😀 café")
        a, _ = merge_text(state, first)
        a, text = merge_text(a, second)
        b, _ = merge_text(state, second)
        b, other = merge_text(b, first)
        self.assertEqual(text, "dos 😀 café uno")
        self.assertEqual(text, other)


if __name__ == "__main__":
    unittest.main()
