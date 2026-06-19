# NeuroTrace Privacy

Effective date: June 19, 2026

NeuroTrace is designed as a local-first open-source developer tool. The core workflow stores project memory on your machine and does not require a hosted account service.

## Local Data

NeuroTrace stores project memory in the workspace under `.neurotrace`.

Local data may include:

- Memories, tasks, insights, risks, and notes you save
- Code snippets or file references you choose to link
- File paths and line numbers for code-linked context
- Local graph and search metadata
- MCP setup files generated for supported agent hosts

This data remains under your control on your machine unless you explicitly copy, sync, back up, or share it.

## Local Processing

NeuroTrace's core backend runs locally. Semantic search and memory retrieval operate against the local project database. The open-source runtime does not require cloud AI processing for your saved memories.

## Encryption

When database encryption is enabled, NeuroTrace uses SQLCipher-backed local encryption. Your passphrase is not sent to a hosted NeuroTrace service. Losing the passphrase may make encrypted local data unrecoverable.

## Hosted Services

The open-source runtime model does not include hosted account services or usage analytics collection.

## Third-Party Services

NeuroTrace may interact with third-party tools only when you configure those tools or agent hosts yourself, such as VS Code, Codex, Claude, Cursor, GitHub Copilot, or other MCP clients.

## Your Responsibilities

Because NeuroTrace is local-first, you control:

- backups of `.neurotrace`
- repository sharing rules
- whether generated MCP files are committed
- whether local memory databases are encrypted
- whether workspace memory is copied to another machine or service

Review generated files before committing them to a public repository.

## Security Reports

Please report security issues through the repository's security reporting process or GitHub Issues if no private advisory channel is available:

https://github.com/BlackIron-Technologies/Neurotrace_c/issues

## Changes

This document may change as the open-source cleanup continues. The source of truth is the version committed with the code you are running.
