const CODEX_MCP_MARKER_START = '# BEGIN NEUROTRACE MCP';
const CODEX_MCP_MARKER_END = '# END NEUROTRACE MCP';

export function toForwardSlashes(input: string): string {
    return input.replace(/\\/g, '/');
}

export function toWslPath(input: string): string {
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

export function buildStdioMcpConfig(exePath: string, workspaceArg: string, extraArgs: string[] = []) {
    return {
        mcpServers: {
            neurotrace: {
                command: exePath,
                args: ['--mcp', '--workspace', workspaceArg, ...extraArgs],
            },
        },
    };
}

export function buildCodexToml(command: string, args: string[]): string {
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

export function quoteTomlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildGrokToml(command: string, workspaceArg: string): string {
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

export function quoteBashArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCodexWindowsToml(exePath: string, workspacePath: string): string {
    const normalizedExe = toForwardSlashes(exePath);
    const normalizedWorkspace = toForwardSlashes(workspacePath);

    return buildCodexToml(normalizedExe, ['--mcp', '--workspace', normalizedWorkspace]);
}

export function buildCodexWslToml(commandPath: string, workspacePath: string, dynamicWorkspace = false): string {
    const command = toWslPath(commandPath);
    if (command.toLowerCase().endsWith('.exe')) {
        if (dynamicWorkspace) {
            const launch = 'case "$PWD" in /mnt/[a-zA-Z]/*) exec ' + quoteBashArg(command) + ' --mcp --workspace "$(wslpath -w "$PWD")" ;; *) echo "Use a native Linux NeuroTrace backend for a Linux workspace" >&2; exit 1 ;; esac';
            return buildCodexToml('bash', ['-c', launch]);
        }
        return buildCodexToml(command, ['--mcp', '--workspace', toForwardSlashes(workspacePath)]);
    }
    const directory = dynamicWorkspace ? '.' : toWslPath(workspacePath);
    return buildCodexToml(command.endsWith('.py') ? 'python3' : command,
        command.endsWith('.py') ? [command, '--mcp', '--workspace', directory] : ['--mcp', '--workspace', directory]);
}

export function buildCodexWindowsViaWslToml(commandPath: string, workspacePath: string, dynamicWorkspace = false): string {
    if (!commandPath.toLowerCase().endsWith('.exe')) { throw new Error('Windows workspaces require the Windows NeuroTrace backend'); }
    const command = toWslPath(commandPath);
    const directory = dynamicWorkspace ? '"$(wslpath -w "$PWD")"' : quoteBashArg(toForwardSlashes(workspacePath));
    return buildCodexToml('wsl.exe', ['--exec', 'bash', '-c', 'exec ' + quoteBashArg(command) + ' --mcp --workspace ' + directory]);
}

export function upsertTomlBlock(existing: string, block: string): string {
    const normalized = existing.replace(/\r\n/g, '\n');
    const pattern = new RegExp(`${CODEX_MCP_MARKER_START}[\\s\\S]*?${CODEX_MCP_MARKER_END}\\n?`, 'm');
    const replacement = `${CODEX_MCP_MARKER_START}\n${block}\n${CODEX_MCP_MARKER_END}\n`;

    if (pattern.test(normalized)) {
        return normalized.replace(pattern, replacement);
    }

    const trimmed = normalized.trimEnd();
    return trimmed ? `${trimmed}\n\n${replacement}` : replacement;
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function upsertTomlTable(content: string, tableName: string, tableContent: string): string {
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

export function upsertTomlScalarInTable(content: string, tableName: string, key: string, value: string): string {
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
