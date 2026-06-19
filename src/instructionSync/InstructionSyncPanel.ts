import * as vscode from 'vscode';
import { InstructionSyncManager } from './InstructionSyncManager';
import { InstructionSyncPanelState } from './types';

export class InstructionSyncPanel {
  public static readonly viewType = 'neurotrace-instruction-sync';
  private static currentPanel: InstructionSyncPanel | undefined;

  private readonly manager: InstructionSyncManager;
  private lastState: InstructionSyncPanelState | undefined;

  public static show(context: vscode.ExtensionContext): InstructionSyncPanel {
    if (InstructionSyncPanel.currentPanel) {
      InstructionSyncPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active);
      // Panel is retained in memory — no reload needed. Silently refresh in background.
      void InstructionSyncPanel.currentPanel.refreshInBackground();
      return InstructionSyncPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      InstructionSyncPanel.viewType,
      'Sync Agent Instructions',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    InstructionSyncPanel.currentPanel = new InstructionSyncPanel(panel, context);
    return InstructionSyncPanel.currentPanel;
  }

  public static async closeRestoredPanels(): Promise<void> {
    const restoredTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputWebview
        && tab.input.viewType === InstructionSyncPanel.viewType);

    if (restoredTabs.length > 0) {
      await vscode.window.tabGroups.close(restoredTabs);
    }
  }

  public static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): InstructionSyncPanel {
    InstructionSyncPanel.currentPanel = new InstructionSyncPanel(panel, context);
    return InstructionSyncPanel.currentPanel;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext
  ) {
    this.manager = new InstructionSyncManager(context);
    this.panel.webview.html = this.getHtml();
    void this.postState('load');

    this.panel.onDidDispose(() => {
      if (InstructionSyncPanel.currentPanel === this) {
        InstructionSyncPanel.currentPanel = undefined;
      }
    });

    this.panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.visible) {
        void this.refreshInBackground();
      }
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case 'ready':
            break;
          case 'openCanonical':
            await this.manager.openCanonicalInEditor();
            break;
          case 'changeCanonical': {
            const state = await this.manager.changeCanonicalFile();
            if (state) {
              await this.postStateAfter('load', state, 'Canonical file changed.');
            }
            break;
          }
          case 'syncNow':
            await this.postStateAfter('sync', await this.manager.syncNow(), 'Instructions synced to all targets.');
            break;
          case 'useTemplate':
            await this.postStateAfter('load', await this.manager.useNeuroTraceTemplate(), 'Canonical replaced with NeuroTrace template.');
            break;
          case 'toggleTarget':
            await this.postStateAfter('preview', await this.manager.setTargetEnabled(message.targetId, Boolean(message.enabled)));
            break;
          case 'addTarget': {
            const state = await this.manager.pickAndAddTarget();
            if (state) {
              await this.postStateAfter('preview', state);
            }
            break;
          }
          case 'removeTarget': {
            const confirm = await vscode.window.showWarningMessage(
              `Remove "${message.targetLabel ?? 'this target'}" from sync?`,
              { modal: true },
              'Remove'
            );
            if (confirm === 'Remove') {
              await this.postStateAfter('preview', await this.manager.removeTarget(message.targetId));
            }
            break;
          }
          default:
            break;
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(messageText);
        this.panel.webview.postMessage({ type: 'error', message: messageText });
      }
    });
  }

  private async postState(mode: 'load' | 'preview' | 'sync'): Promise<void> {
    const state = await this.manager.getState();
    this.lastState = state;
    await this.panel.webview.postMessage({ type: 'state', state, mode });
  }

  private async refreshInBackground(): Promise<void> {
    try {
      const state = await this.manager.getState();
      this.lastState = state;
      await this.panel.webview.postMessage({ type: 'state', state, mode: 'preview' });
    } catch { /* ignore — panel may have been disposed */ }
  }

  private async postStateAfter(mode: 'load' | 'preview' | 'sync', state: InstructionSyncPanelState, notice?: string): Promise<void> {
    this.lastState = state;
    await this.panel.webview.postMessage({ type: 'state', state, mode });
    if (notice) {
      void vscode.window.showInformationMessage(notice);
    }
  }

  private getHtml(): string {
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sync Agent Instructions</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --panel: var(--vscode-sideBar-background);
      --elevated: var(--vscode-editorWidget-background);
      --border: var(--vscode-panel-border);
      --text: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-button-background);
      --accent-fg: var(--vscode-button-foreground);
      --accent-hover: var(--vscode-button-hoverBackground);
      --success: #2fb36f;
      --warning: #e0a83a;
      --error: #d96b6b;
      --info: #4aa8ff;
      --radius: 12px;
      --radius-sm: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--text);
      background: var(--bg);
      padding: 20px;
      min-height: 100vh;
    }
    .page { display: flex; flex-direction: column; gap: 16px; max-width: 760px; margin: 0 auto; }

    .header { display: flex; flex-direction: column; gap: 4px; }
    .header h1 { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
    .header p { color: var(--muted); font-size: 12px; line-height: 1.5; }

    .card {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--panel);
      overflow: hidden;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
    }
    .card-title { font-size: 13px; font-weight: 600; }
    .card-sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
    .card-body { padding: 14px 16px; }
    .card-actions { display: flex; gap: 8px; flex-wrap: wrap; }

    .canonical-row { display: flex; align-items: center; gap: 10px; }
    .canonical-path {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--elevated);
      font-size: 12px;
      font-family: Consolas, 'SFMono-Regular', Monaco, 'Courier New', monospace;
      color: var(--text);
      overflow: hidden;
      cursor: pointer;
      transition: border-color 120ms;
    }
    .canonical-path:hover { border-color: var(--accent); }
    .path-text { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .path-icon { color: var(--muted); flex-shrink: 0; font-size: 11px; }
    .seed-badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--elevated);
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }

    .target-list { display: flex; flex-direction: column; }
    .target-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 16px;
      border-bottom: 1px solid var(--border);
      transition: background 100ms;
    }
    .target-item:last-child { border-bottom: none; }
    .target-item:hover { background: var(--elevated); }
    .target-item.disabled { opacity: 0.55; }
    .target-toggle { flex-shrink: 0; accent-color: var(--accent); cursor: pointer; width: 14px; height: 14px; }
    .target-info { flex: 1; min-width: 0; }
    .target-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .target-path { font-size: 11px; color: var(--muted); font-family: Consolas, 'SFMono-Regular', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .status-pill {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 76px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .s-create    { background: rgba(47,179,111,.13); color: var(--success); border: 1px solid rgba(47,179,111,.3); }
    .s-update    { background: rgba(224,168,58,.13);  color: var(--warning); border: 1px solid rgba(224,168,58,.3); }
    .s-unchanged { background: rgba(74,168,255,.13);  color: var(--info);    border: 1px solid rgba(74,168,255,.3); }
    .s-error     { background: rgba(217,107,107,.13); color: var(--error);   border: 1px solid rgba(217,107,107,.3); }
    .s-disabled  { background: rgba(128,128,128,.1);  color: var(--muted);   border: 1px solid rgba(128,128,128,.25); }
    .target-remove {
      flex-shrink: 0;
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 3px 5px;
      border-radius: var(--radius-sm);
      font-size: 14px;
      line-height: 1;
      opacity: 0;
      transition: opacity 100ms, color 100ms;
    }
    .target-item:hover .target-remove { opacity: 1; }
    .target-remove:hover { color: var(--error); }

    .empty-targets {
      padding: 28px 16px;
      text-align: center;
      color: var(--muted);
      font-size: 12px;
      border: 1px dashed var(--border);
      border-radius: var(--radius-sm);
      margin: 12px 16px;
    }

    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .footer-hint { color: var(--muted); font-size: 11px; }
    .footer-actions { display: flex; gap: 8px; margin-left: auto; }

    button {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border: none;
      border-radius: var(--radius-sm);
      padding: 7px 12px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: background 120ms, transform 80ms;
      white-space: nowrap;
    }
    button:active { transform: scale(0.97); }
    .btn-primary   { background: var(--accent); color: var(--accent-fg); font-weight: 600; }
    .btn-primary:hover { background: var(--accent-hover, var(--accent)); filter: brightness(1.1); }
    .btn-secondary { background: var(--elevated); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { border-color: var(--accent); }
    .btn-ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
    .btn-ghost:hover { color: var(--text); border-color: var(--text); }

    .notice {
      display: none;
      padding: 9px 14px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      background: rgba(74,168,255,.1);
      color: var(--info);
      border: 1px solid rgba(74,168,255,.25);
    }
    .notice.visible { display: block; }
    .notice.error { background: rgba(217,107,107,.1); color: var(--error); border-color: rgba(217,107,107,.3); }
  </style>
</head>
<body>
  <div class="page">

    <div class="header">
      <h1>Sync Agent Instructions</h1>
      <p>Edit your canonical instruction file freely in VS Code. NeuroTrace distributes its content to every target you configure here.</p>
    </div>

    <div id="notice" class="notice"></div>

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Canonical File</div>
          <div class="card-sub">Single source of truth — edit this file, sync pushes it to all targets.</div>
        </div>
        <div class="card-actions">
          <button class="btn-ghost" id="use-template">Use Template</button>
          <button class="btn-ghost" id="change-canonical">Change File…</button>
        </div>
      </div>
      <div class="card-body">
        <div class="canonical-row">
          <div class="canonical-path" id="open-canonical" title="Click to open in editor">
            <span class="path-icon">📄</span>
            <span class="path-text" id="canonical-path-text">loading…</span>
            <span class="path-icon">↗</span>
          </div>
          <span class="seed-badge" id="seed-source">…</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Targets</div>
          <div class="card-sub">Files that receive the synced instructions.</div>
        </div>
        <div class="card-actions">
          <button class="btn-secondary" id="add-target">+ Add Target</button>
        </div>
      </div>
      <div id="target-list"></div>
    </div>

    <div class="footer">
      <span class="footer-hint">One-way sync · canonical → targets</span>
      <div class="footer-actions">
        <button class="btn-primary" id="sync-now">↺ Sync Now</button>
      </div>
    </div>

  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const canonicalPathEl = document.getElementById('canonical-path-text');
    const seedSourceEl    = document.getElementById('seed-source');
    const targetListEl    = document.getElementById('target-list');
    const noticeEl        = document.getElementById('notice');

    function showNotice(msg, isError) {
      noticeEl.textContent = msg;
      noticeEl.className = 'notice visible' + (isError ? ' error' : '');
      clearTimeout(noticeEl._timer);
      noticeEl._timer = setTimeout(() => { noticeEl.className = 'notice'; }, 4000);
    }

    function statusPill(status) {
      const labels = { create: 'missing', update: 'outdated', unchanged: 'synced', error: 'error', disabled: 'off' };
      return '<span class="status-pill s-' + status + '">' + (labels[status] || status) + '</span>';
    }

    function renderTargets(targets) {
      if (!targets.length) {
        targetListEl.innerHTML = '<div class="empty-targets">No targets yet — add the files you want NeuroTrace to keep in sync.</div>';
        return;
      }
      targetListEl.innerHTML = targets.map((t) =>
        '<div class="target-item' + (t.enabled ? '' : ' disabled') + '">' +
          '<input class="target-toggle" type="checkbox" data-action="toggle" data-id="' + t.id + '" ' + (t.enabled ? 'checked' : '') + ' title="' + (t.enabled ? 'Disable' : 'Enable') + ' target" />' +
          '<div class="target-info">' +
            '<div class="target-name">' + t.label + '</div>' +
            '<div class="target-path">' + t.relativePath + '</div>' +
          '</div>' +
          statusPill(t.enabled ? t.status : 'disabled') +
          '<button class="target-remove" data-action="remove" data-id="' + t.id + '" data-label="' + t.label + '" title="Remove target">&#x2715;</button>' +
        '</div>'
      ).join('');
    }

    function applyState(state) {
      canonicalPathEl.textContent = state.canonicalPath;
      document.getElementById('open-canonical').title = 'Open ' + state.canonicalPath + ' in editor';
      seedSourceEl.textContent = state.seedSourceLabel;
      renderTargets(state.targets);
    }

    document.getElementById('open-canonical').addEventListener('click', () => {
      vscode.postMessage({ type: 'openCanonical' });
    });
    document.getElementById('change-canonical').addEventListener('click', () => {
      vscode.postMessage({ type: 'changeCanonical' });
    });
    document.getElementById('use-template').addEventListener('click', () => {
      vscode.postMessage({ type: 'useTemplate' });
    });
    document.getElementById('add-target').addEventListener('click', () => {
      vscode.postMessage({ type: 'addTarget' });
    });
    document.getElementById('sync-now').addEventListener('click', () => {
      vscode.postMessage({ type: 'syncNow' });
    });

    targetListEl.addEventListener('click', (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) { return; }
      if (el.dataset.action === 'remove' && el.dataset.id) {
        vscode.postMessage({ type: 'removeTarget', targetId: el.dataset.id, targetLabel: el.dataset.label });
      }
    });

    targetListEl.addEventListener('change', (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement)) { return; }
      if (el.dataset.action === 'toggle' && el.dataset.id) {
        vscode.postMessage({ type: 'toggleTarget', targetId: el.dataset.id, enabled: el.checked });
      }
    });

    window.addEventListener('message', ({ data }) => {
      if (data.type === 'state') {
        applyState(data.state);
        if (data.mode === 'sync') { showNotice('Instructions synced to all enabled targets.'); }
      } else if (data.type === 'error') {
        showNotice(data.message, true);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
