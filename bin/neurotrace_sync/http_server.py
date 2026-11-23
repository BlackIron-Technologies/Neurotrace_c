"""Authenticated HTTP and WebSocket interface for a single-writer sync server."""
import asyncio
import json
import logging
import time
from collections import defaultdict, deque

from aiohttp import WSMsgType, web

from .domain import Domain
from .identity import Identity
from .store import Store, SyncError, require
from .receipts import Receipts
from .repository_policy import RepositoryPolicy
from .repository import validate_repository, RepositoryMismatch


def create_app(database, setup_key="", local_address=None):
    store = Store(database)
    if not store.one('SELECT 1 FROM network') and not setup_key:
        store.close()
        raise ValueError('Set NEUROTRACE_SYNC_SETUP_KEY before starting a new network')
    identity = Identity(store, setup_key)
    local_record = None
    domain = Domain(store, identity)
    receipts = Receipts(store, identity)
    repositories = RepositoryPolicy(store, identity)
    connections = set()
    attempts = defaultdict(deque)

    @web.middleware
    async def errors(request, handler):
        try:
            require(not request.headers.get("Origin"), "Browser origins are not accepted by this API", 403)
            if request.path in ("/v1/bootstrap", "/v1/join", "/v1/invitations/inspect"):
                now = time.monotonic()
                bucket = attempts[request.remote]
                while bucket and now - bucket[0] > 60:
                    bucket.popleft()
                require(len(bucket) < 30, "Too many authentication attempts; retry in one minute", 429)
                bucket.append(now)
            response = await handler(request)
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response
        except SyncError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)
        except RepositoryMismatch as exc:
            return web.json_response({'error': str(exc)}, status=409)
        except (ValueError, TypeError, KeyError, OverflowError) as exc:
            return web.json_response({"error": "Invalid request: " + str(exc)[:150]}, status=400)
        except web.HTTPException:
            raise
        except Exception:
            logging.exception("Sync server request failed")
            return web.json_response({"error": "Server error; no partial operation was committed"}, status=500)

    def auth(request):
        header = request.headers.get("Authorization", "")
        require(header.startswith("Bearer "), "Sign in to NeuroTrace", 401)
        return identity.authenticate(header[7:])

    async def notify(project, message_type="changed", exclude_device=None):
        for ws, token, subscription, fingerprint in tuple(connections):
            if subscription != project:
                continue
            try:
                actor = identity.authenticate(token)
                identity.role(actor, project)
                repositories.check(project, fingerprint)
                if actor['device_id'] != exclude_device:
                    await asyncio.wait_for(ws.send_json({"type": message_type}), 3)
            except (SyncError, ConnectionError, asyncio.TimeoutError):
                await ws.close(code=4003, message=b"Access changed; reconnect")

    async def status(request):
        return web.json_response({"protocol": 1, "capabilities": ["device_receipts", "repository_binding"],
                                  "instance_id": store.one("SELECT value FROM server_metadata WHERE key='instance_id'")['value'],
                                  "initialized": bool(store.one("SELECT * FROM network"))})

    async def local_stop(request):
        import hmac
        require(local_record and request.remote == '127.0.0.1' and
                hmac.compare_digest(request.headers.get('X-NeuroTrace-Control', ''), local_record['control_token']),
                'Local server control denied', 403)
        def stop_loop():
            raise web.GracefulExit()
        asyncio.get_running_loop().call_later(0.1, stop_loop)
        return web.json_response({'stopping': True})

    async def started(app):
        nonlocal local_record
        if local_address and local_address[0] == '127.0.0.1':
            from .local_server import publish
            local_record = publish(database, *local_address,
                                   store.one("SELECT value FROM server_metadata WHERE key='instance_id'")['value'])

    async def bootstrap(request):
        data = await request.json()
        return web.json_response(identity.bootstrap(data.get("key", ""), data.get("network_name", ""), data.get("name", "")))

    async def join(request):
        data = await request.json()
        return web.json_response(identity.redeem(data.get('code', ''), data.get('repository')))

    async def inspect_invitation(request):
        data = await request.json()
        return web.json_response(repositories.preview(data.get('code', ''), data.get('repository')))

    async def network(request):
        actor = auth(request)
        if request.method == "POST":
            data = await request.json()
            return web.json_response(identity.create_project(actor, data.get('name', ''), validate_repository(data.get('repository'))))
        return web.json_response(identity.network(actor))

    async def transfer_network(request):
        return web.json_response(identity.transfer_network(auth(request), (await request.json())["member"]))

    async def project_api(request):
        actor, project, action = auth(request), request.match_info["project"], request.match_info["action"]
        if request.method == 'POST' and action == 'repository':
            result = repositories.pin(actor, project, (await request.json()).get('repository'))
            await notify(project)
            return web.json_response(result)
        identity.role(actor, project)
        repositories.check(project, request.headers.get('X-NeuroTrace-Repository'))
        if request.method == "GET":
            if action == "snapshot":
                result = domain.snapshot(actor, project)
            elif action == "changes":
                result = domain.changes(actor, project, int(request.query.get("after", "0")))
            elif action == "members":
                result = {"members": identity.members(actor, project), "role": identity.role(actor, project)}
            elif action == "checkpoint":
                result = receipts.checkpoint(actor, project)
            elif action == "activity":
                identity.role(actor, project)
                result = {"events": store.all("SELECT u.id,u.action,u.detail,u.at,a.name AS actor FROM audit u JOIN actors a ON a.id=u.actor WHERE project=? ORDER BY u.id DESC LIMIT 100", (project,))}
            else:
                raise web.HTTPNotFound()
        else:
            data = await request.json()
            if action == "ack":
                result, advanced = receipts.acknowledge(actor, project, data.get('cursor'))
                if advanced:
                    await notify(project, "receipts", actor['device_id'])
                return web.json_response(result)
            if action == "operations":
                result = domain.apply(actor, project, data)
            elif action == "invite":
                result = identity.invite(actor, project, data["role"], data["kind"], data["name"])
            elif action == "member":
                result = identity.change_member(actor, project, data["member"], data.get("role"))
            elif action == "transfer":
                result = identity.transfer(actor, project, data["member"])
            else:
                raise web.HTTPNotFound()
            await notify(project)
        return web.json_response(result)

    async def websocket(request):
        actor = auth(request)
        project = request.match_info["project"]
        identity.role(actor, project)
        fingerprint = request.headers.get('X-NeuroTrace-Repository')
        repositories.check(project, fingerprint)
        require(sum(1 for _, token, _, _ in connections if token == request.headers["Authorization"][7:]) < 10,
                "Too many connections for this device", 429)
        ws = web.WebSocketResponse(heartbeat=15, max_msg_size=8192)
        await ws.prepare(request)
        connection = (ws, request.headers["Authorization"][7:], project, fingerprint)
        connections.add(connection)
        await ws.send_json({"type": "changed"})
        try:
            while not ws.closed:
                identity.role(identity.authenticate(connection[1]), project)
                repositories.check(project, fingerprint)
                try:
                    message = await ws.receive(timeout=10)
                    if message.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR):
                        break
                    if message.type == WSMsgType.TEXT and message.data == "ping":
                        await ws.send_json({"type": "pong"})
                except asyncio.TimeoutError:
                    continue
        except SyncError:
            await ws.close(code=4003, message=b"Access revoked")
        finally:
            connections.discard(connection)
        return ws

    async def cleanup(app):
        for ws, _, _, _ in tuple(connections):
            await ws.close(code=1001, message=b"Server shutdown")
        store.close()
        if local_record:
            from .local_server import forget
            forget(database)

    app = web.Application(middlewares=[errors], client_max_size=1024 * 1024)
    app.router.add_get("/v1/status", status)
    app.router.add_post("/v1/bootstrap", bootstrap)
    app.router.add_post("/v1/join", join)
    app.router.add_post('/v1/invitations/inspect', inspect_invitation)
    app.router.add_get("/v1/network", network)
    app.router.add_post("/v1/projects", network)
    app.router.add_post("/v1/network/transfer", transfer_network)
    app.router.add_get("/v1/projects/{project}/ws", websocket)
    app.router.add_route("*", "/v1/projects/{project}/{action}", project_api)
    app.router.add_post("/v1/local-stop", local_stop)
    app.on_startup.append(started)
    app.on_cleanup.append(cleanup)
    return app


def main():
    import argparse
    import os
    from pathlib import Path
    parser = argparse.ArgumentParser(description="NeuroTrace team synchronization server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9473)
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    Path(args.database).parent.mkdir(parents=True, exist_ok=True)
    # Access logs deliberately omit credentials and request bodies.
    web.run_app(create_app(args.database, os.environ.get("NEUROTRACE_SYNC_SETUP_KEY", ""), (args.host, args.port)), host=args.host,
                port=args.port, access_log=None, print=None)


if __name__ == "__main__":
    main()
