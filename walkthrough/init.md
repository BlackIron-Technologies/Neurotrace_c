# <img src="../media/neurotrace-icon-light.svg#gh-light-mode-only" alt="NeuroTrace logo" height="62"><img src="../media/neurotrace-icon-dark.svg#gh-dark-mode-only" alt="NeuroTrace logo" height="62"> NeuroTrace Walkthrough: Complete User Guide

Welcome to NeuroTrace — context memory for AI-assisted coding.

NeuroTrace captures decisions, insights, hypotheses, and tasks linked to your code. You and your AI agents can search, connect, and build on that context across sessions. Everything stays local, encrypted, and under your control.

This guide walks you through setup, daily use, agent workflows, and advanced features.

## Step 1: Installation and Initialization

### 1.1 Install the Extension
1. Open Visual Studio Code.
2. Go to the Extensions tab (Ctrl+Shift+X).
3. Search for "NeuroTrace" and install the extension.
4. Restart VS Code if necessary.

### 1.2 Initialize in Your Workspace
1. Open a workspace (project folder) in VS Code.
2. The NeuroTrace sidebar icon appears automatically after installation.
3. Click the "Initialize Database" button in the sidebar.
   - This creates the local `.neurotrace` folder in your workspace with the SQLite database.
   - The database starts unencrypted (state 'UNENCRYPTED').
4. You'll see a confirmation message: "NeuroTrace initialized successfully!".
5. The sidebar updates to show the initialized state.

**Note:** If no workspace is open, the backend server won't start.

## Step 2: Add Your First Thought

"Thoughts" are reasoning entries: hypotheses, decisions, insights, tasks, discards, or notes.

1. Open a code file in your editor.
2. Select a relevant code snippet (optional, but recommended).
3. Press `Alt+N` or click on + button.
4. Enter the thought text (e.g., "Tested the new model, failed due to overfitting").
5. Select the type: `hypothesis`, `decision`, `insight`, `task`, `discard`, `note`.
   - If you choose `task`, select priority: `Low`, `Moderate`, `High`.
6. Enter tags separated by commas (e.g., "llm,training").
7. Confirm. The thought is saved with reference to the file, line, and snippet.

**Free limit:** 45 thoughts per month. Premium: unlimited.

The thought appears in the sidebar, and you'll see decorations (Premium) in the code gutter if icons are enabled.

## Step 3: Manage Thoughts

### 3.1 View Thoughts in the Sidebar
- The sidebar shows a paginated list of thoughts (15 per page).
- Each thought includes: text, type, tags, date, file/line, snippet.
- Use "Load More" to see more pages.
- Filter by type: clic the filter buttons (hypothesis, etc.).
- Text search: enter terms in the search field.
- Semantic search (Premium): click the semantic search button and enter terms.

### 3.2 Edit a Thought
1. In the sidebar select "Edit Thought".
2. Modify the text or tags.
3. Confirm. The thought is updated.

### 3.3 Delete a Thought
1. Click "Delete Thought" icon or select multiple thoughts.
2. Confirm the deletion.

### 3.4 Open a Thought
- Left-click a thought to open the associated data.

### 3.5 Suggest Related Thoughts (Premium)
1. Choose a thought and click"Suggest Related".
2. You'll see similar thoughts based on semantic embeddings.

## Step 4: Security and Database Encryption

NeuroTrace uses SQLCipher to encrypt the DB locally with AES-256. Data never leaves your machine.

### 4.1 Encrypt the Database
1. In the sidebar, click the "Encrypt Database" button.
2. Read the warning: encryption is irreversible without passphrase.
3. Enter a secure passphrase (minimum 8 characters, confirm).
4. The DB is now encrypted (state 'LOCKED').

**Warning:** Lose the passphrase = lose your data. No recovery.

### 4.2 Unlock the Database
If the database is encrypted, you must unlock it once per session by entering the passphrase in the sidebar input field (max 5 attempts per hour) and clicking the "Unlock Database" button. Once unlocked, the thoughts will be displayed in the sidebar if any exist (state 'UNLOCKED').

### 4.3 Decrypt the Database
1. Click the "Decrypt Database" button in the sidebar.
2. Enter the current passphrase.
3. The DB is now unencrypted (state 'UNENCRYPTED').

**Warning:** Decrypting the database makes your data insecure.

## Step 5: Agent Workflows

NeuroTrace is built to work with AI coding agents. Through MCP-compatible tools, agents can read and write to your project memory autonomously.

### 5.1 Setup

NeuroTrace ships with a pre-configured `.github/copilot-instructions.md` that teaches agents how to use the memory system. No manual setup required — agents will automatically search for context before working and record decisions when done.

### 5.2 What Agents Can Do

With NeuroTrace tools available, agents can:

- **Search before acting** — find prior decisions, rejected approaches, and open questions before writing code.
- **Record outcomes** — save what was decided and why, so the next session has full context.
- **Build the knowledge graph** — link related thoughts with typed relations (supports, contradicts, causes, blocks, refines).
- **Discover patterns** — use semantic search and graph insights to find connections you might miss.

### 5.3 Example Prompts

Here are prompts you can use with your agent when NeuroTrace is active:

**Before starting work:**
> "Search NeuroTrace for any previous decisions about the authentication system before making changes."

> "Check if there are any open hypotheses or tasks related to the API rate limiter."

> "What did we decide about the database schema last time? Search for related thoughts."

**During work:**
> "Record this as a decision: we chose JWT over session tokens because the API is stateless. Tag it auth, architecture."

> "Save a hypothesis: the memory leak might be caused by unclosed WebSocket connections in the chat module."

> "Add a task to refactor the payment validation logic. Priority high."

**After completing work:**
> "Link the new caching decision to the previous performance insight about slow queries."

> "Mark the hypothesis about WebSocket leaks as a discard — the actual cause was the event listener not being removed."

> "Show me the graph insights for this workspace. Are there any isolated thoughts that should be connected?"

**For context recovery:**
> "I'm picking up this project after two weeks. Search NeuroTrace for recent decisions and open tasks to get me up to speed."

> "What were the last 10 thoughts recorded in this workspace? Give me a summary."

> "Find all thoughts related to 'migration' and summarize the current state."

### 5.4 Available MCP Tools

| Tool                | What it does                                             |
| ------------------- | -------------------------------------------------------- |
| `addThought`        | Create a new thought with type, tags, and code reference |
| `editThought`       | Update text or tags of an existing thought               |
| `deleteThought`     | Remove a thought permanently                             |
| `listThoughts`      | List recent thoughts with pagination                     |
| `searchThoughts`    | Keyword search across all thoughts                       |
| `semanticSearch`    | Find thoughts by meaning, not just keywords              |
| `suggestRelated`    | Discover similar thoughts using embeddings               |
| `addRelation`       | Link two thoughts with a typed relation                  |
| `deleteRelation`    | Remove a relation between thoughts                       |
| `getGraphData`      | Read the full knowledge graph (nodes + edges)            |
| `getGraphInsights`  | Get statistics and structural analysis                   |
| `getDatabaseStatus` | Check if the workspace database is ready                 |

---

## Step 6: Advanced Interface Features

### 6.1 Code Decorations
- Gutter icons: white circle for general thoughts, colored circles for tasks (green for Low priority, orange for Moderate, red for High priority).
- Show where you left thoughts.
- Toggle: Click the "Show Code Icons" checkbox in the settings Panel to enable/disable.
- Save Changes

### 6.2 Thought Graph
1. Click the "Open Graph" button in the sidebar.
2. Visualize connections between thoughts (nodes and edges: causes, blocks, contradicts).
3. Drag nodes to reorganize; layout is saved.
4. If creates links manually, right-click over the link to delete.
5. Insights: View graph statistics.

### 6.3 Export Thoughts
1. Click the "Export" button in the sidebar.
2. Filter by type, tag, date.
3. Export to Markdown (with snippets, relations).

### 6.4 Usage Management
- Check monthly limits in the sidebar (free: 45, premium: unlimited).
- Upgrade to premium for advanced features.

## Step 7: Useful Commands
- `NeuroTrace: Search`: Text search (via sidebar search field).
- `NeuroTrace: Semantic Search`: Semantic search (Premium, via sidebar button).
- `NeuroTrace: Open Graph`: Open the graph (via sidebar button).
- `NeuroTrace: Toggle Code Icons`: Enable/disable decorations (Premium, via Settings Panel).

## Troubleshooting
- If the backend fails to start: Use the command palette (`Ctrl+Shift+P`) and run "NeuroTrace: Re-download Backend" to get a fresh copy.
- Corrupt DB: Delete the `.neurotrace` folder in your workspace and reinitialize from the sidebar.

Built to remember. For support, check the README.

---
© 2025 BlackIron Technologies Ltd. All rights reserved.