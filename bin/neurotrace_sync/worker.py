"""Reconnectable WebSocket wakeups backed by a durable HTTP change log."""
import asyncio
import json
import threading
import time

import aiohttp

from .profile import RemoteError, USER_AGENT
from .repository import RepositoryMismatch


class SyncWorker:
    def __init__(self, server, profile, token, replica):
        self.server, self.profile, self.token, self.replica = server, profile, token, replica
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.checkpoint = None
        self.checkpoint_generation = 0
        self.state = "connecting"
        self.error = ""
        self.role = profile.get("role", "viewer")
        self.thread = threading.Thread(target=self.run, name="NeuroTraceSync", daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.wake_event.set()

    def emit(self):
        self.server.faiss_index = None
        self.server.index_to_id = []
        sink = getattr(self.server, "event_sink", None)
        if sink:
            sink({"event": "sync-changed"})

    def run(self):
        asyncio.run(self.synchronize())

    async def synchronize(self):
        delay = 1
        while not self.stop_event.is_set():
            try:
                with self.server.command_lock:
                    self.server.guard_repository()
                async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + self.token, "User-Agent": USER_AGENT,
                                                         'X-NeuroTrace-Repository': self.profile['repository']['id']},
                                                 timeout=aiohttp.ClientTimeout(total=15), trust_env=False) as session:
                    url = self.profile["server_url"] + "/v1/projects/" + self.profile["project_id"]
                    info = await self.request(session, 'GET', self.profile['server_url'] + '/v1/status')
                    if info.get('instance_id') != self.profile.get('server_instance_id') or 'repository_binding' not in info.get('capabilities', []):
                        raise RepositoryMismatch('Server identity or repository protocol changed. Reconnect to the original server.')
                    async with session.ws_connect(url + "/ws", heartbeat=15, max_msg_size=8192) as socket:
                        self.state, self.error, delay = "live", "", 1
                        with self.server.command_lock:
                            self.emit()
                        needs_pull = True
                        needs_checkpoint = False
                        last_check = 0
                        while not self.stop_event.is_set():
                            if self.wake_event.is_set() or time.monotonic() - last_check > 5:
                                self.wake_event.clear()
                                needs_pull = True
                            if needs_pull:
                                await self.pull(session, url)
                                with self.server.command_lock:
                                    cursor = self.replica.cursor()
                                checkpoint = await self.request(session, 'POST', url + '/ack', {'cursor': cursor})
                                self.set_checkpoint(checkpoint)
                                last_check = time.monotonic()
                                needs_pull = False
                            elif needs_checkpoint:
                                self.set_checkpoint(await self.request(session, 'GET', url + '/checkpoint'))
                            needs_checkpoint = False
                            with self.server.command_lock:
                                if self.stop_event.is_set():
                                    break
                                pending = self.replica.pending()
                            # Preserve local causal ordering; pull the committed event before the next write.
                            if pending:
                                operation = json.loads(pending[0]["operation"])
                                try:
                                    await self.request(session, "POST", url + "/operations", operation)
                                    needs_pull = True
                                except RemoteError as exc:
                                    if exc.status in (400, 404, 409, 413):
                                        with self.server.command_lock, self.replica.conn:
                                            self.replica.conn.execute("UPDATE sync_outbox SET state='recovered',error=? WHERE op_id=?", (str(exc), operation["op_id"]))
                                            self.replica.project_record(operation["id"])
                                            self.emit()
                                    else:
                                        raise
                                continue
                            try:
                                message = await asyncio.wait_for(socket.receive(), 0.15)
                                if message.type == aiohttp.WSMsgType.TEXT:
                                    if json.loads(message.data).get('type') == 'receipts':
                                        needs_checkpoint = True
                                    else:
                                        needs_pull = True
                                if message.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                                    raise ConnectionError("Realtime connection closed")
                            except asyncio.TimeoutError:
                                pass
            except (RepositoryMismatch, ValueError) as exc:
                self.state, self.error = 'repository_mismatch', str(exc)
                with self.server.command_lock:
                    self.emit()
                return
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError, RemoteError) as exc:
                if isinstance(exc, (RemoteError, aiohttp.WSServerHandshakeError)) and exc.status in (401, 403):
                    self.state = "access_denied"
                else:
                    self.state = 'incompatible_server' if isinstance(exc, RemoteError) and exc.status == 404 else "offline"
                self.error = str(exc)
                with self.server.command_lock:
                    if not self.stop_event.is_set():
                        self.emit()
                # An event wakes the thread promptly when pausing or closing the workspace.
                await asyncio.to_thread(self.wake_event.wait, delay)
                self.wake_event.clear()
                delay = min(delay * 2, 20)
            except Exception as exc:
                self.state, self.error = "error", type(exc).__name__ + ": " + str(exc)
                await asyncio.to_thread(self.stop_event.wait, 5)
        self.state = "paused"

    def set_checkpoint(self, checkpoint):
        with self.server.command_lock:
            previous = self.checkpoint
            self.checkpoint = checkpoint
            self.checkpoint_generation += 1
            key = lambda value: (value['head'], [(p['device'], p['cursor']) for p in value['peers']]) if value else None
            if key(previous) != key(checkpoint):
                self.emit()

    async def request(self, session, method, url, data=None):
        with self.server.command_lock:
            self.server.guard_repository()
        async with session.request(method, url, json=data, allow_redirects=False) as response:
            if response.status != 200:
                try:
                    message = (await response.json()).get("error", "Server rejected request")
                except (ValueError, aiohttp.ContentTypeError):
                    message = "Server rejected request"
                raise RemoteError(message, response.status)
            return await response.json()

    async def pull(self, session, url):
        while not self.stop_event.is_set():
            with self.server.command_lock:
                cursor = self.replica.cursor()
            page = await self.request(session, "GET", url + "/changes?after=" + str(cursor))
            with self.server.command_lock:
                if self.stop_event.is_set():
                    return
                self.server.guard_repository()
                self.role = page["role"]
                self.replica.apply_page(page)
                if page["events"]:
                    self.emit()
            if not page["has_more"]:
                return
