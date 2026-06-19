import * as vscode from 'vscode';
import * as path from 'path';
import { NeuroTraceSidebarProvider } from './NeuroTraceSidebarProvider';
import { PythonServerManager } from './PythonServerManager';
import { GlobalUsageManager } from './GlobalUsageManager';
import { AdvancedPanel } from './AdvancedPanel';
import { ensureMcpWorkspaceFilesForInitializedWorkspace, generateMcpWorkspaceFiles } from './McpConfigManager';

const MEMORY_TYPES = ['hypothesis', 'decision', 'insight', 'task', 'risk', 'discard', 'note'] as const;
const TASK_PRIORITIES = ['Low', 'Moderate', 'High'] as const;
const TASK_STATUSES = ['open', 'in-progress', 'blocked', 'closed', 'obsolete'] as const;

type TaskPriority = typeof TASK_PRIORITIES[number];
type TaskStatus = typeof TASK_STATUSES[number];

function formatTaskStatusLabel(status: TaskStatus): string {
    if (status === 'in-progress') {
        return 'In Progress';
    }
    return status.charAt(0).toUpperCase() + status.slice(1);
}

async function promptMemoryReferenceUpdate(currentThought: any): Promise<{
    new_file_path?: string;
    new_line?: number;
    new_snippet?: string;
} | null | undefined> {
    const editor = vscode.window.activeTextEditor;
    const options: vscode.QuickPickItem[] = [
        { label: 'Keep current code reference', description: 'Preserve file, line, and snippet' },
        { label: 'Enter file path and line manually', description: 'Override code reference manually' }
    ];

    if (editor && editor.document.uri.scheme === 'file') {
        options.splice(1, 0, {
            label: 'Use current editor location and selection',
            description: 'Use the active file, cursor line, and selected snippet if available'
        });
    }

    const selection = await vscode.window.showQuickPick(options, {
        placeHolder: 'Update linked code reference',
        ignoreFocusOut: true
    });

    if (!selection) {
        return null;
    }

    if (selection.label === 'Keep current code reference') {
        return undefined;
    }

    if (selection.label === 'Use current editor location and selection' && editor) {
        return {
            new_file_path: editor.document.fileName,
            new_line: editor.selection.active.line + 1,
            new_snippet: !editor.selection.isEmpty ? editor.document.getText(editor.selection) : currentThought.snippet
        };
    }

    const newFilePath = await vscode.window.showInputBox({
        prompt: 'File path',
        value: currentThought.file_path || editor?.document.fileName || '',
        ignoreFocusOut: true
    });
    if (newFilePath === undefined) {
        return null;
    }
    if (!newFilePath.trim()) {
        vscode.window.showErrorMessage('File path cannot be empty.');
        return null;
    }

    const newLineInput = await vscode.window.showInputBox({
        prompt: 'Line number (1-based)',
        value: currentThought.line ? String(currentThought.line) : String((editor?.selection.active.line ?? 0) + 1),
        ignoreFocusOut: true,
        validateInput: value => {
            const parsed = Number.parseInt(value, 10);
            return Number.isInteger(parsed) && parsed > 0 ? null : 'Enter a positive line number.';
        }
    });
    if (newLineInput === undefined) {
        return null;
    }

    return {
        new_file_path: newFilePath.trim(),
        new_line: Number.parseInt(newLineInput, 10),
        new_snippet: currentThought.snippet
    };
}

/**
 * Initializes the NeuroTrace extension by setting up the database and sidebar
 * @param serverManager - The Python server manager instance
 * @param sidebarProvider - The sidebar provider instance
 */
export async function initCommand(
    context: vscode.ExtensionContext,
    serverManager: PythonServerManager,
    sidebarProvider: NeuroTraceSidebarProvider
) {
    console.log('NeuroTrace: Init command started');

    try {
        // Check if database already exists
        const dbStatus = await serverManager.sendCommand('check_db_status') as { status: string };

        if (dbStatus.status !== 'NO_DB') {
            vscode.window.showInformationMessage('NeuroTrace database already exists in this workspace. No initialization needed.');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Initializing NeuroTrace",
            cancellable: false
        }, () => serverManager.sendCommand('init'));

        await generateMcpWorkspaceFiles(context, { silent: true, overwrite: false });

        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const mcpGuidePath = workspacePath ? path.join(workspacePath, '.neurotrace', 'mcp', 'README.md') : null;

        const action = await vscode.window.showInformationMessage(
            'NeuroTrace initialized successfully. Next step: open .neurotrace/mcp/README.md and follow the MCP quick setup for your client.',
            'Open MCP Guide',
            'Open MCP Folder'
        );

        if (action === 'Open MCP Guide' && mcpGuidePath) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mcpGuidePath));
            await vscode.window.showTextDocument(doc);
        } else if (action === 'Open MCP Folder' && mcpGuidePath) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(mcpGuidePath));
        }

        sidebarProvider.setInitialState('UNENCRYPTED');
        sidebarProvider.refresh();
    } catch (e: any) {
        console.error('NeuroTrace initialization error:', e);
        vscode.window.showErrorMessage(`Error initializing: ${e.message}`);
    }
}

/**
 * Adds a new thought to the database with user input validation.
 * @param serverManager - The Python server manager instance
 * @param sidebarProvider - The sidebar provider instance
 * @param globalUsageManager - The global usage manager instance
 * @returns Promise<string | undefined> - The ID of the created thought or undefined if cancelled
 */
export async function addThoughtCommand(serverManager: PythonServerManager, sidebarProvider: NeuroTraceSidebarProvider, globalUsageManager: GlobalUsageManager) {
    const editor = vscode.window.activeTextEditor;
    const line = editor ? editor.selection.active.line + 1 : undefined;
    const file = editor ? editor.document.fileName : undefined;
    const snippet = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;

    const text = await vscode.window.showInputBox({ prompt: 'Enter thought text:', placeHolder: 'E.g., "Tested new model, failed due to overfitting"' });
    if (!text) { return; }

    const type = await vscode.window.showQuickPick([...MEMORY_TYPES], {
        placeHolder: 'Select thought type',
        ignoreFocusOut: true
    });
    if (!type) { return; }

    let priority: string | undefined;
    let status: TaskStatus | undefined;
    if (type === 'task') {
        priority = await vscode.window.showQuickPick([...TASK_PRIORITIES], {
            placeHolder: 'Select task priority',
            ignoreFocusOut: true
        });
        if (!priority) { return; }

        const statusChoice = await vscode.window.showQuickPick(
            TASK_STATUSES.map((taskStatus) => ({
                label: formatTaskStatusLabel(taskStatus),
                value: taskStatus
            })),
            {
                placeHolder: 'Select task status',
                ignoreFocusOut: true
            }
        );
        if (!statusChoice) { return; }
        status = statusChoice.value;
    }

    const tags = await vscode.window.showInputBox({
        prompt: 'Enter tags (comma-separated):',
        placeHolder: 'E.g., llm,training'
    });

    try {
        const response = await serverManager.sendCommand('add_thought', {
            text, file_path: file, line, type, tags, snippet, priority, status
        }) as { id: string; timestamp: string };

        await globalUsageManager.incrementCount();

        const countResponse = await serverManager.sendCommand('get_total_count') as { total: number };

        await sidebarProvider.addThought({
            id: response.id,
            timestamp: response.timestamp,
            text, file_path: file, line, type, tags, snippet, priority, status
        });

        sidebarProvider.updateTotalCount(countResponse.total);

        return response.id;
    } catch (e: any) {
        vscode.window.showErrorMessage(`Error adding thought: ${e.message || e}`);
    }
}

/**
 * Edits an existing thought in the database
 * @param serverManager - The Python server manager instance
 * @param sidebarProvider - The sidebar provider instance
 * @param id - The ID of the thought to edit
 */
export async function editThoughtCommand(serverManager: PythonServerManager, sidebarProvider: NeuroTraceSidebarProvider, id: string) {
    const currentThought = await sidebarProvider.getThoughtById(id);
    if (!currentThought) {
        vscode.window.showErrorMessage('Could not find memory to edit.');
        return;
    }

    const newText = await vscode.window.showInputBox({ prompt: 'New memory text:', value: currentThought.text, ignoreFocusOut: true });
    if (newText === undefined) { return; }
    const newTags = await vscode.window.showInputBox({ prompt: 'New tags (comma-separated):', value: currentThought.tags, ignoreFocusOut: true });
    if (newTags === undefined) { return; }

    let newPriority: TaskPriority | undefined;
    let newStatus: TaskStatus | undefined;
    if (currentThought.type === 'task') {
        const currentPriority = (currentThought.priority || 'Moderate') as TaskPriority;
        const priorityChoice = await vscode.window.showQuickPick(
            TASK_PRIORITIES.map((taskPriority) => ({
                label: taskPriority,
                description: taskPriority === currentPriority ? 'Current' : undefined,
                value: taskPriority
            })),
            {
                placeHolder: 'Select task priority',
                ignoreFocusOut: true
            }
        );
        if (!priorityChoice) { return; }
        newPriority = priorityChoice.value;

        const currentStatus = (currentThought.status || 'open') as TaskStatus;
        const statusChoice = await vscode.window.showQuickPick(
            TASK_STATUSES.map((taskStatus) => ({
                label: formatTaskStatusLabel(taskStatus),
                description: taskStatus === currentStatus ? 'Current' : undefined,
                value: taskStatus
            })),
            {
                placeHolder: 'Select task status',
                ignoreFocusOut: true
            }
        );
        if (!statusChoice) { return; }
        newStatus = statusChoice.value;
    }

    const referenceUpdate = await promptMemoryReferenceUpdate(currentThought);
    if (referenceUpdate === null) { return; }

    const payload = {
        thought_id: id,
        new_text: newText,
        new_tags: newTags,
        new_priority: newPriority,
        new_status: newStatus,
        ...referenceUpdate
    };

    const nothingChanged =
        newText === currentThought.text &&
        newTags === currentThought.tags &&
        newPriority === currentThought.priority &&
        newStatus === currentThought.status &&
        (referenceUpdate === undefined || (
            referenceUpdate.new_file_path === currentThought.file_path &&
            referenceUpdate.new_line === currentThought.line &&
            referenceUpdate.new_snippet === currentThought.snippet
        ));

    if (nothingChanged) { return; }

    try {
        const updatedThought = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Editing Memory",
            cancellable: false
        }, () => serverManager.sendCommand('edit', payload));

        if (updatedThought) {
            sidebarProvider.addThought(updatedThought);
            if (newText !== currentThought.text) {
                serverManager.sendCommand('process-one', { thought_id: (updatedThought as any).id }, false);
            }
        }
        vscode.window.showInformationMessage('Memory updated!');
    } catch (e: any) {
        vscode.window.showErrorMessage(`Error editing memory: ${e.message}`);
    }
}

export async function showMemoriesForCurrentFileCommand(serverManager: PythonServerManager, sidebarProvider: NeuroTraceSidebarProvider) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
        vscode.window.showInformationMessage('Open a file in the editor first.');
        return;
    }

    try {
        await vscode.commands.executeCommand('workbench.view.extension.neurotrace-sidebar-container');
        sidebarProvider._view?.show?.(true);
        await sidebarProvider.showMemoriesForFile(editor.document.fileName);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Error loading memories for current file: ${e.message || e}`);
    }
}

/**
 * Deletes a thought from the database
 * @param serverManager - The Python server manager instance
 * @param sidebarProvider - The sidebar provider instance
 * @param id - The ID of the thought to delete
 * @param globalGraphPanel - Optional graph panel to refresh after deletion
 */
export async function deleteThoughtCommand(serverManager: PythonServerManager, sidebarProvider: NeuroTraceSidebarProvider, id: string, globalGraphPanel?: any) {
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Deleting Thought",
            cancellable: false
        }, () => serverManager.sendCommand('delete', { thought_id: id }));

        sidebarProvider.deleteThought(id);

        if (globalGraphPanel) {
            globalGraphPanel.forceRefresh();
        }

        vscode.window.showInformationMessage('Thought deleted!');
    } catch (e: any) {
        vscode.window.showErrorMessage(`Error deleting thought: ${e.message}`);
    }
}

/**
 * Suggests related thoughts using AI
 * @param serverManager - The Python server manager instance
 * @param sidebarProvider - The sidebar provider instance
 * @param id - The ID of the thought to find related thoughts for
 * @param globalUsageManager - The global usage manager instance
 */
export async function suggestRelatedCommand(
    serverManager: PythonServerManager,
    sidebarProvider: NeuroTraceSidebarProvider,
    id: string
) {
    try {
        const originalThought = await sidebarProvider.getThoughtById(id);
        const thoughtPreview = originalThought?.text
            ? originalThought.text.substring(0, 30) + (originalThought.text.length > 30 ? '...' : '')
            : id;

        const results = await serverManager.sendCommand('suggest', { thought_id: id });
        if (results && Array.isArray(results) && results.length > 0) {
            sidebarProvider.showSearchResults(results, `Related to: "${thoughtPreview}"`, true);
        } else {
            vscode.window.showInformationMessage('No related thoughts found');
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Error suggesting related thoughts: ${errorMessage}`);
    }
}

/**
 * Opens and focuses a thought in the sidebar view
 * @param sidebarProvider - The sidebar provider instance
 * @param thoughtId - The ID of the thought to open
 */
export function openThoughtCommand(sidebarProvider: NeuroTraceSidebarProvider, thoughtId: string) {
    if (sidebarProvider && sidebarProvider._view) {
        sidebarProvider._view.show(true);
        sidebarProvider._view.webview.postMessage({ type: 'open', id: thoughtId });
    }
}

/**
 * Performs a text search on thoughts
 * @param serverManager - The Python server manager instance
 * @param sidebarProvider - The sidebar provider instance
 * @param searchTerm - The search term to look for
 */
export async function searchCommand(serverManager: PythonServerManager, sidebarProvider: NeuroTraceSidebarProvider, searchTerm: string) {
    try {
        const results = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Searching thoughts",
            cancellable: false
        }, () => serverManager.sendCommand('search', { term: searchTerm })) as any[];

        if (results.length === 0) {
            vscode.window.showInformationMessage('No thoughts found matching your search.');
        }

        sidebarProvider.showSearchResults(results, searchTerm, false);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Search error: ${e.message}`);
    }
}

/**
 * Performs a semantic search on thoughts
 * @param serverManager - The Python server manager instance
 * @param sidebarProvider - The sidebar provider instance
 * @param searchTerm - The search term for semantic search
 */
export async function semanticSearchCommand(serverManager: PythonServerManager, sidebarProvider: NeuroTraceSidebarProvider, searchTerm: string) {
    try {
        const results = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Performing semantic search",
            cancellable: false
        }, () => serverManager.sendCommand('semantic-search', { query: searchTerm })) as any[];

        if (results.length === 0) {
            vscode.window.showInformationMessage('No semantically similar thoughts found.');
        }

        sidebarProvider.showSearchResults(results, searchTerm, true);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Semantic search error: ${e.message}`);
    }
}

/**
 * Shows an advanced export dialog with filtering options
 * @param serverManager - The Python server manager instance
 */
export async function advancedExportCommand(serverManager: PythonServerManager) {
    try {
        const entryTypes = await vscode.window.showQuickPick(
            [...MEMORY_TYPES],
            { placeHolder: 'Filter by type (select multiple or none for all)', canPickMany: true }
        );

        if (entryTypes === undefined) { return; }

        const sinceDateOptions = ['All time', 'Last week', 'Last month', 'Custom'];
        const sinceOption = await vscode.window.showQuickPick(sinceDateOptions, {
            placeHolder: 'Time period'
        });

        if (!sinceOption) { return; }

        let since = null;
        if (sinceOption === 'Custom') {
            since = await vscode.window.showInputBox({
                prompt: 'Date from (YYYY-MM-DD)',
                placeHolder: '2023-01-01'
            });
            if (!since) { return; }
        } else if (sinceOption === 'Last week') {
            const date = new Date();
            date.setDate(date.getDate() - 7);
            since = date.toISOString().split('T')[0];
        } else if (sinceOption === 'Last month') {
            const date = new Date();
            date.setMonth(date.getMonth() - 1);
            since = date.toISOString().split('T')[0];
        }

        const typeText = entryTypes && entryTypes.length > 0 ? entryTypes.join(', ') : 'All types';
        const sinceText = since ? `Since: ${since}` : 'All time';

        const payload = {
            entry_type: entryTypes && entryTypes.length > 0 ? entryTypes : null,
            since: since
        };

        const thoughtCount = await serverManager.sendCommand('count_thoughts', payload) as number;

        const confirmation = await vscode.window.showInformationMessage(
            `Export thoughts with the following filters?\n\nType: ${typeText}\n${sinceText}\n\nThoughts to export: ${thoughtCount}`,
            { modal: true },
            'Export',
            'Cancel'
        );

        if (confirmation !== 'Export') { return; }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Exporting thoughts with filters",
            cancellable: false
        }, async () => {
            const result = await serverManager.sendCommand('export-bundle', payload);

            if (result === "No thoughts found to export.") {
                vscode.window.showWarningMessage(result);
            } else {
                vscode.window.showInformationMessage(`Thoughts exported successfully: ${result}`);
            }
        });

    } catch (e: any) {
        vscode.window.showErrorMessage(`Error in advanced export: ${e.message}`);
    }
}

/**
 * Toggles the visibility of code icons
 * @param context - The extension context
 * @param sidebarProvider - The sidebar provider instance
 */
export async function toggleCodeIconsCommand(context: vscode.ExtensionContext, sidebarProvider: NeuroTraceSidebarProvider) {
    const config = vscode.workspace.getConfiguration('neurotrace');
    const currentValue = config.get('showCodeIcons', true);
    const newValue = !currentValue;

    await config.update('showCodeIcons', newValue, true);
    sidebarProvider.setShowCodeIcons(newValue);

    vscode.window.showInformationMessage(
        `Code icons ${newValue ? 'enabled' : 'disabled'}`
    );
}

/**
 * Opens the thought graph visualization panel
 * @param context - The extension context
 * @param serverManager - The Python server manager instance
 * @param setGlobalGraphPanel - Optional callback to set the global graph panel
 * @returns Promise<any> - The graph panel instance
 */
export async function openGraphCommand(context: vscode.ExtensionContext, serverManager: PythonServerManager, setGlobalGraphPanel?: (panel: any) => void) {
    const { ThoughtGraphPanel } = require('./ThoughtGraphPanel');
    const graphPanel = new ThoughtGraphPanel(context, serverManager);
    if (setGlobalGraphPanel) {
        setGlobalGraphPanel(graphPanel);
    }
    await graphPanel.show();
    return graphPanel;
}

/**
 * Opens the advanced settings panel
 * @param context - The extension context
 * @param setGlobalAdvancedPanel - Optional callback to set the global advanced panel
 * @returns Promise<AdvancedPanel> - The advanced panel instance
 */
export async function openAdvancedCommand(context: vscode.ExtensionContext, setGlobalAdvancedPanel?: (panel: AdvancedPanel) => void) {
    const advancedPanel = new AdvancedPanel(context);
    if (setGlobalAdvancedPanel) {
        setGlobalAdvancedPanel(advancedPanel);
    }
    await advancedPanel.show();
    return advancedPanel;
}

/**
 * Re-downloads the backend executable (useful for troubleshooting)
 * @param context - The extension context
 * @param serverManager - The Python server manager instance
 */
export async function redownloadBackendCommand(context: vscode.ExtensionContext, serverManager: PythonServerManager) {
    const confirmation = await vscode.window.showWarningMessage(
        'This will remove and re-download the NeuroTrace backend (~300-450 MB). The extension will restart. Continue?',
        'Yes, Re-download',
        'Cancel'
    );

    if (confirmation !== 'Yes, Re-download') {
        return;
    }

    try {
        // Import BackendDownloader
        const { BackendDownloader } = await import('./BackendDownloader.js');
        const downloader = new BackendDownloader(context);

        // Stop the server first and wait for a clean shutdown so the executable
        // can be removed safely on Windows.
        await serverManager.stopServerAndWait('update');

        // Remove existing backend
        await downloader.removeBackend({ silent: true });

        // Re-download
        const downloadedPath = await downloader.downloadBackend();

        if (!downloadedPath) {
            throw new Error('Download failed or was cancelled');
        }

        const restarted = await serverManager.startServerAndConfigureWorkspace();
        if (!restarted) {
            throw new Error('Backend downloaded, but the server could not be restarted for this workspace');
        }

        await downloader.ensureCodexWslBackend();
        await ensureMcpWorkspaceFilesForInitializedWorkspace(context, { silent: true });

        const action = await vscode.window.showInformationMessage(
            'NeuroTrace backend re-downloaded successfully. Reload the window to refresh all active integrations.',
            'Reload Window'
        );
        if (action === 'Reload Window') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
        return downloadedPath;

    } catch (error: any) {
        console.error('Backend re-download error:', error);
        vscode.window.showErrorMessage(`Failed to re-download backend: ${error.message}`);
    }
}
