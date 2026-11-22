"""Exercise three real backend processes over a Cloudflare test tunnel."""
import asyncio
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bin"))
from aiohttp.test_utils import TestServer
from neurotrace_sync.http_server import create_app
from neurotrace_sync.profile import Profile

ROOT = Path(__file__).resolve().parents[1]


class Backend:
    def __init__(self, directory, home):
        self.directory, self.home = directory, home
        self.sequence = 0

    async def start(self):
        self.directory.mkdir(parents=True)
        command = [sys.executable, "-u", str(ROOT / "bin" / "neurotrace.py")]
        if os.environ.get("NEUROTRACE_TEST_EXECUTABLE"):
            command = [os.environ["NEUROTRACE_TEST_EXECUTABLE"]]
        self.process = await asyncio.create_subprocess_exec(*command, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ, "NEUROTRACE_SYNC_HOME": str(self.home)})
        await self.call("set_workspace", {"workspace": str(self.directory)})
        await self.call("init")
        return self

    async def call(self, command, payload=None):
        self.sequence += 1
        request = {"id": self.sequence, "command": command, "payload": payload or {}}
        self.process.stdin.write((json.dumps(request) + "\n").encode())
        await self.process.stdin.drain()
        while True:
            line = await asyncio.wait_for(self.process.stdout.readline(), 40)
            if not line:
                raise RuntimeError("Backend exited")
            response = json.loads(line)
            if response.get("id") == self.sequence:
                if not response["success"]:
                    raise RuntimeError(response["error"])
                return response["data"]

    async def stop(self):
        if hasattr(self, "process") and self.process.returncode is None:
            try:
                await self.call("exit")
            finally:
                self.process.terminate()
                await self.process.wait()


async def eventually(check, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = await check()
        if value:
            return value
        await asyncio.sleep(0.15)
    raise AssertionError("Clients did not converge before the deadline")


async def run():
    temporary = tempfile.TemporaryDirectory(prefix="neurotrace-sync-test-")
    directory = Path(temporary.name)
    setup_key = secrets.token_urlsafe(32)
    central = TestServer(create_app(directory / "central.db", setup_key))
    await central.start_server()
    origin = str(central.make_url('')).rstrip('/')
    tunnel = None
    clients = []
    credentials = []
    previous_home = os.environ.get("NEUROTRACE_SYNC_HOME")
    os.environ["NEUROTRACE_SYNC_HOME"] = str(directory / "profiles")
    try:
        if "--tunnel" in sys.argv:
            tunnel = await asyncio.create_subprocess_exec(shutil.which("cloudflared"), "tunnel", "--url", origin,
                "--no-autoupdate", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            while True:
                line = (await asyncio.wait_for(tunnel.stdout.readline(), 30)).decode(errors="replace")
                match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
                if match:
                    origin = match.group(0)
                    break
            # The first DNS publication can take a moment.
            await asyncio.sleep(3)
        print("Testing transport:", origin, flush=True)
        candidates = [Backend(directory / name, directory / "profiles") for name in ("owner", "editor", "agent")]
        clients = candidates
        await asyncio.gather(*(client.start() for client in clients))
        owner, editor, agent = clients
        await owner.call("sync_connect", {"server_url": origin, "mode": "create", "setup_key": setup_key,
                                          "name": "Test owner", "network_name": "Disposable test network", "project_name": "Concurrent test"})
        for client, kind in ((editor, "human"), (agent, "agent")):
            invitation = await owner.call("sync_manage", {"action": "invite", "data": {"name": "Test " + kind, "kind": kind, "role": "editor"}})
            await client.call("sync_connect", {"server_url": origin, "code": invitation["code"]})
        for client in clients:
            profile_store = Profile(client.directory)
            credentials.append((profile_store, profile_store.read()))
        memory = await owner.call("add_thought", {"text": "Inicio 😀 final", "type": "task", "status": "open"})
        record = memory["id"]

        async def all_have_record():
            rows = [await c.call("list", {"page_size": 100}) for c in clients]
            return all(any(r["id"] == record for r in result["thoughts"]) for result in rows)

        await eventually(all_have_record)
        print("Three separate databases received the initial memory via WebSocket.", flush=True)
        await asyncio.gather(*(c.call("sync_pause", {"paused": True}) for c in clients))
        await asyncio.sleep(0.3)
        base = "Inicio 😀 final"
        await asyncio.gather(owner.call("edit", {"thought_id": record, "base_text": base, "new_text": "humano " + base}),
                             editor.call("edit", {"thought_id": record, "base_text": base, "new_text": base + " equipo"}),
                             agent.call("edit", {"thought_id": record, "base_text": base, "new_text": "Inicio 😀 agente final"}))
        start = time.monotonic()
        await asyncio.gather(*(c.call("sync_pause", {"paused": False}) for c in clients))

        async def converged():
            texts = []
            for client in clients:
                result = await client.call("list", {"page_size": 100})
                texts.append(next(r["text"] for r in result["thoughts"] if r["id"] == record))
            if len(set(texts)) == 1 and all(word in texts[0] for word in ("humano", "equipo", "agente", "😀")):
                return texts[0]
            return None

        result = await eventually(converged)
        print("Offline concurrent changes converged in", round(time.monotonic() - start, 2), "seconds:", result.encode("unicode_escape").decode(), flush=True)
        barrier = await owner.call('sync', {'action': 'wait', 'thought_id': record, 'wait_for_peers': 2, 'timeout_ms': 10000})
        assert barrier['success'] and barrier['received_by_devices'] >= 2, barrier
        read = await editor.call('get_thought', {'thought_id': record})
        assert read['base_text'] == result, read
        print('Server and two other devices confirmed the shared-memory checkpoint.', flush=True)
        # Edits while all clients are connected use the same CRDT path.
        base = result
        await asyncio.gather(*(client.call("edit", {"thought_id": record, "base_text": base,
                              "new_text": base + " live" + str(index)}) for index, client in enumerate(clients)))
        async def online_converged():
            values = []
            for client in clients:
                rows = (await client.call("list", {"page_size": 100}))["thoughts"]
                values.append(next(r["text"] for r in rows if r["id"] == record))
            return len(set(values)) == 1 and all("live" + str(i) in values[0] for i in range(3))
        await eventually(online_converged)
        # Revoke the editor while its WebSocket is live.
        members = (await owner.call("sync_manage", {"action": "members"}))["members"]
        editor_id = next(m["id"] for m in members if m["name"] == "Test human")
        await owner.call("sync_manage", {"action": "member", "data": {"member": editor_id, "role": None}})
        async def revoked():
            return (await editor.call("sync_status"))["state"] == "access_denied"
        await eventually(revoked)
        print("PASS: live concurrent edits, offline convergence, durable queues and WebSocket revocation.", flush=True)
    finally:
        await asyncio.gather(*(c.stop() for c in clients), return_exceptions=True)
        if tunnel:
            tunnel.terminate()
            await tunnel.wait()
        await central.close()
        import keyring
        for profile_store, profile in credentials:
            try:
                keyring.delete_password("NeuroTrace Sync", profile_store.credential_key(profile["server_url"], profile["actor_id"]))
            except keyring.errors.PasswordDeleteError:
                pass
        if previous_home is None:
            os.environ.pop("NEUROTRACE_SYNC_HOME", None)
        else:
            os.environ["NEUROTRACE_SYNC_HOME"] = previous_home
        temporary.cleanup()


if __name__ == "__main__":
    asyncio.run(run())
