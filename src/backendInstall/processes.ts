import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

export function stopInstalledBackends(installRoot: string): void {
    const root = path.resolve(installRoot);
    if (os.platform() === 'win32') {
        const prefix = (root + path.sep).replace(/'/g, "''");
        const script = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'neurotrace.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { try { $backend = [System.Diagnostics.Process]::GetProcessById($_.ProcessId) } catch [System.ArgumentException] { return }; try { if ($backend.MainModule.FileName.StartsWith('${prefix}', [System.StringComparison]::OrdinalIgnoreCase)) { $backend.Kill(); if (-not $backend.WaitForExit(10000)) { throw 'Backend shutdown timed out' } } } finally { $backend.Dispose() } }`;
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        if (result.error || result.status !== 0) { throw new Error('Could not stop the installed backend: ' + (result.error?.message || result.stderr)); }
        return;
    }
    const result = spawnSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status !== 0) { throw new Error('Could not inspect installed backend processes: ' + (result.error?.message || result.stderr)); }
    const platform = os.platform() === 'darwin' ? 'macos' : 'linux';
    const executables = [path.join(root, 'neurotrace'), path.join(root, `neurotrace-${platform}`, 'neurotrace'), path.join(root, 'dist', `neurotrace-${platform}`, 'neurotrace'), path.join(root, `neurotrace-backend-${platform}`, 'neurotrace')];
    const pids: number[] = [];
    for (const line of result.stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match || !executables.some(executable => match[2] === executable || match[2].startsWith(executable + ' '))) { continue; }
        const pid = Number(match[1]);
        try { process.kill(pid, 'SIGTERM'); pids.push(pid); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
    }
    const deadline = Date.now() + 5000;
    for (const pid of pids) {
        while (true) {
            try { process.kill(pid, 0); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { break; } throw error; }
            if (Date.now() >= deadline) { throw new Error('An installed backend is still running. Close its agent session and retry the update.'); }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
}
