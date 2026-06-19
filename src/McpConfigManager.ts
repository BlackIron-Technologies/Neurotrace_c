import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { BackendDownloader, getPersistentBackendExecutablePath, getPersistentBackendInstallRoot } from './BackendDownloader';
import { ensureCopilotInstructions } from './McpServerManager';
import { NEUROTRACE_WORKFLOW_LINES } from './workflowContent';

type GenerateMcpOptions = {
    silent?: boolean;
    overwrite?: boolean;
};

export type CodexUnlockTerminalLaunch = {
    name: string;
    shellPath: string;
    shellArgs: string[];
    cwd: string;
};

const MCP_FILE_PATHS = [
    path.join('claude', 'claude.mcp.json'),
    path.join('cursor', 'cursor.mcp.json'),
    path.join('cline', 'cline.mcp.json'),
    path.join('windsurf', 'windsurf.mcp.json'),
    path.join('grok', 'grok.config.toml'),
    path.join('codex', 'codex.windows.config.toml'),
    path.join('codex', 'codex.unix.config.toml'),
    path.join('codex', 'codex.wsl.config.toml'),
    path.join('codex', 'codex.config.toml'),
    'README.md',
];

const CURSOR_RULE_RELATIVE_PATH = path.join('.cursor', 'rules', 'neurotrace.mdc');
const AGENTS_MD_FILENAME = 'AGENTS.md';
const WORKSPACE_FOLDER_TOKEN = '${workspaceFolder}';
const CLAUDE_PROJECT_DIR_TOKEN = '${CLAUDE_PROJECT_DIR:-.}';
const CODEX_MCP_MARKER_START = '# BEGIN NEUROTRACE MCP';
const CODEX_MCP_MARKER_END = '# END NEUROTRACE MCP';
const NEUROTRACE_AGENTS_START = '<!-- neurotrace-start -->';
const NEUROTRACE_AGENTS_END = '<!-- neurotrace-end -->';
const NEUROTRACE_COPILOT_MEMORY_START = '<!-- neurotrace-copilot-memory:start -->';
const NEUROTRACE_COPILOT_MEMORY_END = '<!-- neurotrace-copilot-memory:end -->';

function isCursorHost(): boolean {
    return Boolean((vscode as any).cursor?.mcp) || vscode.env.appName.toLowerCase().includes('cursor');
}

function isVsCodeHost(): boolean {
    return !isCursorHost() && vscode.env.appName.toLowerCase().includes('visual studio code');
}

function getVsCodeSettingsProductDir(): string {
    const appName = vscode.env.appName.toLowerCase();
    if (appName.includes('insiders')) {
        return 'Code - Insiders';
    }

    return 'Code';
}

function getCopilotGlobalMemoryPath(): string | null {
    const productDir = getVsCodeSettingsProductDir();

    switch (os.platform()) {
        case 'win32': {
            const appDataDir = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
            return path.join(
                appDataDir,
                productDir,
                'User',
                'globalStorage',
                'github.copilot-chat',
                'memory-tool',
                'memories',
                'neurotrace.md'
            );
        }
        case 'darwin':
            return path.join(
                os.homedir(),
                'Library',
                'Application Support',
                productDir,
                'User',
                'globalStorage',
                'github.copilot-chat',
                'memory-tool',
                'memories',
                'neurotrace.md'
            );
        case 'linux': {
            const configDir = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
            return path.join(
                configDir,
                productDir,
                'User',
                'globalStorage',
                'github.copilot-chat',
                'memory-tool',
                'memories',
                'neurotrace.md'
            );
        }
        default:
            return null;
    }
}

function toForwardSlashes(input: string): string {
    return input.replace(/\\/g, '/');
}

function toWslPath(input: string): string {
    if (input.startsWith('/')) {
        return input;
    }

    const match = input.match(/^([A-Za-z]):[\\/](.*)$/);
    if (!match) {
        return toForwardSlashes(input);
    }

    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
}

function getWorkspacePath(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function buildStdioMcpConfig(exePath: string, workspaceArg: string, extraArgs: string[] = []) {
    return {
        mcpServers: {
            neurotrace: {
                command: exePath,
                args: ['--mcp', '--workspace', workspaceArg, ...extraArgs],
            },
        },
    };
}

function buildCodexToml(command: string, args: string[]): string {
    return [
        '[mcp_servers.neurotrace]',
        `command = ${quoteTomlString(command)}`,
        `args = [${args.map(quoteTomlString).join(', ')}]`,
        'startup_timeout_sec = 45',
        'tool_timeout_sec = 120',
        'enabled = true',
        '',
    ].join('\n');
}

function quoteTomlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildGrokToml(command: string, workspaceArg: string): string {
    return [
        '[mcp_servers.neurotrace]',
        `command = ${quoteTomlString(command)}`,
        `args = [${['--mcp', '--workspace', workspaceArg].map(quoteTomlString).join(', ')}]`,
        'startup_timeout_sec = 45',
        'tool_timeout_sec = 120',
        'enabled = true',
        '',
    ].join('\n');
}

function quoteBashArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildCodexWindowsToml(exePath: string, workspacePath: string): string {
    const normalizedExe = toForwardSlashes(exePath);
    const normalizedWorkspace = toForwardSlashes(workspacePath);

    return buildCodexToml(normalizedExe, ['--mcp', '--workspace', normalizedWorkspace]);
}

function buildCodexWslToml(commandPath: string, workspacePath: string): string {
    const wslCommand = toWslPath(commandPath);
    const wslWorkspace = toWslPath(workspacePath);
    const isPythonScript = wslCommand.endsWith('.py');

    return buildCodexToml(
        isPythonScript ? 'python3' : wslCommand,
        isPythonScript
            ? [wslCommand, '--mcp', '--workspace', wslWorkspace]
            : ['--mcp', '--workspace', wslWorkspace]
    );
}

function buildCodexWindowsViaWslToml(commandPath: string, workspacePath: string): string {
    const wslCommand = toWslPath(commandPath);
    const wslWorkspace = toWslPath(workspacePath);
    const isPythonScript = wslCommand.endsWith('.py');
    const launchCommand = isPythonScript
        ? `python3 ${quoteBashArg(wslCommand)} --mcp --workspace ${quoteBashArg(wslWorkspace)}`
        : `${quoteBashArg(wslCommand)} --mcp --workspace ${quoteBashArg(wslWorkspace)}`;

    return buildCodexToml('wsl.exe', ['bash', '-lc', launchCommand]);
}

function isCodexInstalledInWsl(): boolean {
    if (os.platform() !== 'win32') {
        return false;
    }

    const result = spawnSync('wsl.exe', ['bash', '-lc', 'command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]'], {
        encoding: 'utf8'
    });
    return result.status === 0;
}

async function resolveCodexWslCommandPath(context: vscode.ExtensionContext): Promise<string> {
    const pythonScriptPath = vscode.Uri.joinPath(context.extensionUri, 'bin', 'neurotrace.py').fsPath;
    if (os.platform() !== 'win32' || !isCodexInstalledInWsl()) {
        return pythonScriptPath;
    }

    const backendDownloader = new BackendDownloader(context);
    const wslBackendPath = await backendDownloader.ensureCodexWslBackend();
    return wslBackendPath ?? pythonScriptPath;
}

export async function getCodexUnlockTerminalLaunch(
    context: vscode.ExtensionContext
): Promise<CodexUnlockTerminalLaunch | null> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return null;
    }

    const codexUsesWsl = os.platform() === 'win32' && isCodexInstalledInWsl();
    if (codexUsesWsl) {
        const commandPath = await resolveCodexWslCommandPath(context);
        const wslCommand = toWslPath(commandPath);
        const wslWorkspace = toWslPath(workspacePath);
        const launchCommand = wslCommand.endsWith('.py')
            ? `python3 ${quoteBashArg(wslCommand)} --unlock --workspace ${quoteBashArg(wslWorkspace)}`
            : `${quoteBashArg(wslCommand)} --unlock --workspace ${quoteBashArg(wslWorkspace)}`;

        return {
            name: 'NeuroTrace Codex Unlock',
            shellPath: 'wsl.exe',
            shellArgs: ['bash', '-lc', launchCommand],
            cwd: workspacePath,
        };
    }

    const backendDownloader = new BackendDownloader(context);
    const commandPath = backendDownloader.getBackendPath();
    if (!commandPath) {
        return null;
    }

    if (commandPath.endsWith('.py')) {
        return {
            name: 'NeuroTrace Codex Unlock',
            shellPath: os.platform() === 'win32' ? 'py' : 'python3',
            shellArgs: os.platform() === 'win32'
                ? ['-3', commandPath, '--unlock', '--workspace', workspacePath]
                : [commandPath, '--unlock', '--workspace', workspacePath],
            cwd: workspacePath,
        };
    }

    return {
        name: 'NeuroTrace Codex Unlock',
        shellPath: commandPath,
        shellArgs: ['--unlock', '--workspace', workspacePath],
        cwd: workspacePath,
    };
}

function buildAgentsReadme(workspacePath: string, claudeConfigJson: string, exePath: string): string {
    const normalizedWorkspace = toForwardSlashes(workspacePath);
    const isCursor = isCursorHost();
    const claudeTemplate = claudeConfigJson.trimEnd();
    const claudeServerBlock = JSON.stringify({
        command: exePath,
        args: ['--mcp', '--workspace', CLAUDE_PROJECT_DIR_TOKEN],
    });

    return [
        '# NeuroTrace MCP Agent Guide',
        '',
        'This folder contains ready-to-use MCP config templates generated by NeuroTrace.',
        'NeuroTrace auto-configures supported hosts where possible, and this folder serves as the detailed guide plus manual fallback for external MCP clients.',
        '',
        '## Files',
        '- `claude/`: Claude Code MCP JSON template.',
        '- `codex/`: Codex templates and compatibility aliases.',
        '- `cursor/`: Cursor MCP JSON template.',
        '- `cline/`: Cline MCP JSON template.',
        '- `windsurf/`: Windsurf MCP JSON template.',
        '- `grok/`: Grok MCP TOML template.',
        '- `claude/claude.mcp.json`: MCP JSON template for Claude Code global config using `${CLAUDE_PROJECT_DIR:-.}`.',
        '- `codex/codex.windows.config.toml`: Codex template for Windows hosts. If Codex is sandboxed in WSL, this template launches NeuroTrace through `wsl.exe`.',
        '- `codex/codex.unix.config.toml`: Codex template for macOS, Linux, and WSL.',
        '- `codex/codex.wsl.config.toml`: Compatibility alias to the Unix Codex template.',
        '- `codex/codex.config.toml`: Compatibility alias to the Windows Codex template.',
        '- `cursor/cursor.mcp.json`: MCP JSON template for global Cursor MCP config using `${workspaceFolder}`.',
        '- `cline/cline.mcp.json`: MCP JSON template for global Cline MCP config using `${workspaceFolder}`.',
        '- `windsurf/windsurf.mcp.json`: MCP JSON template for Windsurf. Uses the current workspace path because Windsurf does not reliably expand `${workspaceFolder}` in MCP args.',
        '- `grok/grok.config.toml`: MCP TOML template for Grok global or project config.',
        ...(isCursor ? ['- `.cursor/rules/neurotrace.mdc`: Cursor rule that teaches the agent to use NeuroTrace tools before coding.'] : []),
        ...(!isCursor ? ['- `.github/copilot-instructions.md`: VS Code Copilot instructions that teach the agent to use NeuroTrace naturally.'] : []),
        '',
        '## Workspace',
        `- Current workspace: \`${normalizedWorkspace}\``,
        '',
        '## Quick Setup (Codex)',
        '1. NeuroTrace auto-rebinds the global Codex MCP entry to the current workspace from the active IDE window when supported.',
        '2. If Codex is not yet configured correctly, open `~/.codex/config.toml` and copy the matching template from the `codex/` subfolder:',
        '   - Use `codex/codex.windows.config.toml` on Windows hosts. If Codex is WSL-sandboxed, this template wraps the WSL backend via `wsl.exe`.',
        '   - Use `codex/codex.unix.config.toml` if Codex runs directly on macOS, Linux, or WSL.',
        '3. Run `codex mcp list` to verify server discovery.',
        '4. Validate with a real tool call such as `neurotrace_getDatabaseStatus`.',
        '5. Codex currently supports only one active NeuroTrace workspace at a time through the global MCP entry.',
        '6. If another IDE window takes control, return to this repo and reload that IDE window to rebind Codex back to this workspace.',
        '7. If you prefer, you can ask your coding agent to configure Codex automatically by telling it to copy the appropriate NeuroTrace template from `.neurotrace/mcp/codex/` into the active Codex config.',
        '',
        '## Note',
        'NeuroTrace is a tool-first MCP server.',
        'It primarily exposes `tools` and may not expose static `resources/templates`.',
        'If `resources/templates` appears empty in Codex, this is expected behavior.',
        'Use `tools/list` and a real tool call to validate connectivity.',
        '',
        '## Quick Setup (Cursor/Cline/Windsurf)',
        '1. Cursor support is auto-configured by NeuroTrace in supported environments, and the generated files here document the effective setup.',
        '2. For Cline, Windsurf, or any manual MCP flow, open your client MCP config file.',
        '3. Paste the corresponding JSON from that client\'s subfolder.',
        '4. Restart the client and verify NeuroTrace tools are available.',
        '',
        '### Global MCP Config (Claude Code - Recommended)',
        'For Claude, NeuroTrace recommends configuring the server at **global (user) scope**.',
        'Claude Code shares the same `~/.claude.json` across all of its surfaces - the `claude` CLI, the IDE extension (VS Code / JetBrains), and the desktop app - so a single global entry makes NeuroTrace available everywhere without per-project setup.',
        '',
        '**Exact global template** (also saved as `claude/claude.mcp.json`):',
        '',
        '```json',
        claudeTemplate,
        '```',
        '',
        '- It uses `"--workspace", "${CLAUDE_PROJECT_DIR:-.}"`, and Claude Code sets `CLAUDE_PROJECT_DIR` for local stdio MCP servers, so this one global entry follows whatever project you open.',
        '- In a repo without NeuroTrace initialized, the tools still load and `neurotrace_getDatabaseStatus` returns `no_database` cleanly.',
        '',
        '**Official config location (user scope) - per Claude Code docs:**',
        '- Windows: `C:\\Users\\<you>\\.claude.json` (`%USERPROFILE%\\.claude.json`)',
        '- macOS / Linux: `~/.claude.json`',
        '- The `neurotrace` entry goes under the top-level `"mcpServers"` object, not under a specific `projects` entry.',
        '',
        '**Two ways to apply it:**',
        '1. CLI (recommended) - run `claude mcp add-json` with the inner server block and `--scope user`:',
        '   ```bash',
        `   claude mcp add-json neurotrace '${claudeServerBlock}' --scope user`,
        '   ```',
        '2. Manual - open the `~/.claude.json` path above and merge the full `claude/claude.mcp.json` content into the top-level `"mcpServers"` object, then restart or reload Claude Code.',
        '',
        'Verify with `claude mcp list` (CLI) or by reloading and making a real tool call such as `neurotrace_getDatabaseStatus`.',
        '',
        '### Global MCP Config (Cursor - Recommended)',
        '- Add the `cursor/cursor.mcp.json` content under the global `mcpServers` section in Cursor User Settings.',
        '- Use `"--workspace", "${workspaceFolder}"` so NeuroTrace MCP tools are available in any project you open.',
        '- In Cursor, NeuroTrace uses a localhost bridge to the backend started by the NeuroTrace extension in that same Cursor window for encrypted databases.',
        '- If the database is encrypted, open the NeuroTrace sidebar in Cursor and unlock it there before using MCP tools.',
        '',
        '### Global MCP Config (Cline)',
        '- `cline/cline.mcp.json` is generated the same way, using `"--workspace", "${workspaceFolder}"` for global reuse across projects.',
        '',
        '### Windsurf Note',
        '- `windsurf/windsurf.mcp.json` stays workspace-specific because Windsurf does not reliably expand `${workspaceFolder}` in MCP arguments.',
        '',
        '### Global MCP Config (Grok)',
        '- NeuroTrace auto-upserts `~/.grok/config.toml` with `[mcp_servers.neurotrace]` and enables `[memory] enabled = true` so Grok can discover the MCP tools and its own memory on new sessions.',
        '- The generated `grok/grok.config.toml` can also be copied into a project `.grok/config.toml` if you want a repository-scoped override.',
        '- NeuroTrace also updates `~/.grok/memory/MEMORY.md` with the same workflow block used by Codex and Claude.',
        '',
        '### Codex Standalone Behavior',
        '- The generated Codex templates launch NeuroTrace directly for this workspace instead of depending on the IDE bridge.',
        '- Codex keeps its own local NeuroTrace daemon session for the workspace on the host where Codex is running.',
        '- If the database is encrypted, unlock it on that same host with `neurotrace --unlock --workspace <workspace>` in an external terminal outside the chat.',
        '- For Codex, the global MCP binding is effectively single-workspace: the last reloaded NeuroTrace window takes control.',
        '',
        ...(isCursor
            ? [
                '### Cursor Project Rule',
                '- NeuroTrace also generates `.cursor/rules/neurotrace.mdc` alongside these MCP files.',
                '- This gives Cursor a project rule that reminds the agent to check NeuroTrace before coding and to record important decisions afterwards.',
                '',
            ]
            : []),
        ...(!isCursor
            ? [
                '### VS Code Copilot Instructions',
                '- NeuroTrace also generates `.github/copilot-instructions.md` alongside these MCP files when running inside VS Code.',
                '- This gives Copilot persistent workspace instructions so using NeuroTrace becomes part of its natural workflow.',
                '',
            ]
            : []),
        '### AGENTS.md (Universal)',
        '- NeuroTrace generates or updates an `AGENTS.md` file at the workspace root.',
        '- This is the universal standard read by Cursor, GitHub Copilot, Claude Code, Codex CLI, and other AI agents.',
        '- The NeuroTrace section is delimited with `<!-- neurotrace-start -->` / `<!-- neurotrace-end -->` markers so it can be updated without overwriting your own content.',
        '',
        '## Recommended Prompt for New Chats',
        'Use this at the beginning of each coding session:',
        '',
        '```text',
        'Before coding, use NeuroTrace MCP tools:',
        '1) neurotrace_getDatabaseStatus',
        '2) If you know the file/module: neurotrace_getMemoriesByFile',
        '3) If the problem is fuzzy: neurotrace_semanticSearch for: "<topic>"',
        '4) neurotrace_searchThoughts to refine exact terms, names, or IDs',
        'Then propose a plan based on this context.',
        '```',
        '',
        '## Troubleshooting',
        '- If you get `no_database`, initialize NeuroTrace in the workspace first.',
        '- If you get `database_locked` in Codex, run `neurotrace --unlock --workspace <workspace>` in an external terminal on that host, outside the chat.',
        '- If you get `database_locked` in the IDE, unlock the database from the NeuroTrace sidebar.',
        '- If Cursor reports `bridge_unavailable`, open the NeuroTrace sidebar in Cursor and wait for the backend to start in that window.',
        '- If startup fails, verify the executable path in the generated files.',
        '- If Codex on Windows is WSL-sandboxed, the Windows template should invoke `wsl.exe` rather than a native Windows backend path.',
        '- If Codex runs directly on macOS, Linux, or WSL but you used the Windows template, switch to `codex/codex.unix.config.toml`.',
        '- If Codex is writing to the wrong repo, reload the IDE window for the repo you want to control Codex and start a fresh Codex chat/session.',
        '',
    ].join('\n');
}

function migrateLegacyMcpLayout(outputDir: string): void {
    const legacyToCurrent = new Map<string, string>([
        ['cursor.mcp.json', path.join('cursor', 'cursor.mcp.json')],
        ['cline.mcp.json', path.join('cline', 'cline.mcp.json')],
        ['windsurf.mcp.json', path.join('windsurf', 'windsurf.mcp.json')],
        ['codex.windows.config.toml', path.join('codex', 'codex.windows.config.toml')],
        ['codex.unix.config.toml', path.join('codex', 'codex.unix.config.toml')],
        ['codex.wsl.config.toml', path.join('codex', 'codex.wsl.config.toml')],
        ['codex.config.toml', path.join('codex', 'codex.config.toml')],
    ]);

    for (const [legacyName, currentRelativePath] of legacyToCurrent.entries()) {
        const legacyPath = path.join(outputDir, legacyName);
        const currentPath = path.join(outputDir, currentRelativePath);

        if (!fs.existsSync(legacyPath)) {
            continue;
        }

        fs.mkdirSync(path.dirname(currentPath), { recursive: true });
        if (!fs.existsSync(currentPath)) {
            fs.renameSync(legacyPath, currentPath);
            continue;
        }

        fs.unlinkSync(legacyPath);
    }

    for (const obsoleteFile of ['neurotrace-codex-wrapper.cmd', 'neurotrace-codex-wrapper.sh', 'neurotrace-codex-proxy.py']) {
        const obsoletePath = path.join(outputDir, obsoleteFile);
        if (fs.existsSync(obsoletePath)) {
            fs.unlinkSync(obsoletePath);
        }
    }
}

function upsertTomlBlock(existing: string, block: string): string {
    const normalized = existing.replace(/\r\n/g, '\n');
    const pattern = new RegExp(`${CODEX_MCP_MARKER_START}[\\s\\S]*?${CODEX_MCP_MARKER_END}\\n?`, 'm');
    const replacement = `${CODEX_MCP_MARKER_START}\n${block}\n${CODEX_MCP_MARKER_END}\n`;

    if (pattern.test(normalized)) {
        return normalized.replace(pattern, replacement);
    }

    const trimmed = normalized.trimEnd();
    return trimmed ? `${trimmed}\n\n${replacement}` : replacement;
}

async function syncCodexGlobalConfig(context: vscode.ExtensionContext, workspacePath: string, exePath: string): Promise<void> {
    const codexDir = path.join(os.homedir(), '.codex');
    const codexConfigPath = path.join(codexDir, 'config.toml');
    fs.mkdirSync(codexDir, { recursive: true });

    const wslCommandPath = await resolveCodexWslCommandPath(context);
    const codexUsesWsl = os.platform() === 'win32' && isCodexInstalledInWsl();
    const block = os.platform() === 'win32'
        ? (codexUsesWsl
            ? buildCodexWindowsViaWslToml(wslCommandPath, workspacePath)
            : buildCodexWindowsToml(exePath, workspacePath)).trimEnd()
        : buildCodexWslToml(wslCommandPath, workspacePath).trimEnd();

    const existing = fs.existsSync(codexConfigPath) ? fs.readFileSync(codexConfigPath, 'utf8') : '';
    const updated = upsertTomlBlock(existing, block);
    fs.writeFileSync(codexConfigPath, updated, 'utf8');

    if (os.platform() !== 'win32' || !codexUsesWsl) {
        return;
    }

    const wslBlock = buildCodexWslToml(wslCommandPath, workspacePath).trimEnd();
    const readScript = [
        'python3 - <<\'PY\'',
        'from pathlib import Path',
        'import sys',
        'p = Path.home() / ".codex" / "config.toml"',
        'sys.stdout.write(p.read_text(encoding="utf-8") if p.exists() else "")',
        'PY',
    ].join('\n');

    const readResult = spawnSync('wsl.exe', ['bash', '-lc', readScript], { encoding: 'utf8' });
    if (readResult.status !== 0) {
        return;
    }

    const wslUpdated = upsertTomlBlock(readResult.stdout ?? '', wslBlock);
    const encoded = Buffer.from(wslUpdated, 'utf8').toString('base64');
    const writeScript = [
        'python3 - <<\'PY\'',
        'from pathlib import Path',
        'import base64',
        `content = base64.b64decode('${encoded}').decode('utf-8')`,
        'p = Path.home() / ".codex" / "config.toml"',
        'p.parent.mkdir(parents=True, exist_ok=True)',
        'p.write_text(content, encoding="utf-8")',
        'PY',
    ].join('\n');

    spawnSync('wsl.exe', ['bash', '-lc', writeScript], { encoding: 'utf8' });
}

/**
 * Resolves the backend executable that actually exists on disk and can be
 * launched right now by an external MCP client. Prefers the stable per-user
 * install path, then bundled and legacy locations. Unlike
 * getMcpBackendExecutablePath (which targets long-lived templates), this never
 * returns a path that does not yet exist on disk.
 */
function getRunnableBackendExecutablePath(context: vscode.ExtensionContext): string | null {
    return getBackendExecutablePath(context);
}

/**
 * Auto-registers NeuroTrace as a global (user-scope) MCP server in Claude Code
 * by upserting the `neurotrace` entry in ~/.claude.json. Claude Code's CLI, IDE
 * extension, and desktop app all read this file, so a single entry makes
 * NeuroTrace plug-and-play across every project the user opens. Uses
 * `${CLAUDE_PROJECT_DIR:-.}` so the same entry follows the active workspace.
 *
 * Idempotent and non-destructive: it preserves all other keys, skips the write
 * when the entry already matches (so it self-heals if the backend path changes,
 * e.g. after a download migrates the binary), and bails out safely if the file
 * exists but is not valid JSON so a corrupted/locked file is never clobbered.
 */
export function syncClaudeGlobalConfig(context: vscode.ExtensionContext): void {
    try {
        const exePath = getRunnableBackendExecutablePath(context);
        if (!exePath) {
            return;
        }

        const claudeConfigPath = path.join(os.homedir(), '.claude.json');

        let config: any = {};
        if (fs.existsSync(claudeConfigPath)) {
            try {
                config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'));
            } catch {
                console.error('NeuroTrace MCP: ~/.claude.json is not valid JSON, skipping Claude auto-config');
                return;
            }
        }

        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            return;
        }

        if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
            config.mcpServers = {};
        }

        const desired = {
            command: exePath,
            args: ['--mcp', '--workspace', CLAUDE_PROJECT_DIR_TOKEN],
        };

        const current = config.mcpServers.neurotrace;
        if (current && JSON.stringify(current) === JSON.stringify(desired)) {
            return;
        }

        config.mcpServers.neurotrace = desired;
        fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
        console.log('NeuroTrace MCP: Registered global Claude Code MCP server in ~/.claude.json');
    } catch (error) {
        console.error('NeuroTrace MCP: Error syncing ~/.claude.json:', error);
    }
}

function upsertJsonMcpServer(configPath: string, serverName: string, serverConfig: any, label: string): void {
    let config: any = {};
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch {
            console.error(`NeuroTrace MCP: ${label} is not valid JSON, skipping Cursor auto-config`);
            return;
        }
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return;
    }

    if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
        config.mcpServers = {};
    }

    const current = config.mcpServers[serverName];
    if (current && JSON.stringify(current) === JSON.stringify(serverConfig)) {
        return;
    }

    config.mcpServers[serverName] = serverConfig;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    console.log(`NeuroTrace MCP: Registered Cursor MCP server in ${label}`);
}

function getCursorUserSettingsPath(): string | null {
    switch (os.platform()) {
        case 'win32': {
            const appDataDir = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
            return path.join(appDataDir, 'Cursor', 'User', 'settings.json');
        }
        case 'darwin':
            return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json');
        case 'linux': {
            const configDir = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
            return path.join(configDir, 'Cursor', 'User', 'settings.json');
        }
        default:
            return null;
    }
}

/**
 * Auto-registers NeuroTrace in Cursor's persistent MCP config. Cursor supports
 * a user-level ~/.cursor/mcp.json, while older/current installs may also keep
 * MCP servers under Cursor User settings. Keep both in sync so stale legacy
 * backend paths self-heal after backend migration.
 */
export function syncCursorGlobalConfig(context: vscode.ExtensionContext): void {
    try {
        const exePath = getRunnableBackendExecutablePath(context);
        if (!exePath) {
            return;
        }

        const desired = {
            command: exePath,
            args: ['--mcp', '--workspace', WORKSPACE_FOLDER_TOKEN, '--bridge-required'],
        };

        upsertJsonMcpServer(
            path.join(os.homedir(), '.cursor', 'mcp.json'),
            'neurotrace',
            desired,
            '~/.cursor/mcp.json'
        );

        const cursorSettingsPath = getCursorUserSettingsPath();
        if (cursorSettingsPath) {
            upsertJsonMcpServer(
                cursorSettingsPath,
                'neurotrace',
                desired,
                'Cursor User settings.json'
            );
        }
    } catch (error) {
        console.error('NeuroTrace MCP: Error syncing Cursor MCP config:', error);
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertTomlTable(content: string, tableName: string, tableContent: string): string {
    const normalizedBlock = tableContent.trimEnd() + '\n';
    const tablePattern = new RegExp(
        `(^|\\n)\\[${escapeRegExp(tableName)}\\][\\s\\S]*?(?=\\n\\[[^\\]]+\\]|$)`
    );

    if (tablePattern.test(content)) {
        return content.replace(tablePattern, (match, prefix: string) => `${prefix}${normalizedBlock.trimEnd()}`);
    }

    const trimmed = content.trimEnd();
    return `${trimmed}${trimmed ? '\n\n' : ''}${normalizedBlock}`;
}

function upsertTomlScalarInTable(content: string, tableName: string, key: string, value: string): string {
    const tablePattern = new RegExp(
        `(^|\\n)(\\[${escapeRegExp(tableName)}\\]\\n)([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|$)`
    );

    if (!tablePattern.test(content)) {
        const trimmed = content.trimEnd();
        return `${trimmed}${trimmed ? '\n\n' : ''}[${tableName}]\n${key} = ${value}\n`;
    }

    return content.replace(tablePattern, (match, prefix: string, header: string, body: string) => {
        const keyPattern = new RegExp(`(^|\\n)${escapeRegExp(key)}\\s*=.*(?=\\n|$)`);
        const trimmedBody = body.trimEnd();
        const updatedBody = keyPattern.test(trimmedBody)
            ? trimmedBody.replace(keyPattern, (keyMatch, keyPrefix: string) => `${keyPrefix}${key} = ${value}`)
            : `${trimmedBody}${trimmedBody ? '\n' : ''}${key} = ${value}`;

        return `${prefix}${header}${updatedBody}`;
    });
}

/**
 * Auto-registers NeuroTrace in Grok's user-level config. Grok supports global
 * MCP servers in ~/.grok/config.toml and project overrides in .grok/config.toml.
 * The global entry uses "." so the backend resolves the active Grok working
 * directory at launch time.
 */
export function syncGrokGlobalConfig(context: vscode.ExtensionContext): void {
    try {
        const exePath = getRunnableBackendExecutablePath(context);
        if (!exePath) {
            return;
        }

        const grokConfigPath = path.join(os.homedir(), '.grok', 'config.toml');
        const existing = fs.existsSync(grokConfigPath) ? fs.readFileSync(grokConfigPath, 'utf8') : '';
        let updated = upsertTomlTable(existing, 'mcp_servers.neurotrace', buildGrokToml(exePath, '.'));
        updated = upsertTomlScalarInTable(updated, 'memory', 'enabled', 'true');

        if (updated === existing) {
            return;
        }

        fs.mkdirSync(path.dirname(grokConfigPath), { recursive: true });
        fs.writeFileSync(grokConfigPath, updated, 'utf8');
        console.log('NeuroTrace MCP: Registered global Grok MCP server in ~/.grok/config.toml');
    } catch (error) {
        console.error('NeuroTrace MCP: Error syncing Grok MCP config:', error);
    }
}

function updateCursorRule(_context: vscode.ExtensionContext, workspacePath: string): void {
    if (!isCursorHost()) { return; }

    const rulePath = path.join(workspacePath, CURSOR_RULE_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(rulePath), { recursive: true });
    fs.writeFileSync(rulePath, buildCursorRule(), 'utf8');
}

function buildCursorRule(): string {
    return [
        '---',
        'description: Use NeuroTrace MCP tools before coding',
        'alwaysApply: true',
        '---',
        '',
        '# NeuroTrace Workflow',
        '',
        ...NEUROTRACE_WORKFLOW_LINES,
        '',
    ].join('\n');
}

function buildNeuroTraceAgentsSection(): string {
    return [
        NEUROTRACE_AGENTS_START,
        '## NeuroTrace Workflow',
        '',
        ...NEUROTRACE_WORKFLOW_LINES,
        NEUROTRACE_AGENTS_END,
    ].join('\n');
}

function buildCopilotGlobalMemorySection(): string {
    return [
        NEUROTRACE_COPILOT_MEMORY_START,
        '# NeuroTrace',
        '',
        'Use NeuroTrace as the first context source for repository-aware coding work.',
        '',
        '## Default Workflow',
        '',
        ...NEUROTRACE_WORKFLOW_LINES,
        NEUROTRACE_COPILOT_MEMORY_END,
    ].join('\n');
}

function ensureAgentsSectionAtPath(agentsMdPath: string, defaultTitle: string): void {
    const section = buildNeuroTraceAgentsSection();
    fs.mkdirSync(path.dirname(agentsMdPath), { recursive: true });

    if (!fs.existsSync(agentsMdPath)) {
        fs.writeFileSync(agentsMdPath, `${defaultTitle}\n\n${section}\n`, 'utf-8');
        return;
    }

    const content = fs.readFileSync(agentsMdPath, 'utf-8');
    if (content.includes(NEUROTRACE_AGENTS_START)) {
        const startIdx = content.indexOf(NEUROTRACE_AGENTS_START);
        const endIdx = content.indexOf(NEUROTRACE_AGENTS_END);
        if (endIdx === -1) {
            return;
        }
        const updated =
            content.substring(0, startIdx) +
            section +
            content.substring(endIdx + NEUROTRACE_AGENTS_END.length);
        fs.writeFileSync(agentsMdPath, updated, 'utf-8');
        return;
    }

    const trimmed = content.trimEnd();
    const prefix = trimmed || defaultTitle;
    fs.writeFileSync(agentsMdPath, `${prefix}\n\n${section}\n`, 'utf-8');
}

/**
 * Ensures an AGENTS.md file at the workspace root contains the NeuroTrace
 * workflow section. Creates the file if missing, appends or updates the
 * delimited block without overwriting user content.
 */
function ensureAgentsMd(_context: vscode.ExtensionContext, workspacePath: string): void {
    try {
        const agentsMdPath = path.join(workspacePath, AGENTS_MD_FILENAME);
        ensureAgentsSectionAtPath(agentsMdPath, '# AGENTS');
        console.log('NeuroTrace: AGENTS.md ensured at workspace root');
    } catch (error) {
        console.error('NeuroTrace: Error ensuring AGENTS.md:', error);
    }
}

export function ensureCodexGlobalAgentsMd(): void {
    try {
        const codexAgentsPath = path.join(os.homedir(), '.codex', AGENTS_MD_FILENAME);
        ensureAgentsSectionAtPath(codexAgentsPath, '# AGENTS');
        console.log('NeuroTrace: Codex global AGENTS.md ensured');
    } catch (error) {
        console.error('NeuroTrace: Error ensuring Codex global AGENTS.md:', error);
    }
}

export function ensureClaudeUserMemoryMd(): void {
    try {
        const claudeMemoryPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
        ensureAgentsSectionAtPath(claudeMemoryPath, '# CLAUDE');
        console.log('NeuroTrace: Claude user CLAUDE.md ensured');
    } catch (error) {
        console.error('NeuroTrace: Error ensuring Claude user CLAUDE.md:', error);
    }
}

export function ensureGrokGlobalMemoryMd(): void {
    try {
        const grokMemoryPath = path.join(os.homedir(), '.grok', 'memory', 'MEMORY.md');
        ensureAgentsSectionAtPath(grokMemoryPath, '# MEMORY');
        console.log('NeuroTrace: Grok global MEMORY.md ensured');
    } catch (error) {
        console.error('NeuroTrace: Error ensuring Grok global MEMORY.md:', error);
    }
}

function ensureCopilotGlobalMemory(): void {
    if (!isVsCodeHost()) {
        return;
    }

    try {
        const memoryPath = getCopilotGlobalMemoryPath();
        if (!memoryPath) {
            return;
        }

        const section = buildCopilotGlobalMemorySection();
        fs.mkdirSync(path.dirname(memoryPath), { recursive: true });

        if (fs.existsSync(memoryPath)) {
            const content = fs.readFileSync(memoryPath, 'utf8');

            if (content.includes(NEUROTRACE_COPILOT_MEMORY_START)) {
                const startIdx = content.indexOf(NEUROTRACE_COPILOT_MEMORY_START);
                const endIdx = content.indexOf(NEUROTRACE_COPILOT_MEMORY_END);
                if (endIdx === -1) {
                    return;
                }

                const updated =
                    content.substring(0, startIdx) +
                    section +
                    content.substring(endIdx + NEUROTRACE_COPILOT_MEMORY_END.length);
                fs.writeFileSync(memoryPath, updated, 'utf8');
            } else {
                const separator = content.endsWith('\n') ? '\n' : '\n\n';
                fs.writeFileSync(memoryPath, content + separator + section + '\n', 'utf8');
            }
        } else {
            fs.writeFileSync(memoryPath, `${section}\n`, 'utf8');
        }

        console.log('NeuroTrace: Copilot global memory ensured');
    } catch (error) {
        console.error('NeuroTrace: Error ensuring Copilot global memory:', error);
    }
}

/**
 * Resolves the path to the NeuroTrace backend executable.
 * Checks bundled paths first, then downloaded backend location.
 */
function getBackendExecutablePath(context: vscode.ExtensionContext): string | null {
    const platform = os.platform();
    const binPath = vscode.Uri.joinPath(context.extensionUri, 'bin').fsPath;
    const installPath = getPersistentBackendInstallRoot(platform);
    const storagePath = context.globalStorageUri.fsPath;

    // Check bundled executable first
    const platformMap: Record<string, { dir: string; exe: string }> = {
        win32: { dir: 'neurotrace-windows', exe: 'neurotrace.exe' },
        darwin: { dir: 'neurotrace-macos', exe: 'neurotrace' },
        linux: { dir: 'neurotrace-linux', exe: 'neurotrace' },
    };

    const info = platformMap[platform];
    if (!info) { return null; }

    const bundledCandidates = [
        path.join(binPath, 'dist', info.dir, info.exe),
    ];

    // Prefer the stable per-user install location used by external MCP agents.
    const downloadedCandidates = [
        path.join(installPath, info.dir, info.exe),
        path.join(installPath, info.exe),
        path.join(installPath, 'dist', info.dir, info.exe),
        path.join(installPath, `neurotrace-backend-${info.dir.replace('neurotrace-', '')}`, info.exe),
        // Legacy extension-private storage. Keep as fallback until the next
        // backend download migrates the executable to the persistent location.
        path.join(storagePath, info.dir, info.exe),
        path.join(storagePath, info.exe),
        path.join(storagePath, 'dist', info.dir, info.exe),
        path.join(storagePath, `neurotrace-backend-${info.dir.replace('neurotrace-', '')}`, info.exe),
    ];

    for (const candidate of [...bundledCandidates, ...downloadedCandidates]) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

function getMcpBackendExecutablePath(context: vscode.ExtensionContext): string | null {
    const platform = os.platform();
    const persistentPath = getPersistentBackendExecutablePath(platform);
    const downloadedPath = getBackendExecutablePath(context);
    if (downloadedPath && path.resolve(downloadedPath) === path.resolve(persistentPath)) {
        return downloadedPath;
    }

    // MCP templates are long-lived and should point at the stable install path
    // even before the next backend download has populated it.
    return persistentPath;
}

/**
 * Attempts to auto-register NeuroTrace as an MCP server in Cursor.
 * Uses Cursor's extension API: vscode.cursor.mcp.registerServer()
 * This is a no-op if not running inside Cursor.
 */
export function registerMcpForCursor(context: vscode.ExtensionContext): void {
    // Check if Cursor's MCP API is available
    const cursorApi = (vscode as any).cursor?.mcp;
    if (!cursorApi || typeof cursorApi.registerServer !== 'function') {
        return;
    }

    const exePath = getMcpBackendExecutablePath(context);
    if (!exePath) {
        console.log('NeuroTrace MCP: Backend not found, skipping Cursor registration');
        return;
    }

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
        console.log('NeuroTrace MCP: No workspace folder, skipping Cursor registration');
        return;
    }

    const dbPath = path.join(workspacePath, '.neurotrace', 'neurotrace.db');
    if (fs.existsSync(dbPath)) {
        void syncCodexGlobalConfig(context, workspacePath, exePath);
        syncCursorGlobalConfig(context);
        syncClaudeGlobalConfig(context);
        syncGrokGlobalConfig(context);
    }

    try {
        cursorApi.registerServer({
            name: 'neurotrace',
            server: {
                command: exePath,
                args: ['--mcp', '--workspace', workspacePath, '--bridge-required'],
                env: {},
            },
        });
        console.log('NeuroTrace MCP: Registered as MCP server in Cursor');
    } catch (err) {
        console.error('NeuroTrace MCP: Failed to register in Cursor:', err);
    }
}

/**
 * Command handler: generates MCP configuration JSON for external agents
 * (Cline, Claude Code, Windsurf, etc.) and shows it for the user to copy.
 */
export async function configureMcpForExternalAgents(context: vscode.ExtensionContext): Promise<void> {
    await generateMcpWorkspaceFiles(context, { silent: false, overwrite: true });

    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return;
    }

    const exePath = getMcpBackendExecutablePath(context);
    if (!exePath) {
        vscode.window.showErrorMessage(
            'NeuroTrace backend not found. Please download it first from the NeuroTrace sidebar.'
        );
        return;
    }

    const config = buildStdioMcpConfig(exePath, WORKSPACE_FOLDER_TOKEN);
    const claudeConfig = buildStdioMcpConfig(exePath, CLAUDE_PROJECT_DIR_TOKEN);

    const configJson = JSON.stringify(config, null, 2);
    const claudeConfigJson = JSON.stringify(claudeConfig, null, 2);

    // Show in a new untitled document so the user can copy it
    const doc = await vscode.workspace.openTextDocument({
        content: [
            '// NeuroTrace MCP Configuration',
            '// Copy the JSON below into your agent\'s MCP config file:',
            '//',
            '// Cursor:      .cursor/mcp.json',
            '// Cline:       .cline/mcp.json or cline_mcp_settings.json',
            '// Claude Code: ~/.claude.json (global) or .mcp.json (project)',
            '// Windsurf:    ~/.windsurf/mcp.json',
            '// Grok:        ~/.grok/config.toml (global) or .grok/config.toml (project)',
            '//',
            '// The "command" path points to the NeuroTrace backend already',
            '// downloaded on your machine. No additional installation needed.',
            '',
            '// Cursor / Cline generic template:',
            configJson,
            '',
            '// Claude Code global template:',
            claudeConfigJson,
            '',
            '// Grok TOML template:',
            buildGrokToml(exePath, '.'),
        ].join('\n'),
        language: 'jsonc',
    });
    await vscode.window.showTextDocument(doc);
}

/**
 * Generates ready-to-use MCP config files under .neurotrace/mcp/.
 * In silent mode, this is best-effort and shows no UI.
 */
export async function generateMcpWorkspaceFiles(
    context: vscode.ExtensionContext,
    options: GenerateMcpOptions = {}
): Promise<void> {
    const { silent = false, overwrite = true } = options;

    const exePath = getMcpBackendExecutablePath(context);
    if (!exePath) {
        if (!silent) {
            vscode.window.showErrorMessage(
                'NeuroTrace backend not found. Please download it first from the NeuroTrace sidebar.'
            );
        }
        return;
    }

    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        if (!silent) {
            vscode.window.showErrorMessage('No workspace folder is open.');
        }
        return;
    }

    const outputDir = path.join(workspacePath, '.neurotrace', 'mcp');
    fs.mkdirSync(outputDir, { recursive: true });
    migrateLegacyMcpLayout(outputDir);

    const claudeConfig = JSON.stringify(buildStdioMcpConfig(exePath, CLAUDE_PROJECT_DIR_TOKEN), null, 2) + '\n';
    const cursorConfig = JSON.stringify(buildStdioMcpConfig(exePath, WORKSPACE_FOLDER_TOKEN, ['--bridge-required']), null, 2) + '\n';
    const clineConfig = JSON.stringify(buildStdioMcpConfig(exePath, WORKSPACE_FOLDER_TOKEN), null, 2) + '\n';
    const windsurfConfig = JSON.stringify(buildStdioMcpConfig(exePath, workspacePath), null, 2) + '\n';
    const grokConfig = buildGrokToml(exePath, '.') + '\n';
    const wslCommandPath = await resolveCodexWslCommandPath(context);
    const codexWindowsToml = buildCodexWindowsToml(exePath, workspacePath);
    const codexWslToml = buildCodexWslToml(wslCommandPath, workspacePath);
    const agentsReadme = buildAgentsReadme(workspacePath, claudeConfig, exePath);

    const filesToWrite: Array<{ relativePath: string; content: string }> = [
        { relativePath: path.join('claude', 'claude.mcp.json'), content: claudeConfig },
        { relativePath: path.join('cursor', 'cursor.mcp.json'), content: cursorConfig },
        { relativePath: path.join('cline', 'cline.mcp.json'), content: clineConfig },
        { relativePath: path.join('windsurf', 'windsurf.mcp.json'), content: windsurfConfig },
        { relativePath: path.join('grok', 'grok.config.toml'), content: grokConfig },
        { relativePath: path.join('codex', 'codex.windows.config.toml'), content: codexWindowsToml },
        { relativePath: path.join('codex', 'codex.unix.config.toml'), content: codexWslToml },
        { relativePath: path.join('codex', 'codex.wsl.config.toml'), content: codexWslToml },
        { relativePath: path.join('codex', 'codex.config.toml'), content: codexWindowsToml },
        { relativePath: 'README.md', content: agentsReadme },
    ];

    for (const file of filesToWrite) {
        const targetPath = path.join(outputDir, file.relativePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        if (!overwrite && fs.existsSync(targetPath)) {
            continue;
        }
        fs.writeFileSync(targetPath, file.content, 'utf8');
    }

    await syncCodexGlobalConfig(context, workspacePath, exePath);
    syncCursorGlobalConfig(context);
    syncClaudeGlobalConfig(context);
    syncGrokGlobalConfig(context);

    const isCursor = isCursorHost();
    if (isCursor) {
        updateCursorRule(context, workspacePath);
    }

    if (!isCursor) {
        await ensureCopilotInstructions(context);
    }

    ensureCopilotGlobalMemory();

    ensureCodexGlobalAgentsMd();
    ensureClaudeUserMemoryMd();
    ensureGrokGlobalMemoryMd();

    ensureAgentsMd(context, workspacePath);

    if (silent) {
        return;
    }

    const readmePath = path.join(outputDir, 'README.md');
    const action = await vscode.window.showInformationMessage(
        `NeuroTrace MCP files generated at ${outputDir}`,
        'Open Guide',
        'Open Folder',
        'Copy Claude JSON',
        'Copy Codex Windows TOML',
        'Copy Codex Unix TOML'
    );

    if (action === 'Open Guide') {
        const doc = await vscode.workspace.openTextDocument(readmePath);
        await vscode.window.showTextDocument(doc);
    } else if (action === 'Open Folder') {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(readmePath));
    } else if (action === 'Copy Claude JSON') {
        await vscode.env.clipboard.writeText(claudeConfig);
        vscode.window.showInformationMessage('Claude Code MCP JSON copied to clipboard.');
    } else if (action === 'Copy Codex Windows TOML') {
        await vscode.env.clipboard.writeText(codexWindowsToml);
        vscode.window.showInformationMessage('Codex Windows MCP TOML copied to clipboard.');
    } else if (action === 'Copy Codex Unix TOML') {
        await vscode.env.clipboard.writeText(codexWslToml);
        vscode.window.showInformationMessage('Codex Unix MCP TOML copied to clipboard.');
    }
}

export async function ensureMcpWorkspaceFilesForInitializedWorkspace(
    context: vscode.ExtensionContext,
    options: GenerateMcpOptions = {}
): Promise<boolean> {
    const profileSync = context.extensionMode !== vscode.ExtensionMode.Production;
    const syncStartedAt = Date.now();
    const logSyncStep = (label: string, stepStartedAt: number) => {
        if (!profileSync) {
            return;
        }
        const stepMs = Date.now() - stepStartedAt;
        const totalMs = Date.now() - syncStartedAt;
        console.log(`NeuroTrace workspace sync: ${label} (${stepMs}ms, total ${totalMs}ms)`);
    };
    let syncStepStartedAt = Date.now();

    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return false;
    }

    const dbPath = path.join(workspacePath, '.neurotrace', 'neurotrace.db');
    if (!fs.existsSync(dbPath)) {
        return false;
    }

    const exePath = getMcpBackendExecutablePath(context);
    if (exePath) {
        await syncCodexGlobalConfig(context, workspacePath, exePath);
        syncCursorGlobalConfig(context);
        syncGrokGlobalConfig(context);
    }
    syncClaudeGlobalConfig(context);
    logSyncStep('sync global MCP configs', syncStepStartedAt);
    syncStepStartedAt = Date.now();

    // Always update NeuroTrace-owned sections (idempotent, delimiter-based)
    ensureCodexGlobalAgentsMd();
    logSyncStep('ensure Codex global AGENTS.md', syncStepStartedAt);
    syncStepStartedAt = Date.now();

    ensureClaudeUserMemoryMd();
    logSyncStep('ensure Claude user CLAUDE.md', syncStepStartedAt);
    syncStepStartedAt = Date.now();

    ensureGrokGlobalMemoryMd();
    logSyncStep('ensure Grok global MEMORY.md', syncStepStartedAt);
    syncStepStartedAt = Date.now();

    ensureAgentsMd(context, workspacePath);
    logSyncStep('ensure AGENTS.md', syncStepStartedAt);
    syncStepStartedAt = Date.now();
    updateCursorRule(context, workspacePath);
    logSyncStep('update Cursor rule', syncStepStartedAt);
    syncStepStartedAt = Date.now();
    if (!isCursorHost()) {
        await ensureCopilotInstructions(context);
    }
    logSyncStep('ensure Copilot instructions', syncStepStartedAt);
    syncStepStartedAt = Date.now();
    ensureCopilotGlobalMemory();
    logSyncStep('ensure Copilot global memory', syncStepStartedAt);
    syncStepStartedAt = Date.now();

    // Only regenerate MCP config files if something is missing
    const outputDir = path.join(workspacePath, '.neurotrace', 'mcp');
    migrateLegacyMcpLayout(outputDir);
    const hasMissingFiles = MCP_FILE_PATHS.some(relativePath => !fs.existsSync(path.join(outputDir, relativePath)));
    logSyncStep('check MCP workspace files', syncStepStartedAt);
    syncStepStartedAt = Date.now();

    if (!hasMissingFiles) {
        logSyncStep('workspace sync complete (no regeneration needed)', syncStartedAt);
        return false;
    }

    await generateMcpWorkspaceFiles(context, { ...options, overwrite: false });
    logSyncStep('generate MCP workspace files', syncStepStartedAt);
    logSyncStep('workspace sync complete', syncStartedAt);
    return true;
}
