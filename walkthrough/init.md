# <img src="../media/neurotrace-icon-light.svg#gh-light-mode-only" alt="NeuroTrace logo" height="62"><img src="../media/neurotrace-icon-dark.svg#gh-dark-mode-only" alt="NeuroTrace logo" height="62"> NeuroTrace Walkthrough: Complete User Guide

Welcome to NeuroTrace, persistent project memory for AI-assisted coding.

NeuroTrace is a local-first memory system for AI coding agents and developers inside your IDE. It captures decisions, insights, hypotheses, and tasks linked directly to your code, so agents can recover project context, build on prior reasoning, and record what changed across sessions.

Everything stays local, encrypted, and under your control.

This guide walks you through first run, agent workflows, daily use, security, and troubleshooting.

## Step 1: Install and Initialize

### 1.1 Install the Extension
1. Open your IDE.
2. Go to the Extensions view.
3. Search for `NeuroTrace` and install the extension.
4. Reload the IDE window if prompted.
5. If the sidebar or agent integration does not appear immediately after first install, reload the IDE window once manually.

### 1.2 Initialize in Your Workspace
1. Open a workspace (project folder) in your IDE.
2. Open the NeuroTrace sidebar.
3. Download the platform backend if prompted.
4. Click `Initialize Database`.
   - This creates the local `.neurotrace` folder in your workspace with the workspace database.
   - The database starts unencrypted (`UNENCRYPTED`).
5. NeuroTrace prepares agent integration automatically where the host supports it:
   - In Cursor, it registers MCP support and creates `.cursor/rules/neurotrace.mdc`
   - In VS Code, it creates `.github/copilot-instructions.md` for Copilot workflows
   - For Codex, it rebinds the global MCP entry to the active workspace from the current IDE window
6. NeuroTrace also generates `.neurotrace/mcp/` with ready-to-use templates and fallback setup instructions for Codex, Cursor, Cline, and Windsurf.
7. Open `.neurotrace/mcp/README.md` only if you need client-specific details, manual setup, or troubleshooting.
8. If you use Codex and another IDE window took control, reload the IDE window for this repo and start a fresh Codex chat or session.

**Note:** If no workspace is open, the backend server will not start.

### 1.3 Sync Agent Instructions

NeuroTrace can also keep agent instruction files aligned across tools from one canonical source.

1. Open `NeuroTrace: Open Instruction Sync` or use the `Sync Instructions` action from the sidebar.
2. On first use, NeuroTrace creates a canonical instruction file at `.neurotrace/instructions/AGENTS.md`.
   - If your workspace already has an `AGENTS.md`, NeuroTrace can seed the canonical content from it.
3. Edit that canonical file directly, or switch the canonical source to another Markdown file if that better matches your workflow.
4. Add the targets you want NeuroTrace to manage, such as:
   - `AGENTS.md`
   - `CLAUDE.md`
   - `.github/copilot-instructions.md`
   - `.cursor/rules/neurotrace.mdc`
5. Click `Sync Now` to push the canonical instructions to every enabled target.

Instruction Sync is one-way: canonical file to target files. Use it when you want one approved instruction set to stay consistent across agents and clients.

## Step 2: Agent Workflows

NeuroTrace is built to work with AI coding agents. Through MCP-compatible tools and host-specific guidance, agents can read and write to your project memory as part of their normal workflow.

### 2.1 How Agent Setup Works

After initialization, agents can use NeuroTrace in three ways:

- Native IDE guidance, such as `.github/copilot-instructions.md`
- Host-integrated MCP support where available
- Generated MCP templates under `.neurotrace/mcp/` for manual or external clients

This helps agents treat NeuroTrace as part of their natural workflow: check context before working, use related knowledge while investigating, and record important outcomes afterward.

### 2.2 What Agents Can Do

With NeuroTrace tools available, agents can:

- **Search before acting**: find prior decisions, rejected approaches, and open questions before writing code
- **Record outcomes**: save what was decided and why, so the next session has full context
- **Build the knowledge graph**: link related memories with typed relations (`supports`, `contradicts`, `causes`, `blocks`, `related`)
- **Discover patterns**: use semantic search and graph insights to find connections you might miss

### 2.3 Example Prompts

Here are prompts you can use with your agent when NeuroTrace is active:

**Before starting work:**
> "Search NeuroTrace for any previous decisions about the authentication system before making changes."

> "Check if there are any open hypotheses or tasks related to the API rate limiter."

> "What did we decide about the database schema last time? Search for related memories."

**During work:**
> "Record this as a decision: we chose JWT over session tokens because the API is stateless. Tag it auth, architecture."

> "Save a hypothesis: the memory leak might be caused by unclosed WebSocket connections in the chat module."

> "Add a task to refactor the input validation logic. Priority high."

**After completing work:**
> "Link the new caching decision to the previous performance insight about slow queries."

> "Mark the hypothesis about WebSocket leaks as a discard, the actual cause was the event listener not being removed."

> "Show me the graph insights for this workspace. Are there any isolated memories that should be connected?"

**For context recovery:**
> "I'm picking up this project after two weeks. Search NeuroTrace for recent decisions and open tasks to get me up to speed."

> "What were the last 10 memories recorded in this workspace? Give me a summary."

> "Find all memories related to migration and summarize the current state."

### 2.4 Available MCP Tools

| Tool                | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| `addThought`        | Create a new memory with type, tags, and code reference |
| `editThought`       | Update text or tags of an existing memory               |
| `deleteThought`     | Remove a memory permanently                             |
| `listThoughts`      | List recent memories with pagination                    |
| `searchThoughts`    | Keyword search across stored memories                   |
| `semanticSearch`    | Find memories by meaning, not just keywords             |
| `suggestRelated`    | Discover similar memories using embeddings              |
| `addRelation`       | Link two memories with a typed relation                 |
| `deleteRelation`    | Remove a relation between memories                      |
| `getGraphData`      | Read the full knowledge graph (nodes + edges)           |
| `getGraphInsights`  | Get statistics and structural analysis                  |
| `getDatabaseStatus` | Check if the workspace database is ready                |

## Step 3: Add Your First Memory

Memories are reasoning entries: `hypothesis`, `decision`, `insight`, `task`, `discard`, or `note`.

1. Open a code file in your editor.
2. Select a relevant code snippet if you want the memory tied to a specific location.
3. Press `Alt+N` or click the `+` button.
4. Enter the memory text.
5. Select the type.
   - If you choose `task`, select priority: `Low`, `Moderate`, or `High`.
6. Enter tags separated by commas.
7. Confirm. The memory is saved with reference to the file, line, and snippet when available.

The memory appears in the sidebar, and you will see code decorations if they are enabled.

## Step 4: Manage Memories

### 4.1 View Memories in the Sidebar
- The sidebar shows recent memories for the workspace.
- Each memory includes text, type, tags, timestamp, and code reference when available.
- Use filters to narrow by type.
- Use text search for exact terms.
- Use semantic search to find related memories by meaning.
- Use the list controls to browse older results.

### 4.2 Edit a Memory
1. Select `Edit` for the memory.
2. Modify the text or tags.
3. Confirm.

### 4.3 Delete a Memory
1. Click the delete action for the memory.
2. Confirm the deletion.

### 4.4 Open a Memory
- Click a memory to open its associated file and code reference when available.

### 4.5 Suggest Related Memories
1. Choose a memory and click `Suggest Related`.
2. NeuroTrace surfaces similar memories based on semantic embeddings.

## Step 5: Security and Database Encryption

NeuroTrace uses SQLCipher to encrypt the database locally with AES-256. Data never leaves your machine unless you explicitly export or share it.

### 5.1 Encrypt the Database
1. In the sidebar, click `Encrypt Database`.
2. Read the warning: encryption is irreversible without the passphrase.
3. Enter a secure passphrase and confirm it.
4. The database becomes encrypted (`LOCKED`).

**Warning:** If you lose the passphrase, you lose access to the encrypted database.

### 5.2 Unlock the Database
If the database is encrypted, unlock it once per session from the sidebar. After unlock, the workspace state becomes `UNLOCKED` and agents can read and write again.

If an agent or MCP client reports `database_locked`, open the NeuroTrace sidebar for that workspace, unlock the database there, and retry.

### 5.3 Decrypt the Database
1. Click `Decrypt Database` in the sidebar.
2. Enter the current passphrase.
3. The database returns to `UNENCRYPTED`.

**Warning:** Decrypting the database removes at-rest protection from local storage.

## Step 6: Advanced Interface Features

### 6.1 Code Decorations
- Gutter icons show where memories were recorded.
- Task memories use priority colors.
- Use the settings panel to enable or disable code icons.

### 6.2 Memory Graph
1. Click `Open Graph` in the sidebar.
2. Visualize connections between memories and relations.
3. Drag nodes to reorganize the layout.
4. Use graph insights to spot isolated or highly connected memories.
5. Remove manual relations from the graph when needed.

### 6.3 Export
1. Click `Export` in the sidebar.
2. Filter by type, tag, or date if needed.
3. Export to Markdown with snippets and relations.

## Step 7: Useful Commands
- `NeuroTrace: Search`
- `NeuroTrace: Semantic Search`
- `NeuroTrace: Open Graph`
- `NeuroTrace: Open Instruction Sync`
- `NeuroTrace: Toggle Code Icons`
- `NeuroTrace: Re-download Backend`

## Troubleshooting
- If the sidebar or agent integration does not appear after install, reload the IDE window once.
- If the backend is unavailable or fails to start, run `NeuroTrace: Re-download Backend`.
- If the backend was re-downloaded or auto-updated, reload the IDE window before retrying.
- If an agent reports `database_locked`, unlock the database from the NeuroTrace sidebar and retry.
- If an external MCP client reports `bridge_unavailable`, open the NeuroTrace sidebar for that repo and wait for the backend to start.
- If Codex points to the wrong workspace, reload the IDE window for the repo that should control Codex and start a fresh Codex chat or session.
- If you intentionally want to reset a broken local workspace database, remove `.neurotrace/` and initialize again.

Built to remember. For support, check the README.

---
Copyright (c) 2026 BlackIron Technologies Ltd. Released under the MIT License.
