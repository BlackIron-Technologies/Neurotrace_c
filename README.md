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

## Local-First Model

The open-source runtime is designed to run on the user's machine:

- Project memories are stored in the local workspace.
- The Python backend runs locally.
- Optional encryption is handled locally with SQLCipher.
- MCP setup files are generated into the workspace.
- No hosted account service is required by the open-source runtime.

See [docs/PRIVACY.md](docs/PRIVACY.md) for the privacy model.

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
