# <img src="../media/neurotrace-icon-light.svg#gh-light-mode-only" alt="NeuroTrace logo" height="62"><img src="../media/neurotrace-icon-dark.svg#gh-dark-mode-only" alt="NeuroTrace logo" height="62"> NeuroTrace Walkthrough: Complete User Guide

Welcome to NeuroTrace! This extension helps you capture, organize, and version your reasoning process as a developer. Below, we guide you step by step from installation to advanced use of all functionalities. NeuroTrace acts as a "second brain" for your development workflow, storing thoughts locally with code references, semantic search, and more.

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

**Note:** If no workspace is open, the Python server won't start.

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

The thought appears in the sidebar, and you'll see decorations (💭 Premium) in the code gutter if icons are enabled.

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

## Step 5: Advanced Interface Features

### 5.1 Code Decorations (Premium)
- Gutter icons (💭 for general thoughts, *o* for tasks with priority).
- Show where you left thoughts.
- Toggle: Click the "Toggle Code Icons" checkbox in the Advance Panel to enable/disable.
- Save Changes

### 5.2 Thought Graph (Premium)
1. Click the "Open Graph" button in the sidebar.
2. Visualize connections between thoughts (nodes and edges: causes, blocks, contradicts).
3. Drag nodes to reorganize; layout is saved.
4. If creates links manually, right-click over the link to delete.
5. Insights: View graph statistics.

### 5.3 Export Thoughts
1. Click the "Export" button in the sidebar.
2. Filter by type, tag, date.
3. Export to Markdown (with snippets, relations).

### 5.4 Usage Management
- Check monthly limits in the sidebar (free: 45, premium: unlimited).
- Upgrade to premium for advanced features.

## Step 6: Useful Commands
- `NeuroTrace: Search`: Text search (via sidebar search field).
- `NeuroTrace: Semantic Search`: Semantic search (Premium, via sidebar button).
- `NeuroTrace: Open Graph`: Open the graph (via sidebar button).
- `NeuroTrace: Toggle Code Icons`: Enable/disable decorations (Premium, via Advanced Panel).

## Troubleshooting
- If Python server fails: Restart the extension or check Python.
- Corrupt DB: Delete `.neurotrace` and reinitialize.

Enjoy versioning your reasoning with NeuroTrace! For support, check the README.

---
© 2025 BlackIron Technologies Ltd. All rights reserved.