# NeuroTrace Privacy

Effective date: November 21, 2026

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

Team synchronization is optional and disabled until you connect from Settings. You choose the server, hosted in the cloud or on hardware you control. Connecting shares the project's memories, linked snippets, relative code paths, relationships and attributed change history with that server and authorized project members. Publishing existing workspace memories requires an explicit selection.

The sync server can read shared content. HTTPS protects transport and SQLCipher can protect your local database; this is not end-to-end encryption. Your local database passphrase is never sent to the sync server. Local embeddings, indexes, daemon credentials and graph layout are not synchronized.

Device credentials live in the operating system's credential store. Workspace bindings are machine-local. Invitations are single-use and expire after one hour; device sessions expire after 90 days. Revoking access prevents future downloads and uploads, but cannot erase a copy already downloaded by another member.

The service retains project change history, deletion markers and operation receipts. It also stores per-device applied cursors, timestamps and their member identity to report delivery. A device acknowledgement does not mean a person read the memory. Hosting operators are responsible for backups, access to server storage and applicable retention obligations. A temporary Cloudflare tunnel routes test traffic through Cloudflare and stops being useful when its connector stops. No usage analytics are collected by NeuroTrace.

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
