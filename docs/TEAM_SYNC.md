# Team synchronization

NeuroTrace 1.3 uses one central server, an authenticated WebSocket notification channel, an immutable change log, and a SQLite/SQLCipher replica on each device. The same server runs on a cloud VM, a private server, or a personal machine behind an HTTPS tunnel. It never exposes the local MCP daemon or shares an open SQLite file over the network.

## Connect from Settings

Open **NeuroTrace Settings → Team sync**. Choose **Join a team** and paste an invitation link. Joining a populated project works from an empty workspace or through an explicit import of existing local memories. To import existing memories into a shared project, select **Publish this workspace's existing memories**. File references must be inside the workspace and travel as relative paths.

For a new server choose **Create a network**, enter your name, the network and project names, and the server setup key. The first claimant becomes both network owner and initial project owner. Subsequent projects are created under **Ownership & administration → Another shared project**. Connect each project from its own local workspace. All Git branches in a connected workspace share that same project; branches do not implicitly create separate memory graphs.

**Server → Start local server** starts a loopback-only service. Your administrator creates and runs a tunnel or reverse proxy, then gives you its public HTTPS URL. Paste that URL and verify it in the panel. NeuroTrace checks that it reaches the correct local server. NeuroTrace never creates or starts a tunnel and never needs Cloudflare credentials. A permanent team should use a stable hostname and a supervised service or Docker container. If the server is unavailable, clients retain pending edits locally.

Credentials are stored in the OS credential store, with machine-local bindings under `~/.neurotrace/sync/profiles`. They are not stored in repository settings. The standalone MCP daemon uses the same binding and OS credential store as the IDE backend. Do not copy a connected database between different projects. Open a separate workspace when choosing another network/project.

## Ownership and permissions

The **network owner** can create projects and transfer network ownership to another human identity. Network ownership alone does not grant access to projects after membership is removed. A **project owner** controls that project's team and can transfer project ownership to another human member; a project cannot be left without an owner. Hosting operators have control of the server's storage and must be trusted.

| Role | Read | Add/edit/delete memories and relations | Invite/manage members | Transfer project |
|---|---|---|---|---|
| Owner | Yes | Yes | Yes, including administrators | Yes |
| Administrator | Yes | Yes | Readers/editors/agents | No |
| Editor | Yes | Yes | No | No |
| Reader | Yes | No | No | No |

Agents have separate identities, are restricted to one project, and can only read or edit. They cannot invite, administer or own projects. Their effective authority is capped by the current permissions of their sponsor. Removing a sponsor or reducing their permissions also restricts sponsored agents.

Invitations are bearer capabilities: share them privately. They work once and expire in one hour. **Copy device invitation** pairs another machine to your existing identity rather than creating another teammate. Sessions expire after 90 days; pair the device again before expiry. Preserve access on at least one owner device, or transfer ownership before retiring it. If the last owner device is lost, the hosting operator can stop the server and run an offline recovery:

```sh
PYTHONPATH=bin python -m neurotrace_sync.admin --database /var/lib/neurotrace/server.db --server-url https://memory.example.com --output /private/owner-recovery.json
```

Use `--project PROJECT_ID` to recover that project's owner instead of the network owner. Old device tokens for the recovered identity are revoked. Restart the server, open an empty workspace, then use **Team sync → Recover an owner device → Import recovery file**. The export contains a credential: use a private directory with restrictive OS permissions, transfer it securely and delete it after import. There is no email/password account recovery service.

## Editing and concurrency

Editing a shared memory opens the live editor. Text updates use Yjs-compatible CRDT operations (Yrs through pycrdt), so concurrent changes converge without a merge dialog. Incoming edits preserve cursor positions. Local edits and outgoing operations are committed together before acknowledgement. Offline changes remain queued and are sent after reconnecting.

Structured fields use server commit order: concurrent changes to different fields combine; the last accepted write to the same field is visible. Both operations remain in attributed history. This guarantees deterministic state, not agreement between people's intentions. Opposing edits can still produce wording that needs editorial review.

Deletion wins over later edits. It does not resurrect deleted nodes; related edges are tombstoned in the same transaction. Late edits are retained as recoverable drafts. **Save pending work** exports pending/recovered operations and readable draft text. A live editor whose memory was deleted keeps its text available through **Copy my text**.

MCP text edits to a shared memory must include `base_text`, the original text the agent read, alongside `new_text`. This prevents a stale full-text edit from replacing characters received while an agent was working. Missing or unknown bases are rejected explicitly. `neurotrace_getDatabaseStatus` includes synchronization state; successful mutations are local commits and may still be waiting for server acceptance.

## Permanent deployment

Use the repository root as the build context:

```sh
export NEUROTRACE_SYNC_SETUP_KEY="$(openssl rand -hex 32)"
docker compose -f sync-server/compose.yml up -d --build
```

The setup key is required to claim an uninitialized network and is not a team login password. The compose service binds `127.0.0.1:9473`. The administrator publishes that origin through a stable Cloudflare Tunnel or an HTTPS reverse proxy with WebSocket upgrades enabled. Put the resulting HTTPS origin in Settings. NeuroTrace never creates or starts tunnels. Administrators may use temporary `trycloudflare.com` URLs for tests; permanent deployments require a stable hostname and persistent connector credentials.

The service runs as an unprivileged container user and persists its database in the `neurotrace-sync` volume. The central database uses WAL, full durability, and an exclusive process lock: run exactly one server process per database. The single writer serializes authorization checks, CRDT application, state, receipts and history in one transaction. This deliberately uses SQLite on the central host as well as at clients, avoiding an extra database service for personal/team deployments. It is not a multi-instance horizontally scaled service. All clients use the API rather than opening this file.

For a source installation:

```sh
python -m pip install -r sync-server/requirements.txt
PYTHONPATH=bin python -m neurotrace_sync.http_server --database /var/lib/neurotrace/server.db --host 127.0.0.1 --port 9473
```

Restrict server storage to its service account, protect and back up the volume, preserve the entire database including WAL when live, or stop the service before copying it. Prefer SQLite's online backup API for live backups. Restarting the service retains memberships, receipts, history and cursor order. Restore the server and client replicas consistently; restoring an old server snapshot while clients retain newer cursors requires rehydrating clients from a new workspace and preserving/exporting pending work first. History and tombstones are retained indefinitely in this version; do not manually prune synchronization tables.

## Failure recovery and Git migration

WebSocket messages only announce changes. Clients pull durable pages using a cursor and apply each page and cursor in one transaction. Reconnecting checks permissions and catches up before sending pending work. Operation IDs deduplicate retries, including when the server committed but its acknowledgement was lost. Tokens are rechecked for reads, writes and active subscriptions; revocation closes live sockets. Removing access cannot revoke data already downloaded.

Pause sync to stop exchanging data while keeping local edits. Resume to send pending work. If access is denied, contact the project owner and export pending work. Configuration and connection failures are displayed in Settings rather than silently switching servers. The server rejects redirected credentials, arbitrary browser origins, cross-project access and unknown record fields.

Before removing an existing database from Git, obtain a coherent backup, publish it once to an empty project, connect an empty workspace on the second machine and verify memories and relations. Only then remove the database from the repository's tracked paths and add it to that project's ignore rules. NeuroTrace does not rewrite a project's Git history automatically.

## Validation

```sh
npm run compile
npm run test:sync
npm test
python tests/live_sync_smoke.py --tunnel
```

The multi-client smoke test creates disposable server/client databases and three independent backend processes (owner, member and agent). It tests online edits, offline concurrent edits with Unicode, convergence and WebSocket revocation over a real Cloudflare tunnel; it does not publish your workspace memories. Set `NEUROTRACE_TEST_EXECUTABLE` to a built backend to repeat the same test against the packaged runtime.

Design references: [Yjs updates](https://docs.yjs.dev/api/document-updates), [pycrdt API](https://y-crdt.github.io/pycrdt/api_reference/), [SQLite transactions](https://www.sqlite.org/lang_transaction.html), [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Agent delivery tools in 1.3.1

Use `neurotrace_getThought` when a memory ID is known. It returns the memory, `base_text` for a safe subsequent edit and its delivery status. Mutation responses remain local-commit confirmations; `neurotrace_sync` provides an explicit server/device barrier.

- `status` reads cached sync state, queued/recovered counts, the last checked server head and the local cursor. `caught_up` is relative to that timestamp, not a promise that nobody is writing now.
- `wait` captures pending operations at invocation and waits for their confirmation, then for a fixed checkpoint. It releases the command lock while waiting so the worker can apply events. Use a bounded `timeout_ms` (maximum 30000); `wait_for_peers` optionally requires other devices to acknowledge application of that checkpoint.
- `retry` wakes the automatic worker. It does not resume a user pause, change the server or grant permissions. Unconfigured, locked, revoked and timed-out cases return explicit state.

Device receipts are tied to the credential that authenticated the request, not an actor/device supplied in a payload. Revoked or expired devices and agents without sponsor authority are excluded. These are application acknowledgements, not human read receipts. A missing receipt can mean an offline client. Older clients do not report receipts until upgraded. Server 1.3.1 is required for this protocol extension.

The live editor now distinguishes pending local changes, server confirmation and receipt by other devices. The Settings panel exposes **Check delivery**. Normal agent workflow is read → edit with base_text → continue working → wait once at a shared-work handoff, rather than polling after every write. Server configuration and membership administration are available in the panel and through the explicit administrative MCP tools below.

See [Cloud deployment and guided local hosting](CLOUD_DEPLOYMENT.md) for a complete Docker/Cloudflare deployment, persistent storage and platform build instructions.

## Almost automatic setup through MCP

When explicitly asked to host shared memory, an agent can use `neurotrace_host` with action `start` to initialize a local server. The administrator separately configures Cloudflare or another tunnel using their own tools. Then the agent calls `neurotrace_host` with action `setup`, `public_url`, optional names and an invitation role. NeuroTrace verifies the endpoint, initializes local storage if needed, claims the network, creates the project and returns a one-time invitation URL. It does not expose the bootstrap key. `host.stop` stops only the local NeuroTrace process.

`neurotrace_connect` joins another machine using that invitation URL, or claims a new cloud server using a private bootstrap-key file. `neurotrace_team` inspects members, issues invitations and performs explicitly requested role changes, removal, project creation and ownership transfer; server permissions are always enforced. These privileged tools are for user-requested setup/administration, not routine agent work. The three ordinary steps are: administrator supplies URL → agent completes NeuroTrace setup → team accepts invitations.

## A machine that already has memories

Connection never silently replaces existing work. Without explicit `publish_existing` (MCP) or Publish (panel), it stops before sharing local memories. With import enabled, it creates a logical backup in `sync_import_backups` inside the same local database, retaining SQLCipher protection. This is a logical content snapshot, not a substitute for an external database backup; embeddings are derived locally and are not copied into the snapshot.

Different IDs are imported separately. An identical same-ID memory reuses the server record. If the same ID has different content, or the server has tombstoned that ID, the local version gets a new ID and both are retained. Local relationships are remapped to the preserved local copies. Orphaned relationships are reported and remain available in the backup. The import report lists counts, preserved IDs and the backup ID. Restoring a copy of an old Git database should use this explicit import rather than replacing an open synchronized database file.
