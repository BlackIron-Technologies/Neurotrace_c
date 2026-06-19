import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PythonServerManager } from './PythonServerManager';
import { GlobalUsageManager } from './GlobalUsageManager';
import { getUIUpdateInterval } from './constants';

export class NeuroTraceSidebarProvider implements vscode.WebviewViewProvider {
  public _view?: vscode.WebviewView;
  private _thoughts: any[] = []; // Local cache of thoughts
  private _thoughtDecorations: vscode.TextEditorDecorationType;
  private _taskDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();
  private _thoughtLocations: Map<string, Map<number, string>> = new Map();
  private _originalThoughts: any[] = [];
  private _fileFilterThoughts: any[] = [];
  private _isSearchMode: boolean = false;
  private _isFileFilterMode: boolean = false;
  private _showCodeIcons: boolean = true;
  private _isFilteredByType: boolean = false;
  private _filteredType: string | null = null;
  private _currentSearchTerm: string = '';
  private _currentFileFilterPath: string | null = null;
  private _currentPage: number = 0;
  private _pageSize: number = 15;
  private _totalThoughts: number = 0;
  private _isFirstLoad: boolean = true;
  private _usageStats: {
    monthlyThoughtCount: number;
  } | null = null;
  private _dbState: string = 'UNKNOWN';
  private _isLoggedIn: boolean = false;
  private _userProfile: {
    github_username: string;
    role?: string;
  } | null = null;
  private _usageUpdateTimer?: NodeJS.Timeout;
  private _externalSyncTimer?: NodeJS.Timeout;
  private _externalSyncInFlight: boolean = false;
  private _backendDownloader: any;
  private _backendAvailable: boolean = false;
  private _loadingMessage: string = 'Loading...';

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly serverManager: PythonServerManager,
    private readonly globalUsageManager: GlobalUsageManager,
    private readonly passwordAttemptManager?: any,
    backendDownloader?: any
  ) {
    this._backendDownloader = backendDownloader;
    this._backendAvailable = backendDownloader ? backendDownloader.isBackendDownloaded() : false;

    this._thoughtDecorations = vscode.window.createTextEditorDecorationType({
      before: {
        contentIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNicgaGVpZ2h0PScxNicgdmlld0JveD0nMCAwIDE2IDE2Jz48Y2lyY2xlIGN4PSc4JyBjeT0nOCcgcj0nNi41JyBmaWxsPScjZmZmZmZmJyBzdHJva2U9JyNkZmU0ZWEnIHN0cm9rZS13aWR0aD0nMS4yJy8+PC9zdmc+'),
        margin: '0 6px 0 0'
      }
    });
    this._context.subscriptions.push(this._thoughtDecorations);

    this._taskDecorations.set('Low', vscode.window.createTextEditorDecorationType({
      before: {
        contentIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNicgaGVpZ2h0PScxNicgdmlld0JveD0nMCAwIDE2IDE2Jz48Y2lyY2xlIGN4PSc4JyBjeT0nOCcgcj0nNi41JyBmaWxsPScjMmVjYzcxJyBzdHJva2U9JyMyN2FlNjAnIHN0cm9rZS13aWR0aD0nMS4yJy8+PC9zdmc+'),
        margin: '0 6px 0 0'
      }
    }));

    this._taskDecorations.set('Moderate', vscode.window.createTextEditorDecorationType({
      before: {
        contentIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNicgaGVpZ2h0PScxNicgdmlld0JveD0nMCAwIDE2IDE2Jz48Y2lyY2xlIGN4PSc4JyBjeT0nOCcgcj0nNi41JyBmaWxsPScjZjFjNDBmJyBzdHJva2U9JyNkNGFjMGQnIHN0cm9rZS13aWR0aD0nMS4yJy8+PC9zdmc+'),
        margin: '0 6px 0 0'
      }
    }));

    this._taskDecorations.set('High', vscode.window.createTextEditorDecorationType({
      before: {
        contentIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNicgaGVpZ2h0PScxNicgdmlld0JveD0nMCAwIDE2IDE2Jz48Y2lyY2xlIGN4PSc4JyBjeT0nOCcgcj0nNi41JyBmaWxsPScjZTc0YzNjJyBzdHJva2U9JyNjMDM5MmInIHN0cm9rZS13aWR0aD0nMS4yJy8+PC9zdmc+'),
        margin: '0 6px 0 0'
      }
    }));
    this._taskDecorations.forEach(decoration => this._context.subscriptions.push(decoration));

    // Initialize code icons state from configuration
    const config = vscode.workspace.getConfiguration('neurotrace');
    this._showCodeIcons = config.get('showCodeIcons', true);

    // Listen for configuration changes
    this._context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('neurotrace.showCodeIcons')) {
          const config = vscode.workspace.getConfiguration('neurotrace');
          this.setShowCodeIcons(config.get('showCodeIcons', true));
        }
      })
    );
  }

  /**
   * Sets the initial database state and updates the webview accordingly
   * @param state The current database state ('UNKNOWN' | 'NO_DB' | 'LOCKED' | 'UNENCRYPTED' | 'UNLOCKED')
   */
  public async setInitialState(state: string) {
    this._dbState = state;
    if (this._view) {
      // Add a small delay to ensure webview is ready to receive messages
      // This prevents messages from being lost if sent too early
      if (state === 'LOADING') {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      this._view.webview.postMessage({
        type: 'updateState',
        state: this._dbState,
        backendAvailable: this._backendAvailable,
        loadingText: this._loadingMessage
      });

      if (state === 'LOCKED' && this.passwordAttemptManager) {
        const lockStatus = await this.passwordAttemptManager.isLocked();
        const currentAttempts = await this.passwordAttemptManager.getCurrentAttempts();

        this._view.webview.postMessage({
          type: 'lockStatus',
          locked: lockStatus.locked,
          remainingMinutes: lockStatus.remainingMinutes,
          currentAttempts: currentAttempts
        });
      }
    }
    this.updateTitle();
  }

  /**
   * Sets the backend availability status
   * @param available Whether the backend is available or not
   */
  public setBackendStatus(available: boolean) {
    this._backendAvailable = available;
    if (this._view) {
      this._view.webview.postMessage({
        type: 'backendStatus',
        available: available
      });
    }
  }

  /**
   * Updates the download status in the UI
   * @param status The download status: 'downloading', 'success', or 'error'
   */
  public setDownloadStatus(status: 'downloading' | 'success' | 'error') {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'downloadStatus',
        status: status
      });
    }
  }

  public setLoadingMessage(message: string) {
    this._loadingMessage = message;
    if (this._view) {
      this._view.webview.postMessage({
        type: 'updateState',
        state: this._dbState,
        backendAvailable: this._backendAvailable,
        loadingText: this._loadingMessage
      });
    }
  }

  public async updateAuthenticationStatus() {
    this._isLoggedIn = false;
    this._userProfile = null;
    await this._context.globalState.update('user_profile', null);
    if (this._view) {
      await this.updateUsageDisplay();
    }
  }

  private async updateUsageDisplay() {
    if (!this._view) {
      return;
    }

    const usageText = this.localizeSidebarUsageText(
      await this.globalUsageManager.getUsageDisplayText()
    );
    const hasFeatureAccess = await this.hasFeatureAccess();

    this._view.webview.postMessage({
      type: 'updateUsage',
      usageText: usageText,
      isLoggedIn: this._isLoggedIn,
      userProfile: this._userProfile,
      hasFeatureAccess: hasFeatureAccess
    });
  }

  private localizeSidebarUsageText(text: string): string {
    return text
      .replace(/\bthoughts\b/g, 'memories')
      .replace(/\bThoughts\b/g, 'Memories')
      .replace(/\bthought\b/g, 'memory')
      .replace(/\bThought\b/g, 'Memory');
  }

  private updateTitle() {
    if (this._view) {
      const icon = (this._dbState === 'LOCKED' || this._dbState === 'UNLOCKED') ? '🛡️' : '💭';
      this._view.webview.postMessage({ type: 'updateIcon', icon: icon });
    }
  }

  /**
   * Start a timer to update usage display periodically
   * PRODUCTION: Updates every 1 hour (3600000 ms)
   * This keeps usage metadata in the sidebar fresh without user interaction
   */
  private startUsageUpdateTimer() {
    // Clear any existing timer
    if (this._usageUpdateTimer) {
      clearInterval(this._usageUpdateTimer);
    }

    // Update immediately
    this.updateUsageDisplay();

    // Get update interval based on testing mode
    const updateInterval = getUIUpdateInterval();

    // Update at configured interval
    this._usageUpdateTimer = setInterval(() => {
      this.updateUsageDisplay();
    }, updateInterval);

    // Add to subscriptions for cleanup
    this._context.subscriptions.push({
      dispose: () => {
        if (this._usageUpdateTimer) {
          clearInterval(this._usageUpdateTimer);
          this._usageUpdateTimer = undefined;
        }
      }
    });
  }

  /**
   * Stop the usage update timer
   */
  private stopUsageUpdateTimer() {
    if (this._usageUpdateTimer) {
      clearInterval(this._usageUpdateTimer);
      this._usageUpdateTimer = undefined;
    }
  }

  /**
   * Creates a lightweight polling loop to detect changes made outside the sidebar
   * (e.g. external MCP clients such as Codex) and refreshes automatically.
   */
  private startExternalSyncTimer() {
    if (this._externalSyncTimer) {
      clearInterval(this._externalSyncTimer);
    }

    this._externalSyncTimer = setInterval(async () => {
      if (this._externalSyncInFlight || !this._view || !this._view.visible) {
        return;
      }

      if (this._dbState !== 'UNLOCKED' && this._dbState !== 'UNENCRYPTED') {
        return;
      }

      // Avoid disrupting active search/filter flows with background refreshes.
      if (this._isSearchMode || this._isFilteredByType) {
        return;
      }

      this._externalSyncInFlight = true;
      try {
        const response = await this.serverManager.sendCommand('list', {
          page: this._currentPage,
          page_size: this._pageSize
        }) as any;

        const incomingThoughts = response?.thoughts ?? [];
        const incomingTotal = response?.total ?? 0;

        const currentSignature = this.buildThoughtsSignature(this._thoughts);
        const incomingSignature = this.buildThoughtsSignature(incomingThoughts);

        if (incomingTotal !== this._totalThoughts || incomingSignature !== currentSignature) {
          await this.refresh(this._currentPage);
        }
      } catch {
        // Best-effort background sync; ignore transient backend errors.
      } finally {
        this._externalSyncInFlight = false;
      }
    }, 4000);

    this._context.subscriptions.push({
      dispose: () => {
        if (this._externalSyncTimer) {
          clearInterval(this._externalSyncTimer);
          this._externalSyncTimer = undefined;
        }
      }
    });
  }

  private stopExternalSyncTimer() {
    if (this._externalSyncTimer) {
      clearInterval(this._externalSyncTimer);
      this._externalSyncTimer = undefined;
    }
  }

  private buildThoughtsSignature(thoughts: any[]): string {
    return thoughts
      .map((t: any) => `${t.id ?? ''}|${t.timestamp ?? ''}|${t.type ?? ''}|${t.tags ?? ''}|${t.text ?? ''}|${t.priority ?? ''}|${t.status ?? ''}|${t.file_path ?? ''}|${t.line ?? ''}|${t.snippet ?? ''}`)
      .join('||');
  }

  private getTaskStatusGroup(status?: string): number {
    const normalized = String(status || 'open').toLowerCase();
    if (normalized === 'closed' || normalized === 'obsolete') {
      return 2;
    }
    return 0;
  }

  private getTaskPriorityRank(priority?: string): number {
    const normalized = String(priority || '').toLowerCase();
    if (normalized === 'high') { return 0; }
    if (normalized === 'moderate' || normalized === 'medium') { return 1; }
    if (normalized === 'low') { return 2; }
    return 3;
  }

  private sortTasksForDisplay(thoughts: any[]): any[] {
    return [...thoughts].sort((a, b) => {
      const groupRankDiff = this.getTaskStatusGroup(a.status) - this.getTaskStatusGroup(b.status);
      if (groupRankDiff !== 0) {
        return groupRankDiff;
      }

      const priorityDiff = this.getTaskPriorityRank(a.priority) - this.getTaskPriorityRank(b.priority);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      const lineA = Number.isInteger(a.line) ? a.line : Number.MAX_SAFE_INTEGER;
      const lineB = Number.isInteger(b.line) ? b.line : Number.MAX_SAFE_INTEGER;
      if (lineA !== lineB) {
        return lineA - lineB;
      }

      return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
    });
  }

  private getFilteredThoughts(sourceThoughts: any[]): any[] {
    if (!this._isFilteredByType || !this._filteredType) {
      return [...sourceThoughts];
    }

    const filteredThoughts = sourceThoughts.filter(t => t.type === this._filteredType);

    if (this._filteredType === 'task') {
      return this.sortTasksForDisplay(filteredThoughts);
    }

    return filteredThoughts;
  }

  private async initializeUserState() {
    if (!this._view) {
      return;
    }

    this._isLoggedIn = false;
    this._userProfile = null;
    await this._context.globalState.update('user_profile', null);
    await this.updateUsageDisplay();
    this._view.webview.postMessage({
      type: 'initUserState',
      isLoggedIn: false,
      userProfile: null
    });
  }

  /**
   * Public method to refresh authentication status
   */
  public async refreshAuthStatus() {
    await this.updateAuthenticationStatus();
  }

  private async hasFeatureAccess(): Promise<boolean> {
    return true;
  }

  private async checkAuthStatus() {
    await this.updateAuthenticationStatus();
  }


  /**
   * Adds a new thought to the local cache and updates the webview
   * @param thought The thought object to add
   */
  public async addThought(thought: any) {
    if (this._isFileFilterMode && this._currentFileFilterPath) {
      const normalizedFilterPath = this.normalizePathForDecorations(this._currentFileFilterPath);
      const normalizedThoughtPath = this.normalizePathForDecorations(thought.file_path || '');
      if (normalizedFilterPath && normalizedThoughtPath && normalizedFilterPath !== normalizedThoughtPath) {
        await this.showMemoriesForFile(this._currentFileFilterPath);
        return;
      }
    }

    const existingIndex = this._thoughts.findIndex(t => t.id === thought.id);
    if (existingIndex !== -1) {
      this._thoughts[existingIndex] = thought;
    } else {
      this._thoughts.unshift(thought);
      this._totalThoughts++;
    }

    if (this._isSearchMode) {
      const originalIndex = this._originalThoughts.findIndex(t => t.id === thought.id);
      if (originalIndex !== -1) {
        this._originalThoughts[originalIndex] = thought;
      }
    }

    if (this._isFileFilterMode) {
      const fileFilterIndex = this._fileFilterThoughts.findIndex(t => t.id === thought.id);
      if (fileFilterIndex !== -1) {
        this._fileFilterThoughts[fileFilterIndex] = thought;
      } else {
        this._fileFilterThoughts.unshift(thought);
      }
    }

    const hasFeatureAccess = await this.hasFeatureAccess();

    this._view?.webview.postMessage({
      type: 'add',
      data: thought,
      pagination: {
        current: this._currentPage,
        total: Math.ceil(this._totalThoughts / this._pageSize),
        hasMore: this._totalThoughts > this._pageSize
      },
      hasFeatureAccess: hasFeatureAccess
    });

    this.updateThoughtLocations();
    await this.updateUsageDisplay();
  }

  /**
   * Removes a thought from the local cache and updates the webview
   * @param id The ID of the thought to delete
   */
  public deleteThought(id: string) {
    this._thoughts = this._thoughts.filter(t => t.id !== id);
    this._originalThoughts = this._originalThoughts.filter(t => t.id !== id);
    this._fileFilterThoughts = this._fileFilterThoughts.filter(t => t.id !== id);
    this._totalThoughts--;
    const totalPages = Math.ceil(this._totalThoughts / this._pageSize);

    if (this._currentPage >= totalPages && totalPages > 0) {
      this._currentPage = totalPages - 1;
    }

    this._view?.webview.postMessage({
      type: 'delete',
      id: id,
      isSearchMode: this._isSearchMode,
      searchTerm: this._currentSearchTerm,
      remainingCount: this._thoughts.length,
      pagination: {
        current: this._currentPage,
        total: totalPages,
        hasMore: this._totalThoughts > this._pageSize
      }
    });

    this.updateThoughtLocations();
  }

  /**
   * Retrieves a thought by its ID from the local cache
   * @param id The ID of the thought to retrieve
   * @returns The thought object if found, undefined otherwise
   */
  public async getThoughtById(id: string): Promise<any | undefined> {
    return this._thoughts.find(t => t.id === id);
  }

  private normalizePathForDecorations(inputPath: string): string {
    if (!inputPath) {
      return '';
    }

    let normalized = inputPath.trim();

    // Convert WSL path (/mnt/c/Users/...) to Windows-like path (c:/Users/...)
    const wslMatch = normalized.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (wslMatch) {
      const drive = wslMatch[1].toLowerCase();
      const rest = wslMatch[2];
      normalized = `${drive}:/${rest}`;
    }

    // Normalize separators and case for stable map keys on Windows.
    return normalized.replace(/\\/g, '/').toLowerCase();
  }

  private updateThoughtLocations() {
    this._thoughtLocations.clear();
    const thoughtsForDecorations = this._isFileFilterMode
      ? this._thoughts
      : (this._isSearchMode ? this._originalThoughts : this._thoughts);
    for (const thought of thoughtsForDecorations) {
      if (thought.file_path && thought.line) {
        const normalizedPath = this.normalizePathForDecorations(thought.file_path);
        if (!this._thoughtLocations.has(normalizedPath)) {
          this._thoughtLocations.set(normalizedPath, new Map());
        }
        this._thoughtLocations.get(normalizedPath)?.set(thought.line, thought.id);
      }
    }
    this.updateDecorations();
  }

  private updateDecorations() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this._showCodeIcons) {
      if (editor) {
        editor.setDecorations(this._thoughtDecorations, []);
        for (const decoration of this._taskDecorations.values()) {
          editor.setDecorations(decoration, []);
        }
      }
      return;
    }

    const filePath = this.normalizePathForDecorations(editor.document.fileName);
    const lineMap = this._thoughtLocations.get(filePath);

    if (!lineMap) {
      editor.setDecorations(this._thoughtDecorations, []);
      for (const decoration of this._taskDecorations.values()) {
        editor.setDecorations(decoration, []);
      }
      return;
    }

    const generalDecorations: vscode.DecorationOptions[] = [];
    const taskDecorations: Map<string, vscode.DecorationOptions[]> = new Map();
    taskDecorations.set('Low', []);
    taskDecorations.set('Moderate', []);
    taskDecorations.set('High', []);

    for (const [lineStr, thoughtId] of lineMap.entries()) {
      const line = parseInt(lineStr.toString(), 10);
      const thought = this._thoughts.find(t => t.id === thoughtId) || this._originalThoughts.find(t => t.id === thoughtId);
      const markdownMessage = new vscode.MarkdownString();
      markdownMessage.isTrusted = true;
      markdownMessage.appendMarkdown(`**NeuroTrace**: [Open Thought](command:neurotrace.openThought?${encodeURI(JSON.stringify([thoughtId]))})`);

      const decorationOption: vscode.DecorationOptions = {
        range: new vscode.Range(new vscode.Position(line - 1, 0), new vscode.Position(line - 1, 0)),
        hoverMessage: markdownMessage
      };

      if (thought && thought.type === 'task' && thought.priority && this._taskDecorations.has(thought.priority)) {
        taskDecorations.get(thought.priority)?.push(decorationOption);
      } else {
        generalDecorations.push(decorationOption);
      }
    }

    editor.setDecorations(this._thoughtDecorations, generalDecorations);
    for (const [priority, decorations] of taskDecorations.entries()) {
      const decorationType = this._taskDecorations.get(priority);
      if (decorationType) {
        editor.setDecorations(decorationType, decorations);
      }
    }
  }

  /**
   * Resolves the webview view for the sidebar panel
   * Sets up webview options, HTML content, and message handling
   * @param webviewView The webview view to resolve
   */
  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // Don't send LOADING state automatically - let extension.ts control the initial state
    // LOADING state should only be sent explicitly during backend download process
    // If backend is already available, extension.ts will send the correct DB state immediately

    // Send initial backend status
    if (this._view) {
      setTimeout(() => {
        if (this._view) {
          this._view.webview.postMessage({
            type: 'backendStatus',
            available: this._backendAvailable
          });
        }
      }, 150);
    }

    // Initialize user state immediately after setting up the webview
    this.initializeUserState();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this.handleWebviewMessage(message);
    });

    this.refresh();

    this.updateTitle();

    // Start the usage update timer to keep sidebar metadata current
    this.startUsageUpdateTimer();

    // Detect external MCP mutations and keep sidebar in sync automatically
    this.startExternalSyncTimer();

    // Listen for webview visibility changes to update usage when it becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // Refresh usage display when sidebar becomes visible
        this.updateUsageDisplay();
      }
    });

    // Clean up timer when webview is disposed
    webviewView.onDidDispose(() => {
      this.stopUsageUpdateTimer();
      this.stopExternalSyncTimer();
    });

    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.updateDecorations()),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
          this.updateDecorations();
        }
      })
    );
  }

  private async handleWebviewMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'init':
        vscode.commands.executeCommand('neurotrace.init');
        break;
      case 'edit':
        vscode.commands.executeCommand('neurotrace.editThought', message.id);
        break;
      case 'delete':
        vscode.commands.executeCommand('neurotrace.deleteThought', message.id);
        break;
      case 'suggest':
        vscode.commands.executeCommand('neurotrace.suggestRelated', message.id);
        break;
      case 'refresh':
        this.refresh();
        break;
      case 'search':
        vscode.commands.executeCommand('neurotrace.search', message.searchTerm);
        break;
      case 'semanticSearch':
        vscode.commands.executeCommand('neurotrace.semanticSearch', message.searchTerm);
        break;
      case 'unlockForCodex':
        vscode.commands.executeCommand('neurotrace.unlockDatabaseForCodex');
        break;
      case 'unlock':
        await this.handleUnlockMessage(message.password);
        break;
      case 'restoreOriginal':
        this.restoreOriginalThoughts();
        break;
      case 'open':
        await this.handleOpenThoughtMessage(message.id);
        break;
      case 'encrypt':
        vscode.commands.executeCommand('neurotrace.encryptDatabase');
        break;
      case 'decrypt':
        vscode.commands.executeCommand('neurotrace.decryptDatabase');
        break;
      case 'advanced-export':
        vscode.commands.executeCommand('neurotrace.advancedExport');
        break;
      case 'open-graph':
        vscode.commands.executeCommand('neurotrace.openGraph');
        break;
      case 'open-instruction-sync':
        vscode.commands.executeCommand('neurotrace.openInstructionSync');
        break;
      case 'advanced':
        vscode.commands.executeCommand('neurotrace.openAdvanced');
        break;
      case 'filterByType':
        this.filterByType(message.thoughtType);
        break;
      case 'loadMore':
        this.loadMoreThoughts();
        break;
      case 'gotoPage':
        await this.gotoPage(message.page);
        break;
      case 'addThought':
        vscode.commands.executeCommand('neurotrace.addThought');
        break;
      case 'deleteMultiple':
        await this.handleDeleteMultipleMessage(message.ids);
        break;
      case 'downloadBackend':
        vscode.commands.executeCommand('neurotrace.downloadBackend');
        break;
    }
  }

  private async handleUnlockMessage(password: string): Promise<void> {
    try {
      if (!this.passwordAttemptManager) {
        vscode.window.showErrorMessage('Password attempt manager not initialized.');
        return;
      }

      const lockStatus = await this.passwordAttemptManager.isLocked();
      if (lockStatus.locked) {
        this._view?.webview.postMessage({
          type: 'unlockError',
          message: `Database locked due to too many failed attempts. Try again in ${lockStatus.remainingMinutes} minutes.`,
          locked: true,
          remainingMinutes: lockStatus.remainingMinutes
        });
        return;
      }

      const result = await this.serverManager.sendCommand('unlock_database', { password }) as { status: string };
      if (result.status === 'ok') {
        await this.passwordAttemptManager.resetAttempts();
        this._dbState = 'UNLOCKED';
        this._view?.webview.postMessage({
          type: 'unlockSuccess'
        });
        this._view?.webview.postMessage({
          type: 'updateState',
          state: this._dbState,
          backendAvailable: this._backendAvailable,
          loadingText: this._loadingMessage
        });
        this.refresh();
        this.updateTitle();
        vscode.window.showInformationMessage('Database unlocked successfully.');
        return;
      }

      const attemptResult = await this.passwordAttemptManager.recordFailedAttempt();
      if (attemptResult.locked) {
        this._view?.webview.postMessage({
          type: 'unlockError',
          message: `Invalid passphrase. Too many failed attempts. Database locked for ${attemptResult.lockoutMinutes} minutes.`,
          locked: true,
          lockoutMinutes: attemptResult.lockoutMinutes
        });
      } else {
        this._view?.webview.postMessage({
          type: 'unlockError',
          message: `Invalid passphrase. ${attemptResult.attemptsRemaining} attempts remaining.`,
          locked: false,
          attemptsRemaining: attemptResult.attemptsRemaining
        });
      }
    } catch (e) {
      vscode.window.showErrorMessage('Error unlocking database.');
    }
  }

  private async handleOpenThoughtMessage(thoughtId: string): Promise<void> {
    const thought = await this.getThoughtById(thoughtId);
    if (!thought || !thought.file_path || !thought.line) {
      return;
    }

    const fileUri = vscode.Uri.file(thought.file_path);
    const line = thought.line - 1;
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  }

  private async handleDeleteMultipleMessage(ids: unknown): Promise<void> {
    if (!Array.isArray(ids)) {
      return;
    }

    for (const id of ids) {
      await vscode.commands.executeCommand('neurotrace.deleteThought', id);
    }
  }

  /**
   * Refreshes the thoughts display for the specified page
   * Fetches thoughts from the server and updates the webview
   * @param page The page number to display (default: 0)
   */
  public async refresh(page: number = 0) {
    if (!this._view) { return; }
    const webview = this._view.webview;

    // Update the webview's state first
    webview.postMessage({
      type: 'updateState',
      state: this._dbState,
      backendAvailable: this._backendAvailable,
      loadingText: this._loadingMessage
    });

    // Guard clause: only fetch thoughts if unlocked
    if (this._dbState !== 'UNLOCKED' && this._dbState !== 'UNENCRYPTED') {
      return;
    }

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!workspacePath) {
      webview.postMessage({ type: 'error', message: 'No workspace folder open.' });
      return;
    }

    const dbPath = path.join(workspacePath, '.neurotrace', 'neurotrace.db');
    const dbExists = fs.existsSync(dbPath);

    if (!dbExists) {
      webview.postMessage({ type: 'no-db' });
      return;
    }

    try {
      if (this._isFileFilterMode && this._currentFileFilterPath) {
        const response = await this.serverManager.sendCommand('get_memories_by_file', {
          file_path: this._currentFileFilterPath
        }) as { memories?: any[]; count?: number; error?: string; message?: string };

        if (response?.error) {
          throw new Error(response.message || response.error);
        }

        this._fileFilterThoughts = [...(response.memories ?? [])];
        this._thoughts = this.getFilteredThoughts(this._fileFilterThoughts);

        const hasFeatureAccess = await this.hasFeatureAccess();

        webview.postMessage({
          type: 'fileResults',
          data: this._thoughts,
          filePath: this._currentFileFilterPath,
          count: response.count ?? this._thoughts.length,
          hasFeatureAccess
        });

        this.updateThoughtLocations();
        await this.updateUsageDisplay();
        return;
      }

      const loadThoughts = async () => {
        const response = await this.serverManager.sendCommand('list', {
          page: page,
          page_size: this._pageSize
        }) as any;

        const serverThoughts = response.thoughts ?? [];
        this._totalThoughts = response.total;
        this._currentPage = response.page;

        if (page === 0) {
          this._originalThoughts = [...serverThoughts];
          this._isSearchMode = false;
        }

        this._thoughts = this.getFilteredThoughts(page === 0 ? this._originalThoughts : serverThoughts);

        const hasFeatureAccess = await this.hasFeatureAccess();

        webview.postMessage({
          type: 'load',
          data: this._thoughts,
          pagination: {
            current: this._currentPage,
            total: Math.ceil(this._totalThoughts / this._pageSize),
            hasMore: (this._currentPage + 1) * this._pageSize < this._totalThoughts
          },
          hasFeatureAccess: hasFeatureAccess
        });

        this.updateThoughtLocations();

        // Get usage stats and update display
        try {
          this._usageStats = await this.globalUsageManager.getUsageStats();
          const usageText = await this.globalUsageManager.getUsageDisplayText();

          webview.postMessage({
            type: 'usageStats',
            data: {
              monthly_thought_count: this._usageStats.monthlyThoughtCount,
              usage_display_text: usageText
            }
          });
        } catch (error) {
          console.error('NeuroTrace: Error getting usage stats:', error);
        }
      };

      if (this._isFirstLoad) {
        this._isFirstLoad = false;
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "Loading thoughts from database",
          cancellable: false
        }, loadThoughts);
      } else {
        await loadThoughts();
      }
    } catch (error) {
      console.error('NeuroTrace: Error loading thoughts:', error);

      if (dbExists) {
        webview.postMessage({ type: 'error', message: 'Reconnecting to the database...' });
        const reconnected = await this.serverManager.reconnect();

        if (reconnected) {
          setTimeout(() => this.refresh(), 1000);
        } else {
          webview.postMessage({
            type: 'error',
            message: 'Could not reconnect to the database. Try restarting VS Code.'
          });
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        webview.postMessage({ type: 'error', message: `Error: ${message}` });
      }
    }
  }

  /**
   * Loads the next page of thoughts if available
   */
  public async loadMoreThoughts() {
    if ((this._currentPage + 1) * this._pageSize < this._totalThoughts) {
      await this.refresh(this._currentPage + 1);
    }
  }

  /**
   * Displays search results in the sidebar
   * @param results Array of thought objects matching the search
   * @param searchTerm The search term used
   * @param isSemanticSearch Whether semantic search was used
   */
  public async showSearchResults(results: any[], searchTerm: string, isSemanticSearch: boolean) {
    if (!this._view) { return; }

    if (!this._isSearchMode) {
      this._originalThoughts = [...this._thoughts];
    }

    this._isFileFilterMode = false;
    this._currentFileFilterPath = null;
    this._fileFilterThoughts = [];
    this._isSearchMode = true;
    this._thoughts = results;
    this._currentSearchTerm = searchTerm;

    const hasFeatureAccess = await this.hasFeatureAccess();

    this._view.webview.postMessage({
      type: 'searchResults',
      data: results,
      searchTerm: searchTerm,
      isSemanticSearch: isSemanticSearch,
      hasFeatureAccess: hasFeatureAccess
    });
    this.updateThoughtLocations();
  }

  public async showMemoriesForFile(filePath: string) {
    if (!this._view) { return; }

    const response = await this.serverManager.sendCommand('get_memories_by_file', {
      file_path: filePath
    }) as { memories?: any[]; count?: number; error?: string; message?: string };

    if (response?.error) {
      throw new Error(response.message || response.error);
    }

    if (!this._isSearchMode && !this._isFileFilterMode) {
      this._originalThoughts = [...this._thoughts];
    }

    this._isSearchMode = false;
    this._isFileFilterMode = true;
    this._currentFileFilterPath = filePath;
    this._fileFilterThoughts = [...(response.memories ?? [])];
    this._thoughts = this.getFilteredThoughts(this._fileFilterThoughts);

    const hasFeatureAccess = await this.hasFeatureAccess();

    this._view.webview.postMessage({
      type: 'fileResults',
      data: this._thoughts,
      filePath,
      count: response.count ?? this._thoughts.length,
      hasFeatureAccess
    });
    this.updateThoughtLocations();
  }

  /**
   * Filters thoughts by type in the sidebar display
   * @param thoughtType The thought type to filter by, or null to show all types
   */
  public filterByType(thoughtType: string | null) {
    if (!this._originalThoughts.length && !this._thoughts.length && !this._fileFilterThoughts.length) { return; }

    if (thoughtType === null) {
      this._isFilteredByType = false;
      this._filteredType = null;

      if (this._isFileFilterMode) {
        this._thoughts = [...this._fileFilterThoughts];
      } else if (!this._isSearchMode) {
        this.restoreOriginalThoughts();
        return;
      }
    } else {
      // Apply filter
      this._isFilteredByType = true;
      this._filteredType = thoughtType;
      const baseThoughts = this._isFileFilterMode ? this._fileFilterThoughts : this._originalThoughts;
      this._thoughts = this.getFilteredThoughts(baseThoughts);
    }

    if (this._view) {
      this._view.webview.postMessage({
        type: 'filterByType',
        data: this._thoughts,
        isFiltered: this._isFilteredByType,
        filterType: this._filteredType
      });
    }

    this.updateThoughtLocations();
  }

  /**
   * Restores the original thoughts list, clearing any search or filter state
   */
  public restoreOriginalThoughts() {
    if (!this._view) { return; }

    this._isSearchMode = false;
    this._isFileFilterMode = false;
    this._isFilteredByType = false;
    this._filteredType = null;
    this._currentFileFilterPath = null;
    this._fileFilterThoughts = [];
    this._thoughts = [...this._originalThoughts];

    this._view.webview.postMessage({
      type: 'restoreOriginal',
      data: this._thoughts
    });
    this.updateThoughtLocations();
  }

  /**
   * Controls whether code icons (decorations) are shown in the editor
   * @param show Whether to show code icons
   */
  public setShowCodeIcons(show: boolean): void {
    this._showCodeIcons = show;
    this.updateDecorations();
  }



  /**
   * Navigates to a specific page of thoughts
   * @param page The page number to navigate to
   */
  public async gotoPage(page: number) {
    if (page >= 0 && page < Math.ceil(this._totalThoughts / this._pageSize)) {
      await this.refresh(page);
    }
  }

  /**
   * Updates the total count of thoughts and notifies the webview
   * @param total The new total count of thoughts
   */
  public updateTotalCount(total: number) {
    this._totalThoughts = total;

    if (this._view) {
      this._view.webview.postMessage({
        type: 'updatePagination',
        pagination: {
          current: this._currentPage,
          total: Math.ceil(this._totalThoughts / this._pageSize),
          hasMore: this._totalThoughts > this._pageSize
        }
      });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const sidebarRoot = vscode.Uri.joinPath(this._context.extensionUri, 'media', 'sidebar');
    const htmlUri = vscode.Uri.joinPath(sidebarRoot, 'index.html');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(sidebarRoot, 'sidebar.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(sidebarRoot, 'sidebar.js'));
    const platformName = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';

    return fs.readFileSync(htmlUri.fsPath, 'utf8')
      .replace(/{{styleUri}}/g, styleUri.toString())
      .replace(/{{scriptUri}}/g, scriptUri.toString())
      .replace(/{{platformName}}/g, platformName)
      .replace(/{{extensionVersion}}/g, this._context.extension.packageJSON.version);
  }
}
