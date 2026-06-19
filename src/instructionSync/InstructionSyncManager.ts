import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    buildCopilotInstructionDocument,
    buildCursorRuleContent,
    CANONICAL_INSTRUCTIONS_RELATIVE_PATH,
    extractManagedBlockContent,
    getBuiltInTargetPath,
    getDefaultInstructionContent,
    INSTRUCTION_SYNC_CONFIG_RELATIVE_PATH,
    NEUROTRACE_AGENTS_END,
    NEUROTRACE_AGENTS_START,
    normalizeInstructionContent,
    upsertManagedMarkdownDocument
} from './content';
import {
    BuiltInInstructionTargetId,
    InstructionSyncConfig,
    InstructionSyncPanelState,
    InstructionTargetConfig,
    InstructionTargetPreview
} from './types';

type RenderResult = {
    status: InstructionTargetPreview['status'];
    message: string;
    content?: string;
};

const BUILT_IN_TARGETS: BuiltInInstructionTargetId[] = ['agents', 'claude', 'copilot', 'cursor'];
const GLOBAL_INSTRUCTION_SYNC_CONFIG_FILENAME = 'instructionSync.json';
const LEGACY_GLOBAL_CONFIG_PREFIX = 'instructionSync_';

function normalizeStoredPath(filePath: string): string {
    return path.normalize(filePath).replace(/\\/g, '/');
}

function resolveCanonicalPath(workspacePath: string, canonicalPath: string): string {
    return path.isAbsolute(canonicalPath)
        ? path.normalize(canonicalPath)
        : path.resolve(workspacePath, canonicalPath);
}

function resolveTargetPath(workspacePath: string, targetPath: string): string {
    return path.isAbsolute(targetPath)
        ? path.normalize(targetPath)
        : path.resolve(workspacePath, targetPath);
}

function matchesBuiltInTargetPath(targetPath: string, targetId: BuiltInInstructionTargetId): boolean {
    const normalizedPath = normalizeStoredPath(targetPath).toLowerCase();
    const builtInSuffix = normalizeStoredPath(getBuiltInTargetPath(targetId)).toLowerCase();
    return normalizedPath === builtInSuffix || normalizedPath.endsWith(`/${builtInSuffix}`);
}

function inferTargetType(targetPath: string): BuiltInInstructionTargetId | 'custom' {
    for (const targetId of BUILT_IN_TARGETS) {
        if (matchesBuiltInTargetPath(targetPath, targetId)) {
            return targetId;
        }
    }
    // Any .mdc file is a Cursor rule — preserve YAML frontmatter format
    if (normalizeStoredPath(targetPath).toLowerCase().endsWith('.mdc')) {
        return 'cursor';
    }
    return 'custom';
}

function createTargetConfig(targetPath: string): InstructionTargetConfig {
    const normalizedPath = normalizeStoredPath(targetPath);
    const targetType = inferTargetType(normalizedPath);
    return {
        id: `target-${crypto.randomUUID()}`,
        label: path.basename(normalizedPath),
        relativePath: normalizedPath,
        enabled: true,
        targetType,
        userAdded: true,
    };
}

function getSeedSourceLabel(config: InstructionSyncConfig): string {
    if (config.sourceLabel) {
        return config.sourceLabel;
    }

    switch (config.seedSource) {
        case 'workspace-agents':
            return 'Imported from workspace AGENTS.md';
        case 'custom-import':
            return 'Imported from custom AGENTS.md';
        default:
            return 'Using NeuroTrace template';
    }
}

function renderTargetContent(
    targetType: BuiltInInstructionTargetId | 'custom',
    existingContent: string | null,
    canonicalContent: string
): RenderResult {
    try {
        let nextContent: string;

        switch (targetType) {
            case 'agents':
            case 'claude':
            case 'custom':
                nextContent = normalizeInstructionContent(canonicalContent);
                break;
            case 'copilot':
                nextContent = buildCopilotInstructionDocument(existingContent, canonicalContent);
                break;
            case 'cursor':
                nextContent = buildCursorRuleContent(canonicalContent);
                break;
        }

        if (existingContent === null) {
            return { status: 'create', message: 'Target file not found yet. Sync can write the NeuroTrace-managed instructions here.', content: nextContent };
        }

        if (existingContent.replace(/\r\n/g, '\n') === nextContent.replace(/\r\n/g, '\n')) {
            return { status: 'unchanged', message: 'Already in sync.', content: nextContent };
        }

        return { status: 'update', message: 'Will update the NeuroTrace-managed content.', content: nextContent };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: 'error', message };
    }
}

function getGlobalConfigPath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, GLOBAL_INSTRUCTION_SYNC_CONFIG_FILENAME);
}

function parseInstructionSyncConfig(rawContent: string): (Partial<InstructionSyncConfig> & {
    builtInTargets?: Record<BuiltInInstructionTargetId, boolean>;
    customTargets?: Array<{
        id: string;
        label: string;
        relativePath: string;
        enabled: boolean;
    }>;
}) | null {
    try {
        return JSON.parse(rawContent) as Partial<InstructionSyncConfig> & {
            builtInTargets?: Record<BuiltInInstructionTargetId, boolean>;
            customTargets?: Array<{
                id: string;
                label: string;
                relativePath: string;
                enabled: boolean;
            }>;
        };
    } catch {
        return null;
    }
}

function absolutizeCanonicalPathInConfig(rawConfig: string, workspacePath: string): string | null {
    const parsed = parseInstructionSyncConfig(rawConfig);
    if (!parsed) {
        return null;
    }

    const canonicalPath = typeof parsed.canonicalPath === 'string' && parsed.canonicalPath.trim().length > 0
        ? parsed.canonicalPath
        : CANONICAL_INSTRUCTIONS_RELATIVE_PATH.replace(/\\/g, '/');

    parsed.canonicalPath = normalizeStoredPath(resolveCanonicalPath(workspacePath, canonicalPath));
    return `${JSON.stringify(parsed, null, 2)}\n`;
}

function findLegacyHashedConfigPathSync(context: vscode.ExtensionContext, workspacePath: string): string | null {
    const storagePath = context.globalStorageUri.fsPath;
    if (!fs.existsSync(storagePath)) {
        return null;
    }

    const preferredHash = crypto.createHash('md5').update(workspacePath).digest('hex').slice(0, 12);
    const preferredName = `${LEGACY_GLOBAL_CONFIG_PREFIX}${preferredHash}.json`;
    const preferredPath = path.join(storagePath, preferredName);
    if (fs.existsSync(preferredPath)) {
        return preferredPath;
    }

    const legacyMatches = fs.readdirSync(storagePath)
        .filter((entry) => entry.startsWith(LEGACY_GLOBAL_CONFIG_PREFIX) && entry.endsWith('.json'))
        .map((entry) => {
            const entryPath = path.join(storagePath, entry);
            const stats = fs.statSync(entryPath);
            return { entryPath, mtimeMs: stats.mtimeMs };
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs);

    return legacyMatches[0]?.entryPath ?? null;
}

async function findLegacyHashedConfigPath(context: vscode.ExtensionContext, workspacePath: string): Promise<string | null> {
    const storagePath = context.globalStorageUri.fsPath;
    try {
        const preferredHash = crypto.createHash('md5').update(workspacePath).digest('hex').slice(0, 12);
        const preferredPath = path.join(storagePath, `${LEGACY_GLOBAL_CONFIG_PREFIX}${preferredHash}.json`);
        await fs.promises.access(preferredPath);
        return preferredPath;
    } catch { /* fall through */ }

    try {
        const entries = await fs.promises.readdir(storagePath, { withFileTypes: true });
        const legacyMatches = await Promise.all(
            entries
                .filter((entry) => entry.isFile() && entry.name.startsWith(LEGACY_GLOBAL_CONFIG_PREFIX) && entry.name.endsWith('.json'))
                .map(async (entry) => {
                    const entryPath = path.join(storagePath, entry.name);
                    const stats = await fs.promises.stat(entryPath);
                    return { entryPath, mtimeMs: stats.mtimeMs };
                })
        );
        legacyMatches.sort((left, right) => right.mtimeMs - left.mtimeMs);
        return legacyMatches[0]?.entryPath ?? null;
    } catch {
        return null;
    }
}

function migrateLegacyConfigSync(context: vscode.ExtensionContext, workspacePath: string, globalPath: string): void {
    const legacyPath = path.join(workspacePath, INSTRUCTION_SYNC_CONFIG_RELATIVE_PATH);
    const hashedPath = findLegacyHashedConfigPathSync(context, workspacePath);
    const sourcePath = hashedPath ?? (fs.existsSync(legacyPath) ? legacyPath : null);

    if (!sourcePath) {
        return;
    }

    try {
        fs.mkdirSync(path.dirname(globalPath), { recursive: true });
        const sourceContent = fs.readFileSync(sourcePath, 'utf8');
        const normalizedContent = absolutizeCanonicalPathInConfig(sourceContent, workspacePath);
        if (normalizedContent === null) {
            fs.copyFileSync(sourcePath, globalPath);
            return;
        }
        fs.writeFileSync(globalPath, normalizedContent, 'utf8');
    } catch { /* ignore migration errors */ }
}

async function migrateLegacyConfig(context: vscode.ExtensionContext, workspacePath: string, globalPath: string): Promise<void> {
    const legacyPath = path.join(workspacePath, INSTRUCTION_SYNC_CONFIG_RELATIVE_PATH);
    const hashedPath = await findLegacyHashedConfigPath(context, workspacePath);
    const sourcePath = hashedPath ?? await (async () => {
        try {
            await fs.promises.access(legacyPath);
            return legacyPath;
        } catch {
            return null;
        }
    })();

    if (!sourcePath) {
        return;
    }

    try {
        await fs.promises.mkdir(path.dirname(globalPath), { recursive: true });
        const sourceContent = await fs.promises.readFile(sourcePath, 'utf8');
        const normalizedContent = absolutizeCanonicalPathInConfig(sourceContent, workspacePath);
        if (normalizedContent === null) {
            await fs.promises.copyFile(sourcePath, globalPath);
            return;
        }
        await fs.promises.writeFile(globalPath, normalizedContent, 'utf8');
    } catch { /* ignore migration errors */ }
}

function readSyncConfigSync(context: vscode.ExtensionContext, workspacePath: string): InstructionSyncConfig | null {
    const globalPath = getGlobalConfigPath(context);

    // Migrate from legacy workspace location on first access
    if (!fs.existsSync(globalPath)) {
        migrateLegacyConfigSync(context, workspacePath, globalPath);
        if (!fs.existsSync(globalPath)) {
            return null;
        }
    }

    try {
        return JSON.parse(fs.readFileSync(globalPath, 'utf8')) as InstructionSyncConfig;
    } catch {
        return null;
    }
}

function tryResolveCanonicalPathFromLegacySync(context: vscode.ExtensionContext, workspacePath: string): string | null {
    const candidatePaths = [
        findLegacyHashedConfigPathSync(context, workspacePath),
        path.join(workspacePath, INSTRUCTION_SYNC_CONFIG_RELATIVE_PATH),
    ].filter((value): value is string => Boolean(value));

    for (const candidatePath of candidatePaths) {
        try {
            if (!fs.existsSync(candidatePath)) {
                continue;
            }
            const parsed = parseInstructionSyncConfig(fs.readFileSync(candidatePath, 'utf8'));
            if (!parsed?.canonicalPath || typeof parsed.canonicalPath !== 'string') {
                continue;
            }
            return normalizeStoredPath(resolveCanonicalPath(workspacePath, parsed.canonicalPath));
        } catch {
            // Ignore malformed legacy config candidates
        }
    }

    return null;
}

export function hasInstructionSyncConfig(context: vscode.ExtensionContext, workspacePath: string): boolean {
    return readSyncConfigSync(context, workspacePath) !== null;
}

export function getEffectiveInstructionContent(context: vscode.ExtensionContext, workspacePath: string): string {
    const config = readSyncConfigSync(context, workspacePath);
    if (!config) {
        return getDefaultInstructionContent();
    }

    const canonicalPath = path.isAbsolute(config.canonicalPath)
        ? resolveCanonicalPath(workspacePath, config.canonicalPath)
        : (tryResolveCanonicalPathFromLegacySync(context, workspacePath) ?? resolveCanonicalPath(workspacePath, config.canonicalPath));
    if (!fs.existsSync(canonicalPath)) {
        return getDefaultInstructionContent();
    }

    return normalizeInstructionContent(fs.readFileSync(canonicalPath, 'utf8'));
}

export function isBuiltInInstructionTargetEnabled(context: vscode.ExtensionContext, workspacePath: string, targetId: BuiltInInstructionTargetId): boolean {
    const config = readSyncConfigSync(context, workspacePath);
    if (!config) {
        return true;
    }

    if (Array.isArray(config.targets)) {
        return config.targets.some((target) => target.userAdded === true && target.targetType === targetId && target.enabled !== false);
    }

    return false;
}

export function syncBuiltInInstructionTargets(context: vscode.ExtensionContext, workspacePath: string, targetIds: BuiltInInstructionTargetId[]): void {
    const canonicalContent = getEffectiveInstructionContent(context, workspacePath);

        for (const targetId of targetIds) {
            if (!isBuiltInInstructionTargetEnabled(context, workspacePath, targetId)) {
                continue;
            }

        const targetPath = path.join(workspacePath, getBuiltInTargetPath(targetId));
        const existingContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
        const rendered = renderTargetContent(targetId, existingContent, canonicalContent);
        if (rendered.status === 'error' || !rendered.content || rendered.status === 'unchanged') {
            continue;
        }

        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, rendered.content, 'utf8');
    }
}

export class InstructionSyncManager {
    constructor(private readonly context: vscode.ExtensionContext) { }

    public async getState(): Promise<InstructionSyncPanelState> {
        const workspacePath = this.getWorkspacePath();
        const config = await this.ensureSetup(workspacePath);
        const canonicalPath = await this.resolveCanonicalPathForConfig(config, workspacePath);
        const canonicalContent = normalizeInstructionContent(await fs.promises.readFile(canonicalPath, 'utf8'));

        return {
            canonicalPath: normalizeStoredPath(canonicalPath),
            canonicalContent,
            seedSourceLabel: getSeedSourceLabel(config),
            targets: await this.buildTargetPreviews(workspacePath, config, canonicalContent),
        };
    }

    public async syncNow(): Promise<InstructionSyncPanelState> {
        const workspacePath = this.getWorkspacePath();
        const config = await this.ensureSetup(workspacePath);
        const canonicalPath = await this.resolveCanonicalPathForConfig(config, workspacePath);
        const normalizedContent = normalizeInstructionContent(await fs.promises.readFile(canonicalPath, 'utf8'));

        for (const target of this.getTargetDefinitions(config)) {
            if (!target.enabled) {
                continue;
            }

            const absolutePath = path.resolve(workspacePath, target.relativePath);
            const existingContent = await this.readOptionalTextFile(absolutePath);
            const rendered = renderTargetContent(target.targetType, existingContent, normalizedContent);
            if (rendered.status === 'error' || !rendered.content) {
                continue;
            }

            await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
            await fs.promises.writeFile(absolutePath, rendered.content, 'utf8');
        }

        return this.getState();
    }

    public async useNeuroTraceTemplate(): Promise<InstructionSyncPanelState> {
        const workspacePath = this.getWorkspacePath();
        const config = await this.ensureSetup(workspacePath);
        const canonicalContent = getDefaultInstructionContent();

        // Always reset canonical to the local NeuroTrace-managed file, regardless
        // of what the user had configured. This guarantees the folder is created
        // and the template is never written to an external file.
        const canonicalPath = path.join(workspacePath, CANONICAL_INSTRUCTIONS_RELATIVE_PATH);

        config.canonicalPath = normalizeStoredPath(canonicalPath);
        config.seedSource = 'neurotrace-scaffold';
        config.sourceLabel = 'Using NeuroTrace template';
        await fs.promises.mkdir(path.dirname(canonicalPath), { recursive: true });
        await fs.promises.writeFile(canonicalPath, canonicalContent, 'utf8');
        await this.writeConfig(workspacePath, config);
        return this.getState();
    }

    public async openCanonicalInEditor(): Promise<void> {
        const workspacePath = this.getWorkspacePath();
        const config = await this.ensureSetup(workspacePath);
        const canonicalPath = await this.resolveCanonicalPathForConfig(config, workspacePath);
        const uri = vscode.Uri.file(canonicalPath);
        await vscode.window.showTextDocument(uri, { preview: false });
    }

    public async changeCanonicalFile(): Promise<InstructionSyncPanelState | null> {
        const workspacePath = this.getWorkspacePath();
        const defaultWorkspaceAgentsPath = path.join(workspacePath, 'AGENTS.md');
        const defaultUri = vscode.Uri.file(
            fs.existsSync(defaultWorkspaceAgentsPath)
                ? defaultWorkspaceAgentsPath
                : workspacePath
        );

        const selection = await vscode.window.showOpenDialog({
            title: 'Choose canonical instruction file',
            canSelectMany: false,
            canSelectFolders: false,
            canSelectFiles: true,
            defaultUri,
            filters: { Markdown: ['md', 'markdown', 'mdc', 'txt'] }
        });

        if (!selection?.length) {
            return null;
        }

        const selectedFsPath = selection[0].fsPath;
        const storedPath = normalizeStoredPath(selectedFsPath);

        const config = await this.ensureSetup(workspacePath);

        if (path.normalize(storedPath) === resolveCanonicalPath(workspacePath, config.canonicalPath)) {
            return this.getState();
        }

        config.canonicalPath = storedPath;
        config.seedSource = 'custom-import';
        config.sourceLabel = path.basename(selectedFsPath);
        await this.writeConfig(workspacePath, config);
        return this.getState();
    }

    public async setTargetEnabled(targetId: string, enabled: boolean): Promise<InstructionSyncPanelState> {
        const workspacePath = this.getWorkspacePath();
        const config = await this.ensureSetup(workspacePath);
        const target = config.targets.find((item) => item.id === targetId);
        if (target) {
            target.enabled = enabled;
            await this.writeConfig(workspacePath, config);
        }
        return this.getState();
    }

    public async pickAndAddTarget(): Promise<InstructionSyncPanelState | null> {
        const workspacePath = this.getWorkspacePath();
        const defaultUri = vscode.Uri.file(workspacePath);

        const selection = await vscode.window.showOpenDialog({
            title: 'Add Instruction Target',
            openLabel: 'Add as Target',
            canSelectMany: false,
            canSelectFolders: false,
            canSelectFiles: true,
            defaultUri,
            filters: {
                Markdown: ['md', 'markdown', 'mdc', 'txt']
            }
        });
        if (!selection?.length) {
            return null;
        }

        return this.addTarget(selection[0]);
    }

    public async addTarget(uri: vscode.Uri): Promise<InstructionSyncPanelState> {
        const workspacePath = this.getWorkspacePath();
        const storedPath = normalizeStoredPath(uri.fsPath);

        const config = await this.ensureSetup(workspacePath);

        if (resolveTargetPath(workspacePath, storedPath) === resolveCanonicalPath(workspacePath, config.canonicalPath)) {
            throw new Error('Custom targets cannot reuse the canonical instruction file path.');
        }
        const duplicatePath = this.getTargetDefinitions(config).some(
            (target) => resolveTargetPath(workspacePath, target.relativePath) === resolveTargetPath(workspacePath, storedPath)
        );
        if (duplicatePath) {
            throw new Error('That target path is already managed by Instruction Sync.');
        }

        config.targets.push(createTargetConfig(storedPath));

        await this.writeConfig(workspacePath, config);

        if (storedPath.endsWith('.mdc')) {
            void vscode.window.showWarningMessage(
                'Advanced use: syncing to a Cursor rules file (.mdc) will overwrite its entire content, including any alwaysApply, description, or file glob settings. Make sure this is intentional.'
            );
        }

        return this.getState();
    }

    public async removeTarget(targetId: string): Promise<InstructionSyncPanelState> {
        const workspacePath = this.getWorkspacePath();
        const config = await this.ensureSetup(workspacePath);
        config.targets = config.targets.filter((target) => target.id !== targetId);
        await this.writeConfig(workspacePath, config);
        return this.getState();
    }

    private async buildTargetPreviews(
        workspacePath: string,
        config: InstructionSyncConfig,
        canonicalContent: string
    ): Promise<InstructionTargetPreview[]> {
        const previews: InstructionTargetPreview[] = [];
        for (const target of this.getTargetDefinitions(config)) {
            const absolutePath = normalizeStoredPath(resolveTargetPath(workspacePath, target.relativePath));
            if (!target.enabled) {
                previews.push({ ...target, label: path.basename(absolutePath), relativePath: absolutePath, status: 'disabled', message: 'Disabled.' });
                continue;
            }

            try {
                const existingContent = await this.readOptionalTextFile(absolutePath);
                const rendered = renderTargetContent(target.targetType, existingContent, canonicalContent);
                previews.push({
                    ...target,
                    label: path.basename(absolutePath),
                    relativePath: absolutePath,
                    status: rendered.status,
                    message: rendered.message,
                });
            } catch (error) {
                previews.push({
                    ...target,
                    label: path.basename(absolutePath),
                    relativePath: absolutePath,
                    status: 'error',
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return previews;
    }

    private getTargetDefinitions(config: InstructionSyncConfig): InstructionTargetConfig[] {
        return [...config.targets].sort((left, right) => left.label.localeCompare(right.label));
    }

    private async ensureSetup(workspacePath: string): Promise<InstructionSyncConfig> {
        const config = await this.readConfig(workspacePath) ?? await this.createDefaultConfig(workspacePath);
        const canonicalPath = await this.resolveCanonicalPathForConfig(config, workspacePath);
        const normalizedStoredCanonicalPath = path.isAbsolute(config.canonicalPath)
            ? normalizeStoredPath(canonicalPath)
            : await this.tryResolveCanonicalPathFromLegacy(workspacePath);
        let didMutateConfig = false;

        if (normalizedStoredCanonicalPath && config.canonicalPath !== normalizedStoredCanonicalPath) {
            config.canonicalPath = normalizedStoredCanonicalPath;
            didMutateConfig = true;
        }

        await fs.promises.mkdir(path.dirname(canonicalPath), { recursive: true });
        if (!fs.existsSync(canonicalPath)) {
            const seed = this.buildInitialCanonicalContent(workspacePath);
            await fs.promises.writeFile(canonicalPath, seed.content, 'utf8');
            config.seedSource = seed.seedSource;
            config.sourceLabel = seed.sourceLabel;
            didMutateConfig = true;
        }

        if (didMutateConfig) {
            await this.writeConfig(workspacePath, config);
        }

        return config;
    }

    private async createDefaultConfig(workspacePath: string): Promise<InstructionSyncConfig> {
        const seed = this.buildInitialCanonicalContent(workspacePath);
        const canonicalPath = path.join(workspacePath, CANONICAL_INSTRUCTIONS_RELATIVE_PATH);
        const config: InstructionSyncConfig = {
            version: 1,
            canonicalPath: normalizeStoredPath(canonicalPath),
            seedSource: seed.seedSource,
            sourceLabel: seed.sourceLabel,
            targets: [],
        };

        await fs.promises.mkdir(path.dirname(canonicalPath), { recursive: true });
        await fs.promises.writeFile(canonicalPath, seed.content, 'utf8');
        await this.writeConfig(workspacePath, config);
        return config;
    }

    private buildInitialCanonicalContent(workspacePath: string): { content: string; seedSource: InstructionSyncConfig['seedSource']; sourceLabel: string } {
        const workspaceAgentsPath = path.join(workspacePath, 'AGENTS.md');
        if (fs.existsSync(workspaceAgentsPath)) {
            const existingContent = fs.readFileSync(workspaceAgentsPath, 'utf8');
            const managedSection = extractManagedBlockContent(existingContent, NEUROTRACE_AGENTS_START, NEUROTRACE_AGENTS_END);
            return {
                content: normalizeInstructionContent(managedSection ?? existingContent),
                seedSource: 'workspace-agents',
                sourceLabel: 'Imported from workspace AGENTS.md',
            };
        }

        return {
            content: getDefaultInstructionContent(),
            seedSource: 'neurotrace-scaffold',
            sourceLabel: 'Using NeuroTrace template',
        };
    }

    private getGlobalConfigPath(): string {
        return getGlobalConfigPath(this.context);
    }

    private async readConfig(workspacePath: string): Promise<InstructionSyncConfig | null> {
        const globalPath = this.getGlobalConfigPath();

        // Migrate from legacy workspace location on first access
        if (!fs.existsSync(globalPath)) {
            await migrateLegacyConfig(this.context, workspacePath, globalPath);
            if (!fs.existsSync(globalPath)) {
                return null;
            }
        }

        try {
            const rawContent = await fs.promises.readFile(globalPath, 'utf8');
            const parsed = parseInstructionSyncConfig(rawContent);
            if (!parsed) {
                return null;
            }

            const targets = this.normalizeTargets(parsed);
            return {
                version: 1,
                canonicalPath: parsed.canonicalPath || CANONICAL_INSTRUCTIONS_RELATIVE_PATH.replace(/\\/g, '/'),
                seedSource: parsed.seedSource || 'neurotrace-scaffold',
                sourceLabel: parsed.sourceLabel,
                targets,
            };
        } catch {
            return null;
        }
    }

    private normalizeTargets(parsed: Partial<InstructionSyncConfig> & {
        builtInTargets?: Record<BuiltInInstructionTargetId, boolean>;
        customTargets?: Array<{
            id: string;
            label: string;
            relativePath: string;
            enabled: boolean;
        }>;
    }): InstructionTargetConfig[] {
        if (Array.isArray(parsed.targets)) {
            return parsed.targets
                .filter((target): target is InstructionTargetConfig => Boolean(target?.id && target?.label && target?.relativePath && target?.targetType))
                .map((target) => {
                    const relativePath = normalizeStoredPath(target.relativePath);
                    // Re-infer type from path so existing targets saved as 'custom'
                    // get the correct renderer (e.g. .mdc files → 'cursor' frontmatter)
                    const targetType = inferTargetType(relativePath);
                    return {
                        ...target,
                        label: path.basename(relativePath),
                        relativePath,
                        targetType,
                        enabled: target.enabled !== false,
                    };
                })
                .filter((target) => target.userAdded === true);
        }

        return [];
    }

    private async writeConfig(_workspacePath: string, config: InstructionSyncConfig): Promise<void> {
        const globalPath = this.getGlobalConfigPath();
        await fs.promises.mkdir(path.dirname(globalPath), { recursive: true });
        await fs.promises.writeFile(globalPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    }

    private async resolveCanonicalPathForConfig(config: InstructionSyncConfig, workspacePath: string): Promise<string> {
        if (path.isAbsolute(config.canonicalPath)) {
            return resolveCanonicalPath(workspacePath, config.canonicalPath);
        }

        return await this.tryResolveCanonicalPathFromLegacy(workspacePath)
            ?? resolveCanonicalPath(workspacePath, config.canonicalPath);
    }

    private async tryResolveCanonicalPathFromLegacy(workspacePath: string): Promise<string | null> {
        const candidatePaths = [
            await findLegacyHashedConfigPath(this.context, workspacePath),
            path.join(workspacePath, INSTRUCTION_SYNC_CONFIG_RELATIVE_PATH),
        ].filter((value): value is string => Boolean(value));

        for (const candidatePath of candidatePaths) {
            try {
                await fs.promises.access(candidatePath);
                const parsed = parseInstructionSyncConfig(await fs.promises.readFile(candidatePath, 'utf8'));
                if (!parsed?.canonicalPath || typeof parsed.canonicalPath !== 'string') {
                    continue;
                }
                return normalizeStoredPath(resolveCanonicalPath(workspacePath, parsed.canonicalPath));
            } catch {
                // Ignore malformed legacy config candidates
            }
        }

        return null;
    }

    private getWorkspacePath(): string {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
            throw new Error('Open a workspace folder before using Instruction Sync.');
        }
        return workspacePath;
    }

    private isPathInWorkspace(workspacePath: string, candidatePath: string): boolean {
        const relativePath = path.relative(workspacePath, candidatePath);
        return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
    }

    private async readOptionalTextFile(filePath: string): Promise<string | null> {
        try {
            return await fs.promises.readFile(filePath, 'utf8');
        } catch (error: unknown) {
            const fsError = error as NodeJS.ErrnoException;
            if (fsError && fsError.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }
}
