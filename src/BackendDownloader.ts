import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import { spawnSync } from 'child_process';
import AdmZip = require('adm-zip');
import { createWriteStream } from 'fs';
import * as config from './config.json';

export function getPersistentBackendInstallRoot(platform: string = os.platform()): string {
    switch (platform) {
        case 'win32': {
            const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
            return path.join(localAppData, 'Programs', 'NeuroTrace');
        }
        case 'darwin':
            return path.join(os.homedir(), 'Library', 'Application Support', 'NeuroTrace');
        case 'linux':
            return path.join(os.homedir(), '.local', 'share', 'neurotrace');
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
}

export function getPersistentBackendExecutablePath(platform: string = os.platform()): string {
    const executableName = backendExecutableName(platform);
    return path.join(getPersistentBackendInstallRoot(platform), executableName);
}

function backendPlatformName(platform: string): string {
    switch (platform) {
        case 'win32':
            return 'windows';
        case 'darwin':
            return 'macos';
        case 'linux':
            return 'linux';
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
}

function backendExecutableName(platform: string): string {
    return platform === 'win32' ? 'neurotrace.exe' : 'neurotrace';
}

/**
 * Manages downloading and extracting platform-specific backend binaries from GitHub Releases
 */
export class BackendDownloader {
    private readonly GITHUB_REPO = config.githubRepo;
    private readonly DOWNLOAD_TIMEOUT_MS = 300000; // 5 minutes
    private readonly MINIMUM_BACKEND_VERSION = config.minimumBackendVersion;

    constructor(private context: vscode.ExtensionContext) { }

    private getInstalledBackendVersionFilePath(): string {
        const binPath = getPersistentBackendInstallRoot();
        return path.join(binPath, 'backend-binary-version.txt');
    }

    private shouldUseDevelopmentBackend(): boolean {
        return this.context.extensionMode !== vscode.ExtensionMode.Production;
    }

    private getDevelopmentBackendScriptPath(): string | null {
        if (!this.shouldUseDevelopmentBackend()) {
            return null;
        }

        const scriptPath = vscode.Uri.joinPath(this.context.extensionUri, 'bin', 'neurotrace.py').fsPath;
        return fs.existsSync(scriptPath) ? scriptPath : null;
    }

    /**
     * Checks if the backend executable is available
     * @returns Path to the backend executable or null if unavailable
     */
    public getBackendPath(): string | null {
        const developmentScriptPath = this.getDevelopmentBackendScriptPath();
        if (developmentScriptPath) {
            console.log(`NeuroTrace: Using development backend script at ${developmentScriptPath}`);
            return developmentScriptPath;
        }

        const platform = os.platform();
        const candidates = this.getExecutableCandidates(platform);

        for (const executablePath of candidates) {
            if (fs.existsSync(executablePath)) {
                console.log(`NeuroTrace: Backend executable found at ${executablePath}`);
                return executablePath;
            }
        }

        console.log('NeuroTrace: Backend executable not found');
        return null;
    }

    /**
     * Gets the installed backend version
     * @returns Version string or null if not found
     */
    public getInstalledBackendVersion(): string | null {
        const backendPath = this.getBackendPath();
        const versionFromExecutable = backendPath ? this.getBackendVersionFromExecutable(backendPath) : null;
        if (versionFromExecutable) {
            return versionFromExecutable;
        }

        const versionFilePath = this.getInstalledBackendVersionFilePath();
        if (fs.existsSync(versionFilePath)) {
            try {
                return fs.readFileSync(versionFilePath, 'utf-8').trim();
            } catch (error) {
                console.error('NeuroTrace: Error reading verified backend version file:', error);
                return null;
            }
        }

        return null;
    }

    /**
     * Checks if backend version meets minimum requirements
     * IMPORTANT: Accepts any version >= minimum required version
     * This allows the extension to update independently from the backend
     * @returns true if backend is compatible, false if update required
     */
    public isBackendVersionValid(): boolean {
        const installedVersion = this.getInstalledBackendVersion();
        const backendPath = this.getBackendPath();

        if (!installedVersion) {
            if (backendPath) {
                console.log('NeuroTrace: Backend found but version could not be verified - update required');
                return false;
            }
            console.log('NeuroTrace: No backend found');
            return false;
        }

        if (
            backendPath &&
            !backendPath.toLowerCase().endsWith('.py') &&
            !this.isPathInsidePersistentInstall(backendPath)
        ) {
            console.log(`NeuroTrace: Backend is installed in legacy storage (${backendPath}); migration to persistent install path required.`);
            return false;
        }

        // Compare versions using semantic versioning
        // Accept any version >= minimum required (e.g., 0.9.35 >= 0.9.32 is valid)
        const comparison = this.compareVersions(installedVersion, this.MINIMUM_BACKEND_VERSION);
        const isValid = comparison >= 0;

        console.log(`NeuroTrace: Backend version check - Installed: ${installedVersion}, Minimum Required: ${this.MINIMUM_BACKEND_VERSION}, Valid: ${isValid}`);

        if (isValid && comparison > 0) {
            console.log(`NeuroTrace: Backend version ${installedVersion} is newer than minimum ${this.MINIMUM_BACKEND_VERSION} - compatible`);
        }

        return isValid;
    }

    private isPathInsidePersistentInstall(candidatePath: string): boolean {
        const installRoot = path.resolve(getPersistentBackendInstallRoot());
        const resolvedCandidate = path.resolve(candidatePath);
        const relative = path.relative(installRoot, resolvedCandidate);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    public isUsingLegacyBackendStorage(): boolean {
        const backendPath = this.getBackendPath();
        return Boolean(
            backendPath &&
            !backendPath.toLowerCase().endsWith('.py') &&
            !this.isPathInsidePersistentInstall(backendPath)
        );
    }

    /**
     * Compares two semantic version strings
     * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
     */
    private compareVersions(v1: string, v2: string): number {
        const parts1 = v1.split(/[.-]/).map(p => isNaN(parseInt(p)) ? p : parseInt(p));
        const parts2 = v2.split(/[.-]/).map(p => isNaN(parseInt(p)) ? p : parseInt(p));

        const maxLength = Math.max(parts1.length, parts2.length);

        for (let i = 0; i < maxLength; i++) {
            const part1 = parts1[i] || 0;
            const part2 = parts2[i] || 0;

            if (typeof part1 === 'number' && typeof part2 === 'number') {
                if (part1 > part2) { return 1; }
                if (part1 < part2) { return -1; }
            } else {
                // String comparison for pre-release tags (beta, alpha, etc.)
                const str1 = String(part1);
                const str2 = String(part2);
                if (str1 > str2) { return 1; }
                if (str1 < str2) { return -1; }
            }
        }

        return 0;
    }

    /**
     * Gets the path to the version file
     */
    private saveBackendVersion(version: string): void {
        const versionFilePath = this.getInstalledBackendVersionFilePath();
        const binPath = path.dirname(versionFilePath);

        // Ensure global storage directory exists
        if (!fs.existsSync(binPath)) {
            fs.mkdirSync(binPath, { recursive: true });
        }

        fs.writeFileSync(versionFilePath, version, 'utf-8');
        console.log(`NeuroTrace: Saved backend version: ${version}`);
    }

    private getBackendVersionFromExecutable(backendPath: string): string | null {
        try {
            const isScript = backendPath.toLowerCase().endsWith('.py');
            const cwd = path.dirname(backendPath);

            if (isScript) {
                const candidates: Array<{ command: string; args: string[] }> = os.platform() === 'win32'
                    ? [
                        { command: 'py', args: ['-3', backendPath, '--version'] },
                        { command: 'python', args: [backendPath, '--version'] },
                        { command: 'python3', args: [backendPath, '--version'] }
                    ]
                    : [
                        { command: 'python3', args: [backendPath, '--version'] },
                        { command: 'python', args: [backendPath, '--version'] }
                    ];

                for (const candidate of candidates) {
                    const result = spawnSync(candidate.command, candidate.args, {
                        cwd,
                        encoding: 'utf8',
                        timeout: 10000
                    });
                    const version = this.extractVersionFromOutput(result.stdout, result.stderr);
                    if (version) {
                        return version;
                    }
                }

                return null;
            }

            const result = spawnSync(backendPath, ['--version'], {
                cwd,
                encoding: 'utf8',
                timeout: 10000
            });
            return this.extractVersionFromOutput(result.stdout, result.stderr);
        } catch (error) {
            console.error('NeuroTrace: Failed to get backend version from executable:', error);
            return null;
        }
    }

    private extractVersionFromOutput(stdout?: string, stderr?: string): string | null {
        const combined = `${stdout || ''}\n${stderr || ''}`;
        const match = combined.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/);
        return match ? match[0] : null;
    }

    private quoteShellValue(value: string): string {
        return `'${value.replace(/'/g, `'\\''`)}'`;
    }

    private toWslPath(input: string): string {
        if (input.startsWith('/')) {
            return input;
        }

        const normalized = input.replace(/\\/g, '/');
        const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
        if (!match) {
            return normalized;
        }

        return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
    }

    private runWslBash(command: string, timeout: number = 15000) {
        return spawnSync('wsl.exe', ['bash', '-lc', command], {
            encoding: 'utf8',
            timeout
        });
    }

    private runWslPython(script: string, timeout: number = 15000) {
        const command = [
            'python3 - <<\'PY\'',
            script,
            'PY'
        ].join('\n');

        return this.runWslBash(command, timeout);
    }

    private isCodexInstalledInWsl(): boolean {
        if (os.platform() !== 'win32') {
            return false;
        }

        const result = this.runWslBash('command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]');
        return result.status === 0;
    }

    private getWslCodexBackendRoot(): string | null {
        if (os.platform() !== 'win32') {
            return null;
        }

        const result = this.runWslPython([
            'from pathlib import Path',
            'print((Path.home() / ".codex" / "mcp-servers" / "neurotrace" / "linux").as_posix())'
        ].join('\n'));

        if (result.status !== 0) {
            console.error('NeuroTrace: Failed to resolve WSL backend root:', result.stderr || result.stdout);
            return null;
        }

        const root = result.stdout.trim();
        return root || null;
    }

    private getWslExecutableCandidates(root: string): string[] {
        return [
            `${root}/neurotrace-linux/neurotrace`,
            `${root}/neurotrace`,
            `${root}/dist/neurotrace-linux/neurotrace`,
            `${root}/neurotrace-backend-linux/neurotrace`,
        ];
    }

    private getWslCodexBackendExecutable(root: string): string | null {
        for (const candidate of this.getWslExecutableCandidates(root)) {
            const result = this.runWslBash(`[ -x ${this.quoteShellValue(candidate)} ]`);
            if (result.status === 0) {
                return candidate;
            }
        }

        return null;
    }

    private getWslCodexBackendVersion(root: string): string | null {
        const executable = this.getWslCodexBackendExecutable(root);
        if (!executable) {
            return null;
        }

        const result = this.runWslBash(`${this.quoteShellValue(executable)} --version`);
        return this.extractVersionFromOutput(result.stdout, result.stderr);
    }

    private async downloadAndInstallWslCodexBackend(root: string): Promise<string | null> {
        const downloadUrl = await this.getDownloadUrl(this.MINIMUM_BACKEND_VERSION, this.getPlatformName('linux'));
        if (!downloadUrl) {
            throw new Error(`No Linux backend release found for version ${this.MINIMUM_BACKEND_VERSION}`);
        }

        const tempDir = path.join(os.tmpdir(), `neurotrace-wsl-download-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        const zipPath = path.join(tempDir, 'neurotrace-linux.zip');

        try {
            const progress = { report: () => { } } as vscode.Progress<{ message?: string; increment?: number }>;
            const cancellation = new vscode.CancellationTokenSource();
            await this.downloadFile(downloadUrl, zipPath, progress, cancellation.token, true);

            const encodedRoot = Buffer.from(root, 'utf8').toString('base64');
            const encodedZipPath = Buffer.from(this.toWslPath(zipPath), 'utf8').toString('base64');
            const encodedVersion = Buffer.from(this.MINIMUM_BACKEND_VERSION, 'utf8').toString('base64');
            const result = this.runWslPython([
                'import base64',
                'from pathlib import Path',
                'import shutil',
                'import zipfile',
                '',
                `root = Path(base64.b64decode('${encodedRoot}').decode('utf-8'))`,
                `zip_path = Path(base64.b64decode('${encodedZipPath}').decode('utf-8'))`,
                `version = base64.b64decode('${encodedVersion}').decode('utf-8')`,
                'if root.exists():',
                '    shutil.rmtree(root)',
                'root.mkdir(parents=True, exist_ok=True)',
                'with zipfile.ZipFile(zip_path, "r") as archive:',
                '    archive.extractall(root)',
                'candidates = [',
                '    root / "neurotrace-linux" / "neurotrace",',
                '    root / "neurotrace",',
                '    root / "dist" / "neurotrace-linux" / "neurotrace",',
                '    root / "neurotrace-backend-linux" / "neurotrace",',
                ']',
                'backend = next((candidate for candidate in candidates if candidate.exists()), None)',
                'if backend is None:',
                '    raise RuntimeError("NeuroTrace Linux backend executable not found after extraction.")',
                'backend.chmod(0o755)',
                '(root / "backend-binary-version.txt").write_text(version, encoding="utf-8")',
                'print(backend.as_posix())'
            ].join('\n'), 120000);

            if (result.status !== 0) {
                throw new Error(result.stderr || result.stdout || 'Unknown WSL extraction error');
            }

            const installedPath = result.stdout.trim();
            return installedPath || this.getWslCodexBackendExecutable(root);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    public async ensureCodexWslBackend(): Promise<string | null> {
        if (os.platform() !== 'win32' || !this.isCodexInstalledInWsl()) {
            return null;
        }

        const root = this.getWslCodexBackendRoot();
        if (!root) {
            return null;
        }

        const existingExecutable = this.getWslCodexBackendExecutable(root);
        const existingVersion = this.getWslCodexBackendVersion(root);
        if (existingExecutable && existingVersion && this.compareVersions(existingVersion, this.MINIMUM_BACKEND_VERSION) >= 0) {
            return existingExecutable;
        }

        try {
            const installedPath = await this.downloadAndInstallWslCodexBackend(root);
            return installedPath ?? existingExecutable;
        } catch (error) {
            console.error('NeuroTrace: Failed to provision WSL Codex backend:', error);
            return existingExecutable;
        }
    }

    private removeWslCodexBackend(): void {
        if (os.platform() !== 'win32') {
            return;
        }

        const root = this.getWslCodexBackendRoot();
        if (!root) {
            return;
        }

        const encodedRoot = Buffer.from(root, 'utf8').toString('base64');
        const result = this.runWslPython([
            'import base64',
            'from pathlib import Path',
            'import shutil',
            `root = Path(base64.b64decode('${encodedRoot}').decode('utf-8'))`,
            'if root.exists():',
            '    shutil.rmtree(root)'
        ].join('\n'));

        if (result.status !== 0) {
            console.error('NeuroTrace: Failed to remove WSL Codex backend:', result.stderr || result.stdout);
        }
    }

    /**
     * Downloads the backend with user-initiated action
     * @returns Path to the backend executable or null if download failed/cancelled
     */
    public async downloadBackend(): Promise<string | null> {
        const platform = os.platform();

        // Download with progress indication
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'NeuroTrace: Downloading backend',
            cancellable: true
        }, async (progress, token) => {
            try {
                const success = await this.downloadAndExtractBackend(platform, progress, token);
                const backendPath = this.getBackendPath();
                if (success && backendPath) {
                    vscode.window.showInformationMessage('NeuroTrace backend downloaded successfully!');
                    return backendPath;
                } else {
                    throw new Error('Download completed but executable not found');
                }
            } catch (error) {
                console.error('NeuroTrace: Backend download failed:', error);
                vscode.window.showErrorMessage(
                    `Failed to download NeuroTrace backend: ${error instanceof Error ? error.message : 'Unknown error'}`
                );
                return null;
            }
        });
    }

    /**
     * Downloads the backend silently in the background (for automatic updates)
     * @returns Path to the backend executable or null if download failed
     */
    public async downloadBackendSilently(): Promise<string | null> {
        const platform = os.platform();

        // Download silently with minimal UI (status bar only)
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: 'Updating NeuroTrace backend...',
            cancellable: false
        }, async (progress, token) => {
            try {
                const success = await this.downloadAndExtractBackend(platform, progress, token, true);
                const backendPath = this.getBackendPath();
                if (success && backendPath) {
                    console.log('NeuroTrace: Backend updated silently to version', this.MINIMUM_BACKEND_VERSION);
                    return backendPath;
                } else {
                    throw new Error('Download completed but executable not found');
                }
            } catch (error) {
                console.error('NeuroTrace: Silent backend update failed:', error);
                // Only show error to user if silent update fails
                throw error;
            }
        });
    }

    /**
     * Downloads and extracts the backend for the specified platform
     * @param silent If true, suppresses progress messages for silent updates
     */
    private async downloadAndExtractBackend(
        platform: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken,
        silent: boolean = false
    ): Promise<boolean> {
        const version = this.context.extension.packageJSON.version;
        const platformName = this.getPlatformName(platform);
        const downloadUrl = await this.getDownloadUrl(version, platformName);

        if (!downloadUrl) {
            throw new Error(`No release found for version ${version}`);
        }

        if (!silent) {
            progress.report({ message: 'Preparing download...', increment: 0 });
        }

        // Create temporary download directory
        const tempDir = path.join(os.tmpdir(), `neurotrace-download-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        const zipPath = path.join(tempDir, `neurotrace-backend-${platformName}.zip`);

        try {
            // Download the zip file
            if (!silent) {
                progress.report({ message: 'Downloading...', increment: 10 });
            }
            await this.downloadFile(downloadUrl, zipPath, progress, token, silent);

            if (token.isCancellationRequested) {
                throw new Error('Download cancelled by user');
            }

            // Extract to a stable per-user install directory so external MCP
            // clients can keep pointing at the same backend path.
            if (!silent) {
                progress.report({ message: 'Extracting files...', increment: 80 });
            }
            const extractPath = getPersistentBackendInstallRoot(platform);
            fs.mkdirSync(extractPath, { recursive: true });

            await this.extractZip(zipPath, extractPath);

            if (token.isCancellationRequested) {
                throw new Error('Extraction cancelled by user');
            }

            // Set executable permissions on Unix systems
            if (platform !== 'win32') {
                const backendPath = this.getBackendPath();
                if (backendPath && fs.existsSync(backendPath)) {
                    fs.chmodSync(backendPath, 0o755);
                }
            }

            const downloadedVersion =
                this.getBackendVersionFromExecutable(this.getBackendPath() || '') ||
                this.MINIMUM_BACKEND_VERSION;
            this.saveBackendVersion(downloadedVersion);

            if (!silent) {
                progress.report({ message: 'Download complete!', increment: 100 });
            }

            // Cleanup temp directory
            fs.rmSync(tempDir, { recursive: true, force: true });

            return true;
        } catch (error) {
            // Cleanup on error
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch { }
            throw error;
        }
    }

    /**
     * Downloads a file from URL with progress tracking
     * @param silent If true, suppresses progress messages
     */
    private async downloadFile(
        url: string,
        destination: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken,
        silent: boolean = false
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const file = createWriteStream(destination);
            let downloadedBytes = 0;
            let totalBytes = 0;
            let lastReportedPercent = 0;

            const request = https.get(url, { timeout: this.DOWNLOAD_TIMEOUT_MS }, (response) => {
                // Handle redirects
                if (response.statusCode === 302 || response.statusCode === 301) {
                    const redirectUrl = response.headers.location;
                    if (redirectUrl) {
                        file.close();
                        this.downloadFile(redirectUrl, destination, progress, token, silent)
                            .then(resolve)
                            .catch(reject);
                        return;
                    }
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                    return;
                }

                totalBytes = parseInt(response.headers['content-length'] || '0', 10);

                response.on('data', (chunk) => {
                    if (token.isCancellationRequested) {
                        request.destroy();
                        file.close();
                        fs.unlinkSync(destination);
                        reject(new Error('Download cancelled'));
                        return;
                    }

                    downloadedBytes += chunk.length;

                    if (!silent && totalBytes > 0) {
                        const percent = Math.floor((downloadedBytes / totalBytes) * 100);
                        if (percent > lastReportedPercent && percent % 5 === 0) {
                            const mbDownloaded = (downloadedBytes / 1024 / 1024).toFixed(1);
                            const mbTotal = (totalBytes / 1024 / 1024).toFixed(1);
                            progress.report({
                                message: `Downloading... ${mbDownloaded}/${mbTotal} MB (${percent}%)`,
                                increment: percent - lastReportedPercent
                            });
                            lastReportedPercent = percent;
                        }
                    }
                });

                response.pipe(file);

                file.on('finish', () => {
                    file.close();
                    resolve();
                });
            });

            request.on('error', (error) => {
                file.close();
                fs.unlinkSync(destination);
                reject(error);
            });

            request.on('timeout', () => {
                request.destroy();
                file.close();
                fs.unlinkSync(destination);
                reject(new Error('Download timeout'));
            });

            token.onCancellationRequested(() => {
                request.destroy();
                file.close();
                if (fs.existsSync(destination)) {
                    fs.unlinkSync(destination);
                }
                reject(new Error('Download cancelled'));
            });
        });
    }

    /**
     * Extracts a zip file to the destination directory
     */
    private async extractZip(zipPath: string, destination: string): Promise<void> {
        // Ensure destination directory exists
        fs.mkdirSync(destination, { recursive: true });

        return new Promise((resolve, reject) => {
            try {
                const zip = new AdmZip(zipPath);
                zip.extractAllTo(destination, true);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Gets the download URL for a specific version and platform
     */
    private async getDownloadUrl(version: string, platformName: string): Promise<string | null> {
        // Use the minimum backend version instead of extension version
        // This allows extension updates without forcing backend updates
        const tag = this.MINIMUM_BACKEND_VERSION;

        // GitHub Releases direct download URL pattern
        // https://github.com/OWNER/REPO/releases/download/TAG/FILENAME
        const fileName = `neurotrace-${platformName}.zip`;
        const url = `https://github.com/${this.GITHUB_REPO}/releases/download/${tag}/${fileName}`;

        // Verify the URL exists by checking headers
        return new Promise((resolve) => {
            https.get(url, { method: 'HEAD' }, (response) => {
                if (response.statusCode === 200 || response.statusCode === 302) {
                    resolve(url);
                } else {
                    console.error(`NeuroTrace: Release not found at ${url}`);
                    resolve(null);
                }
            }).on('error', (error) => {
                console.error('NeuroTrace: Error checking release URL:', error);
                resolve(null);
            });
        });
    }

    /**
     * Gets the expected path to the executable for the current platform
     */
    private getExecutablePath(platform: string): string {
        return getPersistentBackendExecutablePath(platform);
    }

    /**
     * Returns possible executable paths to support multiple zip layouts.
     */
    private getExecutableCandidates(platform: string): string[] {
        const platformName = this.getPlatformName(platform);
        const installPath = getPersistentBackendInstallRoot(platform as NodeJS.Platform);
        const legacyStoragePath = this.context.globalStorageUri.fsPath;
        const executableName = backendExecutableName(platform);

        return [
            path.join(installPath, `neurotrace-${platformName}`, executableName),
            path.join(installPath, executableName),
            path.join(installPath, 'dist', `neurotrace-${platformName}`, executableName),
            path.join(installPath, `neurotrace-backend-${platformName}`, executableName),
            // Legacy extension-private storage. Keep as fallback so existing
            // installs keep working until the next backend download migrates them.
            path.join(legacyStoragePath, `neurotrace-${platformName}`, executableName),
            path.join(legacyStoragePath, executableName),
            path.join(legacyStoragePath, 'dist', `neurotrace-${platformName}`, executableName),
            path.join(legacyStoragePath, `neurotrace-backend-${platformName}`, executableName),
        ];
    }

    /**
     * Converts OS platform to our naming convention
     */
    private getPlatformName(platform: string): string {
        return backendPlatformName(platform);
    }

    /**
     * Checks if backend is already downloaded
     */
    public isBackendDownloaded(): boolean {
        const platform = os.platform();
        return this.getBackendPath() !== null;
    }

    /**
     * Removes downloaded backend (for troubleshooting)
     */
    public async removeBackend(options: { silent?: boolean } = {}): Promise<void> {
        const { silent = false } = options;
        const platform = os.platform();
        const platformName = this.getPlatformName(platform);
        const storagePath = getPersistentBackendInstallRoot(platform);
        const legacyStoragePath = this.context.globalStorageUri.fsPath;
        const backendDirs = [
            path.join(storagePath, `neurotrace-${platformName}`),
            path.join(storagePath, `neurotrace-backend-${platformName}`),
            path.join(storagePath, 'dist', `neurotrace-${platformName}`),
            path.join(legacyStoragePath, `neurotrace-${platformName}`),
            path.join(legacyStoragePath, `neurotrace-backend-${platformName}`),
            path.join(legacyStoragePath, 'dist', `neurotrace-${platformName}`),
        ];
        const rootExecutablePath = path.join(
            storagePath,
            backendExecutableName(platform)
        );
        const legacyRootExecutablePath = path.join(
            legacyStoragePath,
            backendExecutableName(platform)
        );
        const legacyVersionFilePath = path.join(storagePath, 'backend-version.txt');
        const legacyStorageVersionFilePath = path.join(legacyStoragePath, 'backend-version.txt');
        const legacyStorageVerifiedVersionFilePath = path.join(legacyStoragePath, 'backend-binary-version.txt');

        let removed = false;
        this.terminateRunningBackendProcesses(storagePath);
        this.terminateRunningBackendProcesses(legacyStoragePath);

        for (const backendDir of backendDirs) {
            if (fs.existsSync(backendDir)) {
                this.removePathWithRetries(backendDir, { recursive: true, force: true });
                removed = true;
            }
        }

        if (fs.existsSync(rootExecutablePath)) {
            this.removePathWithRetries(rootExecutablePath, { force: true });
            removed = true;
        }
        if (fs.existsSync(legacyRootExecutablePath)) {
            this.removePathWithRetries(legacyRootExecutablePath, { force: true });
            removed = true;
        }

        if (removed) {
            // Also remove version file
            const versionFilePath = this.getInstalledBackendVersionFilePath();
            if (fs.existsSync(versionFilePath)) {
                this.removePathWithRetries(versionFilePath);
            }
            if (fs.existsSync(legacyVersionFilePath)) {
                this.removePathWithRetries(legacyVersionFilePath);
            }
            if (fs.existsSync(legacyStorageVersionFilePath)) {
                this.removePathWithRetries(legacyStorageVersionFilePath);
            }
            if (fs.existsSync(legacyStorageVerifiedVersionFilePath)) {
                this.removePathWithRetries(legacyStorageVerifiedVersionFilePath);
            }

            if (os.platform() === 'win32') {
                this.removeWslCodexBackend();
            }

            if (!silent) {
                vscode.window.showInformationMessage('NeuroTrace backend removed. It will be re-downloaded on next activation.');
            }
        } else {
            if (!silent) {
                vscode.window.showInformationMessage('NeuroTrace backend is not currently downloaded.');
            }
        }
    }

    public cleanupLegacyBackend(options: { silent?: boolean } = {}): void {
        const { silent = false } = options;
        const platform = os.platform();
        const platformName = this.getPlatformName(platform);
        const legacyStoragePath = this.context.globalStorageUri.fsPath;
        const legacyPaths = [
            path.join(legacyStoragePath, `neurotrace-${platformName}`),
            path.join(legacyStoragePath, `neurotrace-backend-${platformName}`),
            path.join(legacyStoragePath, 'dist', `neurotrace-${platformName}`),
            path.join(legacyStoragePath, backendExecutableName(platform)),
            path.join(legacyStoragePath, 'backend-version.txt'),
            path.join(legacyStoragePath, 'backend-binary-version.txt'),
        ];

        let removed = false;
        try {
            this.terminateRunningBackendProcesses(legacyStoragePath);
        } catch (error) {
            console.warn('NeuroTrace: Failed to terminate legacy backend processes during cleanup:', error);
        }

        for (const legacyPath of legacyPaths) {
            if (!fs.existsSync(legacyPath)) {
                continue;
            }

            try {
                const isDirectory = fs.statSync(legacyPath).isDirectory();
                this.removePathWithRetries(legacyPath, { recursive: isDirectory, force: true });
                removed = true;
            } catch (error) {
                console.warn(`NeuroTrace: Failed to remove legacy backend path ${legacyPath}:`, error);
            }
        }

        if (removed) {
            console.log('NeuroTrace: Legacy backend storage cleaned up after migration.');
            if (!silent) {
                vscode.window.showInformationMessage('NeuroTrace legacy backend files removed after migration.');
            }
        }
    }

    private removePathWithRetries(targetPath: string, options?: fs.RmOptions): void {
        let lastError: unknown = null;

        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                fs.rmSync(targetPath, options);
                return;
            } catch (error) {
                lastError = error;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
            }
        }

        throw lastError;
    }

    private terminateRunningBackendProcesses(storagePath: string): void {
        const normalizedStoragePath = storagePath.replace(/\\/g, '\\\\');

        if (os.platform() === 'win32') {
            const script = [
                `$storage = '${normalizedStoragePath}'`,
                '$procs = Get-CimInstance Win32_Process | Where-Object {',
                "  $_.Name -eq 'neurotrace.exe' -and",
                '  $_.ExecutablePath -and',
                '  $_.ExecutablePath.StartsWith($storage, [System.StringComparison]::OrdinalIgnoreCase)',
                '}',
                'foreach ($proc in $procs) {',
                '  try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch {}',
                '}',
            ].join('\n');

            spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
            return;
        }

        const escapedStoragePath = storagePath.replace(/'/g, `'\\''`);
        const unixCommand = `ps -ax -o pid=,command= | grep -F '${escapedStoragePath}' | grep -F 'neurotrace' | grep -v grep | awk '{print $1}' | xargs -r kill -9`;
        spawnSync('bash', ['-lc', unixCommand], { encoding: 'utf8' });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
}
