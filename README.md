# NeuroTrace MCP

Local-first project memory for AI coding agents and developers.

<video src="https://raw.githubusercontent.com/BlackIron-Technologies/Neurotrace_c/main/media/readme_optimized.mp4" autoplay loop muted playsinline controls preload="metadata" poster="https://raw.githubusercontent.com/BlackIron-Technologies/Neurotrace_c/main/media/sidebar-screenshot.png" width="960"></video>

NeuroTrace gives coding agents a persistent, code-linked memory layer that lives with a repository instead of a single chat session. Agents can search prior decisions, retrieve file-scoped context, reuse task history, and save durable project knowledge while they work.

## Features

- Local workspace memory database
- Optional SQLCipher database encryption
- MCP tools for agent memory search, retrieval, creation, editing, and graph traversal
- Automatic setup guidance for supported agent hosts
- File-scoped memories linked to source paths and line numbers
- Interactive graph view for exploring related project context
- Offline-capable runtime with no hosted account requirement
- Optional real-time team sync with a configurable cloud or self-hosted server
- Shared text editing, project roles, agent identities and attributed activity

## Local-First Model

The open-source runtime is designed to run on the user's machine:

- Project memories are stored in the local workspace.
- The Python backend runs locally.
- Optional encryption is handled locally with SQLCipher.
- MCP setup files are generated into the workspace.
- No hosted account service is required by the open-source runtime.

Open **NeuroTrace Settings → Editor & privacy** for the privacy model.

Open **NeuroTrace Settings → Team sync** and follow the guided setup. Use a project invitation to join, or choose **Set up sharing for my team** to prepare a server and create a network. The assistant guides server verification, names, local-memory import and final confirmation. Deployment instructions are built into the panel. Tunnel creation and operation remain with the administrator. Additional projects reuse the same network, server and tunnel.


### Repository protection (1.3.3)

Shared projects are pinned to the normalized Git `origin` and workspace directory within that repository. SSH/HTTPS clone URLs are normalized; GitHub owner/repository casing is ignored. Branches, detached HEADs and linked worktrees are compatible. Forks, unrelated origins and different monorepo directories remain separate. Git and one unambiguous network origin are required for shared sync; local-only memory still works without Git.

The invitation preview displays the destination before consuming the invitation. Repository checks also run in the backend, MCP, HTTP requests and WebSocket handshakes. Changing origin blocks local shared-memory operations and queued uploads until the correct repository is restored. A database retains its repository provenance when copied. Older databases require explicit confirmation of their provenance before initial import. Legacy shared projects require their owner to select **Protect this project with this repository** once; no repository is silently assigned. Upgrade server and clients together; earlier clients cannot exchange shared data with a protected server.

This prevents accidental cross-project connections through supported clients. It does not attest checkout contents: an intentionally modified client can claim an origin. Tokens and project memberships still enforce authorization. Repository renames, mirrors and SSH host aliases may need an explicit migration; the client never guesses that they identify the same repository.

| Conflict | Current behavior |
|---|---|
| Wrong repository, fork, missing origin, wrong monorepo directory | Blocked before invitation redemption or memory exchange |
| Concurrent text edits, offline reconnect, lost acknowledgements | CRDT convergence, durable queue/cursor and operation deduplication |
| Same legacy ID with different content | Both versions retained; explicit import and backup |
| Concurrent scalar edits | Server commit order and history; conflicting human intent still needs review |
| Delete followed by a late edit | Deletion wins; late work is recoverable |
| Windows and WSL opening the same SQLite file | Windows workspaces use the native Windows backend through interop; native backends reject cross-OS database paths |
| Copied MCP endpoint metadata or a different caller directory | Absolute workspace checks on both IPC ends; global Codex launchers resolve the caller directory |
| Two processes applying responses out of order | Serialized transaction and monotonically increasing cursor |
| Branch-specific code lines or contradictory decisions | Shared intentionally across branches; automatic semantic reconciliation is not provided |
| History retention, compaction, horizontal scaling | Deferred; one server process per database, backups remain an operator responsibility |
| SQLite runtime maintenance | Before wider deployment, update bundled SQLite to 3.51.3+ or a patched release; this Windows build uses 3.49.1 |

Git references: [remote URL expansion](https://git-scm.com/docs/git-remote), [worktrees and branches](https://git-scm.com/docs/git-worktree), [GitHub repository naming](https://docs.github.com/en/rest/repos/repos).

SQLite documents a rare [WAL-reset race and fixed releases](https://sqlite.org/wal.html#walresetbug), and [locking-related corruption risks](https://sqlite.org/howtocorrupt.html). Updating the runtime is a follow-up for the next distribution build, not a claim that this race caused the recovered local corruption. Keep databases on a local filesystem and back up the central database with SQLite's backup API; synchronize operations through the server instead of copying live database files.


## Installation

### VS Code Marketplace

Install NeuroTrace from the VS Code Marketplace, then open the NeuroTrace sidebar and initialize the workspace database.

### From Source

```powershell
npm install
npm test
npm run package
```

For release packaging and backend binary builds, see [docs/RELEASE.md](docs/RELEASE.md).

## Quick Start

1. Open a repository in VS Code.
2. Open the NeuroTrace sidebar.
3. Download the platform backend if prompted.
4. Click **Initialize Database**.
5. Let NeuroTrace generate MCP setup files and host-specific guidance.
6. Start a fresh agent chat in the same repository.

Generated setup may include:

- `.neurotrace/mcp/README.md` with MCP templates
- `.neurotrace/mcp/claude/claude.mcp.json` for Claude Code
- `.cursor/rules/neurotrace.mdc` for Cursor when supported
- `.github/copilot-instructions.md` for Copilot workflows in VS Code
- Codex MCP rebinding for the active workspace

More setup detail is in [walkthrough/init.md](walkthrough/init.md).

## MCP Workflow

Typical agent flow:

1. Check that the NeuroTrace database is available.
2. Search existing memories before changing code.
3. Retrieve file-scoped context for the current module.
4. Save durable decisions, insights, tasks, risks, or root causes.
5. Link related context so future sessions can recover the reasoning.

Key MCP capabilities include:

- Create and edit structured memories
- Search by keyword or semantic meaning
- Retrieve file-scoped context
- Discover related memories and graph connections
- Check database readiness before work begins

## Repository Layout

- `src/` - VS Code extension source
- `bin/neurotrace.py` - local Python backend used by the extension
- `compilation/` - backend build, release, and model provenance tooling
- `compilation/onnx_model/` - pinned ONNX model artifacts for release builds
- `docs/` - privacy and release documentation
- `walkthrough/` - VS Code walkthrough content
- `media/` - extension icons, screenshots, and runtime graph assets

## Development

```powershell
npm install
npm run compile
npm test
```

The test command compiles TypeScript, lint-checks extension code, validates Python syntax, and smoke-tests the bundled ONNX model.

Useful release checks:

```powershell
npm audit
npm audit --omit=dev
npm run package
npx @vscode/vsce ls
.\compilation\fetch-onnx-model.ps1
```

## Model And Third-Party Notices

NeuroTrace uses the `sentence-transformers/all-MiniLM-L6-v2` ONNX model for local semantic search. The bundled model provenance is documented in [compilation/onnx_model/PROVENANCE.md](compilation/onnx_model/PROVENANCE.md), and third-party notices are tracked in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).

## Contributors

- [CastleOneX](https://github.com/CastleOneX)

## Support

- Open an issue: [GitHub Issues](https://github.com/BlackIron-Technologies/Neurotrace_c/issues)
- X: [@NeuroTraceVsc](https://x.com/NeuroTraceVsc)

## License

NeuroTrace is released under the [MIT License](LICENSE.md).
