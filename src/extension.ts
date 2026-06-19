import * as vscode from 'vscode';
import { NeuroTraceSidebarProvider } from './NeuroTraceSidebarProvider';
import * as commands from './commands';
import { PythonServerManager } from './PythonServerManager';
import { ThoughtGraphPanel } from './ThoughtGraphPanel';
import { AdvancedPanel } from './AdvancedPanel';
import { InstructionSyncPanel } from './instructionSync/InstructionSyncPanel';
import { GlobalUsageManager } from './GlobalUsageManager';
import { PasswordAttemptManager } from './PasswordAttemptManager';
import { registerMcpTools } from './McpServerManager';
import { registerMcpForCursor, configureMcpForExternalAgents, generateMcpWorkspaceFiles, ensureMcpWorkspaceFilesForInitializedWorkspace, getCodexUnlockTerminalLaunch, syncClaudeGlobalConfig, syncCursorGlobalConfig, syncGrokGlobalConfig, ensureCodexGlobalAgentsMd, ensureClaudeUserMemoryMd, ensureGrokGlobalMemoryMd } from './McpConfigManager';
import { WelcomeExperienceManager } from './welcomeExperience/WelcomeExperienceManager';

// Top-level state variable
let dbState: 'UNKNOWN' | 'NO_DB' | 'LOCKED' | 'UNENCRYPTED' | 'UNLOCKED' = 'UNKNOWN';
let globalGraphPanel: ThoughtGraphPanel | null = null;
let globalAdvancedPanel: AdvancedPanel | null = null;
let globalPasswordAttemptManager: PasswordAttemptManager | null = null;

/**
 * Main activation function for the NeuroTrace extension
 * Sets up all components, commands, and event handlers
 * @param context - The extension context provided by VS Code
 */
export async function activate(context: vscode.ExtensionContext) {
	console.log('NeuroTrace: Extension activated');
	const profileStartup = context.extensionMode !== vscode.ExtensionMode.Production;
	const activationStartedAt = Date.now();
	const logStartupStep = (label: string, stepStartedAt: number) => {
		if (!profileStartup) {
			return;
		}
		const stepMs = Date.now() - stepStartedAt;
		const totalMs = Date.now() - activationStartedAt;
		console.log(`NeuroTrace startup: ${label} (${stepMs}ms, total ${totalMs}ms)`);
	};
	let startupStepStartedAt = Date.now();

	// Never reopen the instruction sync panel automatically on startup.
	// The panel should only appear after an explicit user action.
	setTimeout(() => {
		void InstructionSyncPanel.closeRestoredPanels();
	}, 0);

	// Register webview panel serializers
	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer('neurotrace-graph', {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
				const serverManager = PythonServerManager.getInstance(context);
				const graphPanel = new ThoughtGraphPanel(context, serverManager);
				await graphPanel.show();
			}
		})
	);

	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer('neurotrace-advanced', {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
				const advancedPanel = new AdvancedPanel(context);
				await advancedPanel.show();
			}
		})
	);
	logStartupStep('register webview serializers', startupStepStartedAt);
	startupStepStartedAt = Date.now();

	// Initialize managers
	const serverManager = PythonServerManager.getInstance(context);
	const globalUsageManager = new GlobalUsageManager(context);
	globalPasswordAttemptManager = new PasswordAttemptManager(context);
	const welcomeExperienceManager = new WelcomeExperienceManager(context);

	// Register MCP tools for AI agents (Copilot)
	registerMcpTools(context, serverManager);

	// Auto-register as MCP server in Cursor (no-op if not in Cursor)
	registerMcpForCursor(context);

	// Auto-register as global MCP server in Cursor's persistent MCP config.
	syncCursorGlobalConfig(context);

	// Auto-register as global MCP server in Claude Code (CLI / IDE / desktop)
	// by upserting ~/.claude.json so NeuroTrace is plug-and-play with no manual setup.
	syncClaudeGlobalConfig(context);

	// Auto-register as global MCP server in Grok and enable Grok's memory file.
	syncGrokGlobalConfig(context);

	// Keep Codex's user-level AGENTS.md aligned with the NeuroTrace workflow.
	ensureCodexGlobalAgentsMd();

	// Keep Claude Code's user-level memory aligned with the NeuroTrace workflow.
	ensureClaudeUserMemoryMd();

	// Keep Grok's global memory aligned with the NeuroTrace workflow.
	ensureGrokGlobalMemoryMd();
	logStartupStep('initialize managers and MCP registration', startupStepStartedAt);
	startupStepStartedAt = Date.now();

	// Check if backend is available
	const { BackendDownloader } = require('./BackendDownloader');
	const backendDownloader = new BackendDownloader(context);

	// Initialize sidebar provider (needed before backend version check)
	const sidebarProvider = new NeuroTraceSidebarProvider(context, serverManager, globalUsageManager, globalPasswordAttemptManager, backendDownloader);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("neurotrace-sidebar", sidebarProvider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);
	logStartupStep('register sidebar provider', startupStepStartedAt);
	startupStepStartedAt = Date.now();

	// Check backend version and update if necessary
	const backendPath = backendDownloader.getBackendPath();
	let shouldStartBackendDuringActivation = false;
	let backendUpdateInProgress = false;

	if (backendPath) {
		const isVersionValid = backendDownloader.isBackendVersionValid();

		if (!isVersionValid) {
			const installedVersion = backendDownloader.getInstalledBackendVersion();
			console.log(`NeuroTrace: Backend version incompatible (installed: ${installedVersion || 'unknown'}, minimum required: ${require('./config.json').minimumBackendVersion})`);
			console.log('NeuroTrace: Updating backend silently to ensure compatibility...');
			backendUpdateInProgress = true;
			sidebarProvider.setLoadingMessage('Updating backend...');
			sidebarProvider.setDownloadStatus('downloading');
			void sidebarProvider.setInitialState('LOADING');

			// Update backend silently in the background without blocking activation
			(async () => {
				try {
					await serverManager.stopServerAndWait('update');
					const isLegacyMigration = backendDownloader.isUsingLegacyBackendStorage();
					if (!isLegacyMigration) {
						await backendDownloader.removeBackend({ silent: true });
					}
					const newBackendPath = await backendDownloader.downloadBackendSilently();

					if (newBackendPath) {
						if (isLegacyMigration) {
							try {
								backendDownloader.cleanupLegacyBackend({ silent: true });
							} catch (cleanupError) {
								console.warn('NeuroTrace: Legacy backend cleanup failed after migration:', cleanupError);
							}
						}
						console.log('NeuroTrace: Backend updated successfully, starting server...');
						await serverManager.startServerAndConfigureWorkspace();
						await backendDownloader.ensureCodexWslBackend();
						await ensureMcpWorkspaceFilesForInitializedWorkspace(context, { silent: true });
						await new Promise(resolve => setTimeout(resolve, 500));
						sidebarProvider.setDownloadStatus('success');
						sidebarProvider.setBackendStatus(true);
						backendUpdateInProgress = false;
						const action = await vscode.window.showInformationMessage(
							'NeuroTrace backend updated successfully. Reload the window to refresh all active integrations.',
							'Reload Window'
						);
						if (action === 'Reload Window') {
							await vscode.commands.executeCommand('workbench.action.reloadWindow');
						}
					} else {
						throw new Error('Failed to download new backend');
					}
				} catch (error) {
					console.error('NeuroTrace: Backend auto-update failed:', error);
					// Only notify user if automatic update fails
					const choice = await vscode.window.showErrorMessage(
						'NeuroTrace backend update failed. The extension may not work correctly.',
						'Retry Download',
						'Dismiss'
					);
					if (choice === 'Retry Download') {
						// Use the user-initiated download with progress notification
						await backendDownloader.downloadBackend();
						try {
							backendDownloader.cleanupLegacyBackend({ silent: true });
						} catch (cleanupError) {
							console.warn('NeuroTrace: Legacy backend cleanup failed after retry download:', cleanupError);
						}
						await serverManager.startServerAndConfigureWorkspace();
						await backendDownloader.ensureCodexWslBackend();
						await ensureMcpWorkspaceFilesForInitializedWorkspace(context, { silent: true });
						sidebarProvider.setDownloadStatus('success');
						sidebarProvider.setBackendStatus(true);
						backendUpdateInProgress = false;
						const action = await vscode.window.showInformationMessage(
							'NeuroTrace backend updated successfully. Reload the window to refresh all active integrations.',
							'Reload Window'
						);
						if (action === 'Reload Window') {
							await vscode.commands.executeCommand('workbench.action.reloadWindow');
						}
					} else {
						backendUpdateInProgress = false;
						sidebarProvider.setLoadingMessage('Loading...');
						sidebarProvider.setDownloadStatus('error');
						sidebarProvider.setBackendStatus(false);
					}
				}
			})();
		} else {
			const installedVersion = backendDownloader.getInstalledBackendVersion();
			console.log(`NeuroTrace: Backend version valid and compatible (${installedVersion || 'unknown'})`);
			try {
				backendDownloader.cleanupLegacyBackend({ silent: true });
			} catch (cleanupError) {
				console.warn('NeuroTrace: Opportunistic legacy backend cleanup failed:', cleanupError);
			}
			shouldStartBackendDuringActivation = true;
		}
	}
	logStartupStep('backend version check', startupStepStartedAt);
	startupStepStartedAt = Date.now();

	// Only start server if backend is available
	if (backendPath && shouldStartBackendDuringActivation) {
		console.log('NeuroTrace: Backend available, starting server...');
		void sidebarProvider.setInitialState('LOADING');
		void (async () => {
			const backendStartDispatchStartedAt = Date.now();
			serverManager.startServer();
			logStartupStep('dispatch backend start', backendStartDispatchStartedAt);

			// Wait a bit for the server to start before sending commands.
			const backendBootstrapWaitStartedAt = Date.now();
			await new Promise(resolve => setTimeout(resolve, 500));
			logStartupStep('wait for backend bootstrap', backendBootstrapWaitStartedAt);

			const workspaceInitStartedAt = Date.now();
			const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspacePath) {
				try {
					const setWorkspaceStartedAt = Date.now();
					const setWorkspaceResult = await serverManager.sendCommand<string>('set_workspace', { workspace: workspacePath });
					logStartupStep('set_workspace command', setWorkspaceStartedAt);
					console.log(`NeuroTrace: Backend workspace configured: ${setWorkspaceResult}`);

					const checkDbStatusStartedAt = Date.now();
					const result = await serverManager.sendCommand('check_db_status') as { status: typeof dbState };
					logStartupStep('check_db_status command', checkDbStatusStartedAt);
					dbState = result.status;
					sidebarProvider.setInitialState(dbState);
					if (dbState !== 'NO_DB') {
						setTimeout(() => {
							void ensureMcpWorkspaceFilesForInitializedWorkspace(context, { silent: true });
						}, 1000);
					}
				} catch (error) {
					console.error('NeuroTrace: Error setting workspace or checking DB status:', error);
					dbState = 'UNKNOWN';
					sidebarProvider.setInitialState(dbState);
					serverManager.reconnect().catch(err =>
						console.error('NeuroTrace: Error in reconnection:', err)
					);
				}
			}
			logStartupStep('workspace init and db status check', workspaceInitStartedAt);

			const validationStartedAt = Date.now();
			await globalUsageManager.validateLocalCount();
			logStartupStep('validate local usage state', validationStartedAt);
		})();
	} else if (backendUpdateInProgress) {
		console.log('NeuroTrace: Backend update in progress, suppressing missing-backend sidebar state');
	} else {
		console.log('NeuroTrace: Backend not available. Please download from sidebar.');
		// Notify sidebar that backend is not available
		sidebarProvider.setBackendStatus(false);
	}

	if (backendUpdateInProgress) {
		console.log('NeuroTrace: Deferring workspace initialization while backend update is in progress');
	} else if (!backendPath) {
		console.log('NeuroTrace: Backend not available, waiting for user to download');
	}

	setTimeout(() => {
		void welcomeExperienceManager.maybeShow();
	}, 0);
	logStartupStep('activate() complete', activationStartedAt);

	context.subscriptions.push(
		vscode.window.onDidChangeWindowState((state) => {
			if (!state.focused || dbState === 'NO_DB') {
				return;
			}
			void ensureMcpWorkspaceFilesForInitializedWorkspace(context, { silent: true });
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('neurotrace.retipEdge', async (edgeId) => {
			const rel = await vscode.window.showQuickPick(['causes', 'blocks', 'contradicts']);
			if (rel) {
				await serverManager.sendCommand('update-edge-type', { id: edgeId, rel });
			}
		})
	);


	// 3. Register all commands, passing the manager
	context.subscriptions.push(
		vscode.commands.registerCommand('neurotrace.unlockDatabase', async () => {
			if (!globalPasswordAttemptManager) {
				vscode.window.showErrorMessage('Password attempt manager not initialized.');
				return;
			}

			const lockStatus = await globalPasswordAttemptManager.isLocked();
			if (lockStatus.locked) {
				vscode.window.showErrorMessage(
					`Database is locked due to too many failed attempts. Please try again in ${lockStatus.remainingMinutes} minutes.`
				);
				return;
			}

			const currentAttempts = await globalPasswordAttemptManager.getCurrentAttempts();
			const attemptsRemaining = 5 - currentAttempts;

			const promptMessage = currentAttempts > 0
				? `Enter database passphrase (${currentAttempts}/5 attempts)`
				: 'Enter database passphrase';

			const password = await vscode.window.showInputBox({
				prompt: promptMessage,
				password: true,
				ignoreFocusOut: true
			});
			if (!password) { return; }

			const result = await serverManager.sendCommand('unlock_database', { password }) as { status: string };
			if (result.status === 'ok') {
				await globalPasswordAttemptManager.resetAttempts();
				dbState = 'UNLOCKED';
				vscode.window.showInformationMessage('Database unlocked successfully.');
				sidebarProvider.setInitialState(dbState);
				sidebarProvider.refresh();
			} else {
				const attemptResult = await globalPasswordAttemptManager.recordFailedAttempt();

				if (attemptResult.locked) {
					vscode.window.showErrorMessage(
						`Invalid passphrase. Too many failed attempts. Database locked for ${attemptResult.lockoutMinutes} minutes.`
					);
				} else {
					vscode.window.showErrorMessage(
						`Invalid passphrase. ${attemptResult.attemptsRemaining} attempts remaining.`
					);
				}
			}
		}),

		vscode.commands.registerCommand('neurotrace.unlockDatabaseForCodex', async () => {
			const launch = await getCodexUnlockTerminalLaunch(context);
			if (!launch) {
				vscode.window.showErrorMessage(
					'Unable to prepare the Codex unlock command. Make sure a workspace is open and the NeuroTrace backend is installed.'
				);
				return;
			}

			const terminal = vscode.window.createTerminal({
				name: launch.name,
				shellPath: launch.shellPath,
				shellArgs: launch.shellArgs,
				cwd: launch.cwd
			});

			terminal.show(true);
			vscode.window.showInformationMessage(
				'NeuroTrace opened the integrated terminal for Codex. Enter your database passphrase there to unlock the WSL backend.'
			);
		}),

		vscode.commands.registerCommand('neurotrace.encryptDatabase', async () => {
			const consent = await vscode.window.showWarningMessage(
				"Encrypting the database is irreversible without the passphrase. If you lose it, your data will be lost forever. Proceed?",
				{ modal: true },
				"I understand, encrypt the database"
			);
			if (consent !== "I understand, encrypt the database") { return; }

			const password = await vscode.window.showInputBox({ prompt: 'Enter a new passphrase for encryption', password: true, ignoreFocusOut: true });
			if (!password) { return; }

			const confirmPassword = await vscode.window.showInputBox({ prompt: 'Confirm passphrase', password: true, ignoreFocusOut: true });
			if (password !== confirmPassword) {
				vscode.window.showErrorMessage('Passphrases do not match.');
				return;
			}

			try {
				const result = await serverManager.sendCommand('encrypt_database', { password }) as { status: string; message?: string };
				if (result.status === 'ok') {
					dbState = 'UNLOCKED';
					vscode.window.showInformationMessage('Database encrypted successfully.');
					sidebarProvider.setInitialState(dbState);
					sidebarProvider.refresh();
				} else {
					vscode.window.showErrorMessage(`Encryption failed: ${result.message || 'Unknown error'}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Error encrypting database: ${message}`);
			}
		}),

		vscode.commands.registerCommand('neurotrace.decryptDatabase', async () => {
			const password = await vscode.window.showInputBox({ prompt: 'Enter current passphrase to decrypt', password: true, ignoreFocusOut: true });
			if (!password) { return; }

			try {
				const result = await serverManager.sendCommand('decrypt_database', { password }) as { status: string; message?: string };
				if (result.status === 'ok') {
					dbState = 'UNENCRYPTED';
					vscode.window.showInformationMessage('Database decrypted successfully.');
					sidebarProvider.setInitialState(dbState);
					sidebarProvider.refresh();
				} else {
					vscode.window.showErrorMessage(`Decryption failed: ${result.message || 'Unknown error'}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Error decrypting database: ${message}`);
			}
		}),

		vscode.commands.registerCommand('neurotrace.init',
			() => commands.initCommand(context, serverManager, sidebarProvider)),

		vscode.commands.registerCommand('neurotrace.downloadBackend', async () => {
			try {
				// Notify UI that download is starting
				sidebarProvider.setDownloadStatus('downloading');

				const backendPath = await backendDownloader.downloadBackend();

				if (backendPath) {
					// Backend downloaded successfully
					sidebarProvider.setDownloadStatus('success');

					// Show LOADING spinner IMMEDIATELY after download completes
					await sidebarProvider.setInitialState('LOADING');

					// Small delay to ensure LOADING state is processed before hiding download container
					await new Promise(resolve => setTimeout(resolve, 100));

					// Now hide download container and start server
					sidebarProvider.setBackendStatus(true);
					serverManager.startServer();

					// Wait for server to start
					await new Promise(resolve => setTimeout(resolve, 1000));

					// Initialize workspace if available
					const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (workspacePath) {
						try {
							await serverManager.sendCommand('set_workspace', { workspace: workspacePath });

							const result = await serverManager.sendCommand('check_db_status') as { status: string };
							await sidebarProvider.setInitialState(result.status);
							if (result.status !== 'NO_DB') {
								void ensureMcpWorkspaceFilesForInitializedWorkspace(context, { silent: true });
							}
						} catch (error) {
							console.error('NeuroTrace: Error initializing after backend download:', error);
							vscode.window.showErrorMessage('Failed to initialize NeuroTrace. Please try again.');
						}
					}

					vscode.window.showInformationMessage('NeuroTrace is now ready to use!');
				} else {
					// Download cancelled or failed
					sidebarProvider.setDownloadStatus('error');
				}
			} catch (error) {
				console.error('NeuroTrace: Error downloading backend:', error);
				sidebarProvider.setDownloadStatus('error');
				vscode.window.showErrorMessage('Failed to download backend. Please try again.');
			}
		}),

		vscode.commands.registerCommand('neurotrace.addThought',
			() => commands.addThoughtCommand(serverManager, sidebarProvider, globalUsageManager)),

		vscode.commands.registerCommand('neurotrace.editThought',
			(id: string) => commands.editThoughtCommand(serverManager, sidebarProvider, id)),

		vscode.commands.registerCommand('neurotrace.showMemoriesForCurrentFile',
			() => commands.showMemoriesForCurrentFileCommand(serverManager, sidebarProvider)),

		vscode.commands.registerCommand('neurotrace.deleteThought',
			(id: string) => commands.deleteThoughtCommand(serverManager, sidebarProvider, id, globalGraphPanel)),

		vscode.commands.registerCommand('neurotrace.search',
			(searchTerm: string) => commands.searchCommand(serverManager, sidebarProvider, searchTerm)),

		vscode.commands.registerCommand('neurotrace.semanticSearch',
			(searchTerm: string) => commands.semanticSearchCommand(serverManager, sidebarProvider, searchTerm)),

		vscode.commands.registerCommand('neurotrace.openThought', async (thoughtId) => {
			sidebarProvider._view?.show(true);
			const thought = await sidebarProvider.getThoughtById(thoughtId);

			// If the thought has file path and line, open it in the editor
			if (thought && thought.file_path && thought.line) {
				const fileUri = vscode.Uri.file(thought.file_path);
				const line = thought.line - 1; // Lines in VS Code are 0-based

				try {
					const doc = await vscode.workspace.openTextDocument(fileUri);
					const editor = await vscode.window.showTextDocument(doc, { preview: false });
					if (!editor) {
						throw new Error(`Could not open document: ${fileUri.fsPath}`);
					}
					editor.selection = new vscode.Selection(line, 0, line, 0);
					editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
					sidebarProvider._view?.webview.postMessage({ type: 'open', id: thoughtId });
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(`Error opening file: ${errorMessage}`);
				}
			} else {
				if (thought) {
					sidebarProvider._view?.webview.postMessage({ type: 'open', id: thoughtId });
				}
			}
		}),

		vscode.commands.registerCommand('neurotrace.suggestRelated',
			(id: string) => commands.suggestRelatedCommand(serverManager, sidebarProvider, id)),

		vscode.commands.registerCommand('neurotrace.advancedExport',
			() => commands.advancedExportCommand(serverManager)),

		vscode.commands.registerCommand('neurotrace.toggleCodeIcons',
			() => commands.toggleCodeIconsCommand(context, sidebarProvider)),

		vscode.commands.registerCommand('neurotrace.openGraph',
			async () => {
				globalGraphPanel = await commands.openGraphCommand(context, serverManager, (panel) => {
					globalGraphPanel = panel;
				});
			}),

		vscode.commands.registerCommand('neurotrace.openAdvanced',
			async () => {
				globalAdvancedPanel = await commands.openAdvancedCommand(context, (panel) => {
					globalAdvancedPanel = panel;
				});
			}),

		vscode.commands.registerCommand('neurotrace.redownloadBackend',
			async () => {
				await commands.redownloadBackendCommand(context, serverManager);
			}
		),

		vscode.commands.registerCommand('neurotrace.configureMcp',
			() => configureMcpForExternalAgents(context)
		),

		vscode.commands.registerCommand('neurotrace.generateMcpFiles',
			() => generateMcpWorkspaceFiles(context)
		),

		vscode.commands.registerCommand('neurotrace.openInstructionSync',
			() => InstructionSyncPanel.show(context)
		),

		vscode.commands.registerCommand('neurotrace.refreshSidebar',
			async () => {
				if (dbState !== 'NO_DB') {
					await ensureMcpWorkspaceFilesForInitializedWorkspace(context, { silent: true });
				}
				sidebarProvider.refresh();
			}),

	);
}

/**
 * Cleanup function called when the extension is deactivated
 * Stops the Python server and cleans up resources
 */
export function deactivate() {
	PythonServerManager.getInstance(null as any).stopServer();
	console.log('NeuroTrace: Extension deactivated');
}
