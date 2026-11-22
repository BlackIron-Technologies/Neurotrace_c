/** Returns the compiled backend that Codex launches on this platform, or throws when it is missing or unusable. */
export function selectCodexBackendCommand(platform: NodeJS.Platform, backendExecutable: string | null): string {
    if (platform === 'win32') {
        if (!backendExecutable?.toLowerCase().endsWith('.exe')) {
            throw new Error('Install the Windows NeuroTrace backend before configuring MCP');
        }
        return backendExecutable;
    }
    if (!backendExecutable) {
        throw new Error('Install the NeuroTrace backend before configuring MCP');
    }
    return backendExecutable;
}
