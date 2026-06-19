import * as vscode from 'vscode';
import { PythonServerManager } from './PythonServerManager';
import { NEUROTRACE_WORKFLOW_LINES } from './workflowContent';

// ── Input types ──────────────────────────────────────────────────────

type MemoryType = 'hypothesis' | 'decision' | 'insight' | 'task' | 'risk' | 'discard' | 'note';
type TaskPriority = 'Low' | 'Moderate' | 'High';
type TaskStatus = 'open' | 'in-progress' | 'blocked' | 'closed' | 'obsolete';

interface AddThoughtInput {
    text: string;
    type: MemoryType;
    tags?: string;
    file_path?: string;
    line?: number;
    snippet?: string;
    priority?: TaskPriority;
    status?: TaskStatus;
}

interface ListThoughtsInput {
    page?: number;
    page_size?: number;
    type_filter?: MemoryType;
}

interface EditThoughtInput {
    thought_id: string;
    new_text?: string;
    new_tags?: string;
    new_file_path?: string;
    new_line?: number;
    new_snippet?: string;
    new_priority?: TaskPriority;
    new_status?: TaskStatus;
}

interface DeleteThoughtInput {
    thought_id: string;
}

interface SearchInput {
    term: string;
}

interface SemanticSearchInput {
    query: string;
}

interface SuggestRelatedInput {
    thought_id: string;
}

interface GraphDataInput {
    include_semantic?: boolean;
}

interface GetMemoriesByFileInput {
    file_path: string;
}

interface AddRelationInput {
    source_id: string;
    target_id: string;
    relation_type: string;
}

interface DeleteRelationInput {
    relation_id: string;
}

// ── Helper ───────────────────────────────────────────────────────────

function textResult(value: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}

function jsonResult(data: unknown): vscode.LanguageModelToolResult {
    return textResult(JSON.stringify(data, null, 2));
}

/**
 * Pre-flight check: verifies the database is accessible.
 * Returns a LanguageModelToolResult with an error message if the DB
 * is not ready, or undefined if everything is fine.
 */
async function checkDbReady(server: PythonServerManager): Promise<vscode.LanguageModelToolResult | undefined> {
    try {
        const result = await server.sendCommand<{ status: string }>('check_db_status');
        const status = result.status;

        if (status === 'UNENCRYPTED' || status === 'UNLOCKED') {
            return undefined; // DB is accessible
        }

        if (status === 'LOCKED') {
            // The compiled backend's check_db_status always tests with plain sqlite3,
            // so it returns LOCKED even after unlock_database set self.conn via sqlcipher.
            // Probe with a real command to see if the DB is actually accessible.
            try {
                const probe = await server.sendCommand<{ error?: string; thoughts?: unknown[] }>(
                    'list', { page: 0, page_size: 1 }
                );
                if (!probe.error) {
                    return undefined; // DB is actually unlocked and usable
                }
            } catch {
                // probe failed — DB is genuinely locked
            }

            return jsonResult({
                error: 'database_locked',
                message: 'The NeuroTrace database is encrypted and currently locked. Please ask the user to unlock it from the NeuroTrace sidebar panel before retrying.',
                action_required: 'User must open the NeuroTrace sidebar and enter their passphrase to unlock the database.'
            });
        }

        if (status === 'NO_DB') {
            return jsonResult({
                error: 'no_database',
                message: 'No NeuroTrace database exists in this workspace. Please ask the user to initialize the database from the NeuroTrace sidebar.',
                action_required: 'User must open the NeuroTrace sidebar and initialize a new database.'
            });
        }

        if (status === 'NO_WORKSPACE') {
            return jsonResult({
                error: 'no_workspace',
                message: 'No workspace folder is open. NeuroTrace requires an open workspace to store thoughts.',
                action_required: 'User must open a folder or workspace in VS Code.'
            });
        }

        return jsonResult({
            error: 'unknown_status',
            message: `Database status is "${status}". Unable to proceed.`
        });
    } catch {
        return jsonResult({
            error: 'backend_unavailable',
            message: 'The NeuroTrace backend is not running. Please wait for it to start or check the NeuroTrace sidebar.',
            action_required: 'User should check the NeuroTrace sidebar for backend status.'
        });
    }
}

// ── Tool implementations ─────────────────────────────────────────────

class AddThoughtTool implements vscode.LanguageModelTool<AddThoughtInput> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AddThoughtInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        const { text, type, tags, file_path, line, snippet, priority, status } = options.input;
        const response = await this.server.sendCommand<{ id: string; timestamp: string }>('add_thought', {
            text, type, tags, file_path, line, snippet, priority, status
        });
        vscode.commands.executeCommand('neurotrace.refreshSidebar');
        return jsonResult({ success: true, id: response.id, timestamp: response.timestamp });
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<AddThoughtInput>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        const preview = options.input.text.length > 60
            ? options.input.text.substring(0, 60) + '...'
            : options.input.text;
        return {
            invocationMessage: `Adding ${options.input.type}: "${preview}"`,
            confirmationMessages: {
                title: 'NeuroTrace: Add Memory',
                message: `Add a **${options.input.type}** memory?\n\n> ${options.input.text}`
            }
        };
    }
}

class ListThoughtsTool implements vscode.LanguageModelTool<ListThoughtsInput> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListThoughtsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        const page = options.input.page ?? 0;
        const pageSize = options.input.page_size ?? 20;
        const response = await this.server.sendCommand<{
            thoughts: any[];
            total: number;
            page: number;
        }>('list', { page, page_size: pageSize });

        let thoughts = response.thoughts;
        if (options.input.type_filter) {
            thoughts = thoughts.filter((t: any) => t.type === options.input.type_filter);
        }

        return jsonResult({
            thoughts,
            total: response.total,
            page: response.page,
            page_size: pageSize,
            has_more: (response.page + 1) * pageSize < response.total
        });
    }

    prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<ListThoughtsInput>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Listing NeuroTrace memories...' };
    }
}

class EditThoughtTool implements vscode.LanguageModelTool<EditThoughtInput> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<EditThoughtInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        const { thought_id, new_text, new_tags, new_file_path, new_line, new_snippet, new_priority, new_status } = options.input;
        const updated = await this.server.sendCommand<any>('edit', {
            thought_id,
            new_text,
            new_tags,
            new_file_path,
            new_line,
            new_snippet,
            new_priority,
            new_status
        });

        if (new_text && updated?.id) {
            this.server.sendCommand('process-one', { thought_id: updated.id }, false);
        }

        vscode.commands.executeCommand('neurotrace.refreshSidebar');
        return jsonResult({ success: true, thought: updated });
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<EditThoughtInput>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Editing memory ${options.input.thought_id}`,
            confirmationMessages: {
                title: 'NeuroTrace: Edit Memory',
                message: `Edit memory **${options.input.thought_id}**?`
            }
        };
    }
}

class GetMemoriesByFileTool implements vscode.LanguageModelTool<GetMemoriesByFileInput> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetMemoriesByFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        const result = await this.server.sendCommand<{
            file_path: string;
            memories: any[];
            count: number;
        }>('get_memories_by_file', { file_path: options.input.file_path });
        return jsonResult({
            file_path: result.file_path,
            memories: result.memories ?? [],
            count: result.count ?? 0
        });
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetMemoriesByFileInput>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Loading NeuroTrace memories for ${options.input.file_path}...`
        };
    }
}

class DeleteThoughtTool implements vscode.LanguageModelTool<DeleteThoughtInput> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DeleteThoughtInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        await this.server.sendCommand('delete', { thought_id: options.input.thought_id });
        vscode.commands.executeCommand('neurotrace.refreshSidebar');
        return jsonResult({ success: true, deleted: options.input.thought_id });
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<DeleteThoughtInput>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Deleting thought ${options.input.thought_id}`,
            confirmationMessages: {
                title: 'NeuroTrace: Delete Thought',
                message: `Are you sure you want to delete thought **${options.input.thought_id}**? This cannot be undone.`
            }
        };
    }
}

class SearchThoughtsTool implements vscode.LanguageModelTool<SearchInput> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        const results = await this.server.sendCommand<any[]>('search', { term: options.input.term });
        return jsonResult({ results, count: results.length });
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SearchInput>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Searching thoughts for "${options.input.term}"...` };
    }
}

class SemanticSearchTool implements vscode.LanguageModelTool<SemanticSearchInput> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SemanticSearchInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        const results = await this.server.sendCommand<any[]>('semantic-search', { query: options.input.query });
        return jsonResult({ results, count: results.length });
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SemanticSearchInput>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Semantic search for "${options.input.query}"...` };
    }
}

class SuggestRelatedTool implements vscode.LanguageModelTool<SuggestRelatedInput> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SuggestRelatedInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        const results = await this.server.sendCommand<any[]>('suggest', { thought_id: options.input.thought_id });
        return jsonResult({ related: results, count: results?.length ?? 0 });
    }

    prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<SuggestRelatedInput>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Finding related thoughts...' };
    }
}

class GetGraphDataTool implements vscode.LanguageModelTool<GraphDataInput> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GraphDataInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        const data = await this.server.sendCommand<any>('graph-data');

        if (!options.input.include_semantic && data?.edges) {
            data.edges = data.edges.filter((e: any) => e.rel !== 'semantic');
        }

        return jsonResult({
            nodes: data?.nodes ?? [],
            edges: data?.edges ?? [],
            node_count: data?.nodes?.length ?? 0,
            edge_count: data?.edges?.length ?? 0
        });
    }

    prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GraphDataInput>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Loading knowledge graph...' };
    }
}

class GetGraphInsightsTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        const insights = await this.server.sendCommand<any>('graph-insights');
        return jsonResult(insights);
    }

    prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Analyzing knowledge graph...' };
    }
}

class AddRelationTool implements vscode.LanguageModelTool<AddRelationInput> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AddRelationInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        const { source_id, target_id, relation_type } = options.input;
        await this.server.sendCommand('add-relation', {
            src: source_id,
            dst: target_id,
            rel: relation_type
        });
        return jsonResult({ success: true, source: source_id, target: target_id, relation: relation_type });
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<AddRelationInput>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Creating "${options.input.relation_type}" relation...`,
            confirmationMessages: {
                title: 'NeuroTrace: Add Relation',
                message: `Create a **${options.input.relation_type}** relation between thoughts?`
            }
        };
    }
}

class DeleteRelationTool implements vscode.LanguageModelTool<DeleteRelationInput> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DeleteRelationInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const blocked = await checkDbReady(this.server);
        if (blocked) { return blocked; }
        await this.server.sendCommand('delete-relation', { id: options.input.relation_id });
        return jsonResult({ success: true, deleted: options.input.relation_id });
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<DeleteRelationInput>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Deleting relation ${options.input.relation_id}`,
            confirmationMessages: {
                title: 'NeuroTrace: Delete Relation',
                message: `Delete relation **${options.input.relation_id}**?`
            }
        };
    }
}

class GetDatabaseStatusTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private server: PythonServerManager) { }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await this.server.sendCommand<{ status: string }>('check_db_status');
            let status = result.status;

            // Same probe as checkDbReady: compiled backend may report LOCKED
            // even when the DB was unlocked in the sidebar
            if (status === 'LOCKED') {
                try {
                    const probe = await this.server.sendCommand<{ error?: string }>(
                        'list', { page: 0, page_size: 1 }
                    );
                    if (!probe.error) {
                        status = 'UNLOCKED';
                    }
                } catch {
                    // genuinely locked
                }
            }

            if (status === 'LOCKED') {
                return jsonResult({
                    database_status: 'LOCKED',
                    backend_running: true,
                    message: 'The database is encrypted and locked. The user must unlock it from the NeuroTrace sidebar before you can read or write thoughts.',
                    action_required: 'Ask the user to open the NeuroTrace sidebar and enter their passphrase.'
                });
            }

            if (status === 'NO_DB') {
                return jsonResult({
                    database_status: 'NO_DB',
                    backend_running: true,
                    message: 'No database exists yet. The user must initialize it from the NeuroTrace sidebar.',
                    action_required: 'Ask the user to open the NeuroTrace sidebar and initialize a database.'
                });
            }

            if (status === 'NO_WORKSPACE') {
                return jsonResult({
                    database_status: 'NO_WORKSPACE',
                    backend_running: true,
                    message: 'No workspace folder is open. NeuroTrace requires an open workspace.',
                    action_required: 'Ask the user to open a folder in VS Code.'
                });
            }

            // UNENCRYPTED or UNLOCKED — DB is accessible
            const count = await this.server.sendCommand<{ total: number }>('get_total_count');
            return jsonResult({
                database_status: status,
                total_thoughts: count.total,
                backend_running: true
            });
        } catch {
            return jsonResult({
                database_status: 'UNKNOWN',
                backend_running: false,
                message: 'The NeuroTrace backend is not running. Please check the NeuroTrace sidebar.',
                action_required: 'Ask the user to check if the NeuroTrace backend is installed and running.'
            });
        }
    }

    prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Checking NeuroTrace status...' };
    }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerMcpTools(
    context: vscode.ExtensionContext,
    serverManager: PythonServerManager
): void {
    const tools: [string, vscode.LanguageModelTool<any>][] = [
        ['neurotrace_addThought', new AddThoughtTool(serverManager)],
        ['neurotrace_listThoughts', new ListThoughtsTool(serverManager)],
        ['neurotrace_editThought', new EditThoughtTool(serverManager)],
        ['neurotrace_deleteThought', new DeleteThoughtTool(serverManager)],
        ['neurotrace_getMemoriesByFile', new GetMemoriesByFileTool(serverManager)],
        ['neurotrace_searchThoughts', new SearchThoughtsTool(serverManager)],
        ['neurotrace_semanticSearch', new SemanticSearchTool(serverManager)],
        ['neurotrace_suggestRelated', new SuggestRelatedTool(serverManager)],
        ['neurotrace_getGraphData', new GetGraphDataTool(serverManager)],
        ['neurotrace_getGraphInsights', new GetGraphInsightsTool(serverManager)],
        ['neurotrace_addRelation', new AddRelationTool(serverManager)],
        ['neurotrace_deleteRelation', new DeleteRelationTool(serverManager)],
        ['neurotrace_getDatabaseStatus', new GetDatabaseStatusTool(serverManager)],
    ];

    for (const [name, tool] of tools) {
        context.subscriptions.push(vscode.lm.registerTool(name, tool));
    }

    console.log(`NeuroTrace MCP: Registered ${tools.length} tools for AI agents`);
}

const NEUROTRACE_MARKER = '<!-- neurotrace-copilot-instructions -->';

function isCursorHost(): boolean {
    return Boolean((vscode as any).cursor?.mcp) || vscode.env.appName.toLowerCase().includes('cursor');
}

const copilotLines = NEUROTRACE_WORKFLOW_LINES
    .map(line => line.replace(/`neurotrace_/g, '`#neurotrace_'))
    .join('\n');

const NEUROTRACE_INSTRUCTIONS = `
${NEUROTRACE_MARKER}
## NeuroTrace Workflow

${copilotLines}
`;

export async function ensureCopilotInstructions(_context: vscode.ExtensionContext): Promise<void> {
    if (isCursorHost()) {
        return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return; }

    const githubDir = vscode.Uri.joinPath(workspaceFolder.uri, '.github');
    const instructionsUri = vscode.Uri.joinPath(githubDir, 'copilot-instructions.md');

    try {
        const existing = await vscode.workspace.fs.readFile(instructionsUri);
        const content = Buffer.from(existing).toString('utf8');
        if (content.includes(NEUROTRACE_MARKER)) {
            return;
        }

        const updated = content.trimEnd() + '\n' + NEUROTRACE_INSTRUCTIONS;
        await vscode.workspace.fs.writeFile(instructionsUri, Buffer.from(updated, 'utf8'));
    } catch {
        try {
            await vscode.workspace.fs.createDirectory(githubDir);
        } catch {
            // Directory may already exist.
        }
        const content = `# Copilot Instructions\n${NEUROTRACE_INSTRUCTIONS}`;
        await vscode.workspace.fs.writeFile(instructionsUri, Buffer.from(content, 'utf8'));
    }
}
