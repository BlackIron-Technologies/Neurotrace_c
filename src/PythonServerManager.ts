import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { BackendDownloader } from './BackendDownloader';

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
}

export class PythonServerManager {
    private pythonProcess: cp.ChildProcess | null = null;
    private requests = new Map<string, PendingRequest>();
    private static instance: PythonServerManager;
    private restartAttempts: number = 0;
    private readonly maxRestartAttempts: number = 3;
    private serverStabilityTimer: NodeJS.Timeout | null = null;
    private backendDownloader: BackendDownloader;
    private pendingRestartTimer: NodeJS.Timeout | null = null;
    private shutdownReason: 'manual' | 'update' | 'restart' | null = null;
    private closeWaiters: Array<() => void> = [];
    private backendMaintenanceMode = false;
    private cachedDevelopmentBackendCommand: { command: string; args: string[]; cwd?: string } | null | undefined;

    private constructor(private context: vscode.ExtensionContext) {
        this.backendDownloader = new BackendDownloader(context);
    }

    private isCursorHost(): boolean {
        return Boolean((vscode as any).cursor?.mcp) || vscode.env.appName.toLowerCase().includes('cursor');
    }

    public static getInstance(context: vscode.ExtensionContext): PythonServerManager {
        if (!PythonServerManager.instance) {
            PythonServerManager.instance = new PythonServerManager(context);
        }
        return PythonServerManager.instance;
    }

    public startServer(): void {
        this.shutdownReason = null;
        this.backendMaintenanceMode = false;
        if (this.pendingRestartTimer) {
            clearTimeout(this.pendingRestartTimer);
            this.pendingRestartTimer = null;
        }
        if (this.pythonProcess) {
            this.stopServer('restart');
        }
        this.restartAttempts = 0;
        this.startServerInternal();
    }

    public async startServerAndConfigureWorkspace(): Promise<boolean> {
        this.startServer();
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
            return false;
        }

        await new Promise(resolve => setTimeout(resolve, 500));
        try {
            const result = await this.sendCommand<string>('set_workspace', { workspace: workspacePath });
            console.log(`NeuroTrace: Backend workspace configured: ${result}`);
        } catch (error) {
            console.error('NeuroTrace: Backend workspace configuration failed:', error);
            throw error;
        }
        return true;
    }

    /**
     * Checks if a backend executable is available (not Python fallback)
     * @returns true if a compiled backend exists, false otherwise
     */
    public isBackendAvailable(): boolean {
        return this.backendDownloader.getBackendPath() !== null;
    }

    private shouldUseDevelopmentBackend(): boolean {
        return this.context.extensionMode !== vscode.ExtensionMode.Production;
    }

    private getDevelopmentBackendCommand(): { command: string; args: string[]; cwd?: string } | null {
        if (!this.shouldUseDevelopmentBackend()) {
            return null;
        }

        if (this.cachedDevelopmentBackendCommand !== undefined) {
            return this.cachedDevelopmentBackendCommand;
        }

        const scriptPath = vscode.Uri.joinPath(this.context.extensionUri, 'bin', 'neurotrace.py').fsPath;
        if (!fs.existsSync(scriptPath)) {
            this.cachedDevelopmentBackendCommand = null;
            return null;
        }

        const scriptDir = path.dirname(scriptPath);
        const candidates: Array<{ command: string; args: string[]; probeArgs: string[] }> = os.platform() === 'win32'
            ? [
                { command: 'py', args: ['-3', '-u', scriptPath], probeArgs: ['-3', '--version'] },
                { command: 'python', args: ['-u', scriptPath], probeArgs: ['--version'] },
                { command: 'python3', args: ['-u', scriptPath], probeArgs: ['--version'] }
            ]
            : [
                { command: 'python3', args: ['-u', scriptPath], probeArgs: ['--version'] },
                { command: 'python', args: ['-u', scriptPath], probeArgs: ['--version'] }
            ];

        for (const candidate of candidates) {
            const probe = cp.spawnSync(candidate.command, candidate.probeArgs, {
                cwd: scriptDir,
                encoding: 'utf8'
            });
            if (probe.status === 0 && !probe.error) {
                console.log(`NeuroTrace: Using development Python backend via ${candidate.command}`);
                this.cachedDevelopmentBackendCommand = {
                    command: candidate.command,
                    args: candidate.args,
                    cwd: scriptDir
                };
                return this.cachedDevelopmentBackendCommand;
            }
        }

        console.error('NeuroTrace: Development backend script found but no Python interpreter is available.');
        this.cachedDevelopmentBackendCommand = null;
        return null;
    }

    /**
     * Determines the appropriate backend command based on the operating system
     * @returns Object containing the command and arguments to execute, or null if unavailable
     */
    private async getBackendCommand(): Promise<{ command: string; args: string[]; cwd?: string } | null> {
        const developmentBackend = this.getDevelopmentBackendCommand();
        if (developmentBackend) {
            return developmentBackend;
        }

        const platform = os.platform();
        const binPath = vscode.Uri.joinPath(this.context.extensionUri, 'bin').fsPath;

        switch (platform) {
            case 'win32': {
                // Windows: Use the compiled .exe only
                const exePath = path.join(binPath, 'dist', 'neurotrace-windows', 'neurotrace.exe');

                if (fs.existsSync(exePath)) {
                    console.log('NeuroTrace: Using compiled Windows executable');
                    const exeDir = path.dirname(exePath);
                    return { command: exePath, args: [], cwd: exeDir };
                }

                // Check if backend is available
                console.log('NeuroTrace: Compiled executable not found');
                const backendPath = this.backendDownloader.getBackendPath();
                if (backendPath && fs.existsSync(backendPath)) {
                    console.log('NeuroTrace: Using downloaded Windows executable');
                    const exeDir = path.dirname(backendPath);
                    return { command: backendPath, args: [], cwd: exeDir };
                }

                // No backend available
                console.log('NeuroTrace: No backend available for Windows');
                return null;
            }

            case 'darwin': {
                // macOS: Use the compiled executable only
                const exePath = path.join(binPath, 'dist', 'neurotrace-macos', 'neurotrace');

                if (fs.existsSync(exePath)) {
                    console.log('NeuroTrace: Using compiled macOS executable');
                    const exeDir = path.dirname(exePath);
                    return { command: exePath, args: [], cwd: exeDir };
                }

                // Check if backend is available
                console.log('NeuroTrace: Compiled executable not found');
                const backendPath = this.backendDownloader.getBackendPath();
                if (backendPath && fs.existsSync(backendPath)) {
                    console.log('NeuroTrace: Using downloaded macOS executable');
                    const exeDir = path.dirname(backendPath);
                    return { command: backendPath, args: [], cwd: exeDir };
                }

                // No backend available
                console.log('NeuroTrace: No backend available for macOS');
                return null;
            }

            case 'linux': {
                // Linux: Use the compiled executable only
                const exePath = path.join(binPath, 'dist', 'neurotrace-linux', 'neurotrace');

                if (fs.existsSync(exePath)) {
                    console.log('NeuroTrace: Using compiled Linux executable');
                    const exeDir = path.dirname(exePath);
                    return { command: exePath, args: [], cwd: exeDir };
                }

                // Check if backend is available
                console.log('NeuroTrace: Compiled executable not found');
                const backendPath = this.backendDownloader.getBackendPath();
                if (backendPath && fs.existsSync(backendPath)) {
                    console.log('NeuroTrace: Using downloaded Linux executable');
                    const exeDir = path.dirname(backendPath);
                    return { command: backendPath, args: [], cwd: exeDir };
                }

                // No backend available
                console.log('NeuroTrace: No backend available for Linux');
                return null;
            }

            default: {
                // Unsupported platform
                console.error(`NeuroTrace: Unsupported platform ${os.platform()}`);
                return null;
            }
        }
    }

    private async startServerInternal(): Promise<void> {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
            console.error('Cannot start Python server without an open workspace.');
            return;
        }

        // Detect the platform and choose the appropriate backend
        const backendCommand = await this.getBackendCommand();

        if (!backendCommand) {
            console.error('NeuroTrace: Failed to get backend command');
            if (this.backendMaintenanceMode) {
                console.log('NeuroTrace: Backend unavailable during maintenance/update, suppressing user-facing error');
            } else {
                vscode.window.showErrorMessage(
                    'NeuroTrace: Backend not available. Please download it from the sidebar.'
                );
            }
            return;
        }

        const { command, args, cwd } = backendCommand;
        const env = {
            ...process.env,
            // Enable the localhost bridge in both Cursor and VS Code so external MCP
            // clients like Codex can reuse the already-unlocked backend for this workspace.
            NEUROTRACE_ENABLE_BRIDGE: '1',
        };

        this.pythonProcess = cp.spawn(command, args, { cwd, env });

        // If the server remains stable for 30 seconds, reset the counter
        if (this.serverStabilityTimer) {
            clearTimeout(this.serverStabilityTimer);
        }

        this.serverStabilityTimer = setTimeout(() => {
            this.restartAttempts = 0;
            console.log('NeuroTrace: Python server stable, reset restart counter');
        }, 30000);

        // Listener for stdout and stderr
        this.pythonProcess.stdout?.on('data', (data) => {
            const lines = data.toString().split('\n').filter((line: string) => line.trim() !== '');
            for (const line of lines) {
                try {
                    const response = JSON.parse(line);
                    const pending = this.requests.get(response.id);
                    if (pending) {
                        if (response.success) {
                            pending.resolve(response.data);
                        } else {
                            pending.reject(new Error(response.error));
                        }
                        this.requests.delete(response.id);
                    }
                } catch (e) {
                    console.error('Failed to parse Python response:', line);
                }
            }
        });

        this.pythonProcess.stderr?.on('data', (data) => {
            console.error(`Python Server stderr: ${data}`);
        });

        this.pythonProcess.on('close', (code) => {
            console.log(`Python server process exited with code ${code}`);
            this.pythonProcess = null;
            const shutdownReason = this.shutdownReason;
            this.shutdownReason = null;
            this.resolveCloseWaiters();
            this.rejectAllPendingRequests(new Error(
                shutdownReason ? `Python server stopped intentionally (${shutdownReason}).` : 'Python server exited.'
            ));

            if (shutdownReason) {
                console.log(`NeuroTrace: Python server stopped intentionally (${shutdownReason}), skipping auto-restart`);
                return;
            }

            // Logic to handle server restarts
            if (code !== 0 && this.restartAttempts < this.maxRestartAttempts) {
                this.restartAttempts++;
                const waitTime = 2000;

                console.log(`NeuroTrace: Restarting Python server (Attempt ${this.restartAttempts}/${this.maxRestartAttempts})`);
                vscode.window.showWarningMessage(`NeuroTrace: Restarting Python server (Attempt ${this.restartAttempts}/${this.maxRestartAttempts})`);

                this.pendingRestartTimer = setTimeout(() => {
                    this.pendingRestartTimer = null;
                    this.startServerInternal();
                }, waitTime);
            } else if (this.restartAttempts >= this.maxRestartAttempts) {
                console.error('NeuroTrace: Python server failed repeatedly, no more retries will be made');
                vscode.window.showErrorMessage(
                    'The NeuroTrace Python server failed 3 times. Please check your Python environment and manually restart the extension.'
                );
            }
        });

        // Server is ready to receive commands
    }

    public sendCommand<T>(command: string, payload: any = {}, expectResponse = true): Promise<T> {
        return new Promise((resolve, reject) => {
            if (!this.pythonProcess?.stdin) {
                return reject(new Error('Python server is not running.'));
            }

            const requestId = `req-${Date.now()}-${Math.random()}`;
            const request = { id: requestId, command, payload };

            if (expectResponse) {
                this.requests.set(requestId, { resolve, reject });
            }

            this.pythonProcess.stdin.write(JSON.stringify(request) + '\n', (err) => {
                if (err) {
                    if (expectResponse) { this.requests.delete(requestId); }
                    return reject(err);
                }
                if (!expectResponse) {
                    resolve(null as any);
                }
            });
        });
    }

    private rejectAllPendingRequests(error: Error): void {
        for (const pending of this.requests.values()) {
            pending.reject(error);
        }
        this.requests.clear();
    }

    private resolveCloseWaiters(): void {
        const waiters = [...this.closeWaiters];
        this.closeWaiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }

    public stopServer(reason: 'manual' | 'update' | 'restart' = 'manual'): void {
        this.shutdownReason = reason;
        if (reason === 'update') {
            this.backendMaintenanceMode = true;
        }
        if (this.pendingRestartTimer) {
            clearTimeout(this.pendingRestartTimer);
            this.pendingRestartTimer = null;
        }
        if (this.serverStabilityTimer) {
            clearTimeout(this.serverStabilityTimer);
            this.serverStabilityTimer = null;
        }

        if (this.pythonProcess) {
            this.pythonProcess.kill();
        }
    }

    public async stopServerAndWait(reason: 'manual' | 'update' | 'restart' = 'manual', timeoutMs = 10000): Promise<void> {
        if (!this.pythonProcess) {
            this.shutdownReason = reason;
            return;
        }

        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                this.closeWaiters = this.closeWaiters.filter(waiter => waiter !== onClose);
                resolve();
            }, timeoutMs);

            const onClose = () => {
                clearTimeout(timeout);
                resolve();
            };

            this.closeWaiters.push(onClose);
            this.stopServer(reason);
        });
    }

    public async reconnect(): Promise<boolean> {
        try {
            await this.stopServerAndWait('restart');
            const configured = await this.startServerAndConfigureWorkspace();
            if (configured) {
                console.log('NeuroTrace: Python server restarted and workspace configured.');
            }
            return configured;
        } catch (error) {
            console.error('NeuroTrace: Error reconnecting:', error);
            return false;
        }
    }
}
