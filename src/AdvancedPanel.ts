import * as vscode from 'vscode';

export class AdvancedPanel {
  private panel?: vscode.WebviewPanel;
  private showCodeIcons: boolean = true;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.showCodeIcons = vscode.workspace.getConfiguration('neurotrace').get('showCodeIcons', true);
  }

  public async show() {
    if (this.panel) {
      this.panel.reveal();
      this.postSettings();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'neurotrace.advanced',
      'NeuroTrace Settings',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'save-settings':
          this.showCodeIcons = Boolean(msg.showCodeIcons);
          await vscode.workspace.getConfiguration('neurotrace').update('showCodeIcons', this.showCodeIcons, true);
          vscode.window.showInformationMessage(`Code icons ${this.showCodeIcons ? 'enabled' : 'disabled'}.`);
          this.postSettings();
          break;
        case 'open-privacy':
          await this.openWorkspaceDoc('docs/PRIVACY.md');
          break;
        case 'open-license':
          await this.openWorkspaceDoc('LICENSE.md');
          break;
        case 'open-readme':
          await this.openWorkspaceDoc('README.md');
          break;
      }
    });

    this.postSettings();
  }

  private postSettings() {
    this.panel?.webview.postMessage({
      type: 'init-settings',
      showCodeIcons: this.showCodeIcons,
      usageText: 'Unlimited memories'
    });
  }

  private async openWorkspaceDoc(relativePath: string) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
  }

  private getHtml(): string {
    const nonce = Date.now().toString(36);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NeuroTrace Settings</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 24px;
    }
    main {
      max-width: 760px;
      margin: 0 auto;
    }
    h1 {
      font-size: 26px;
      font-weight: 600;
      margin: 0 0 8px;
    }
    p {
      color: var(--vscode-descriptionForeground);
      margin: 0 0 18px;
    }
    section {
      border: 1px solid var(--vscode-widget-border);
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      padding: 18px;
      margin: 16px 0;
    }
    label {
      display: flex;
      gap: 10px;
      align-items: center;
      margin: 8px 0;
    }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 4px;
      padding: 8px 12px;
      margin-right: 8px;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .muted {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main>
    <h1>NeuroTrace Settings</h1>
    <p>Local-first project memory for coding agents.</p>

    <section>
      <h2>Runtime</h2>
      <p id="usage">Unlimited memories</p>
      <p class="muted">Hosted account services are not part of this open-source build.</p>
    </section>

    <section>
      <h2>Editor</h2>
      <label>
        <input type="checkbox" id="show-code-icons">
        Show NeuroTrace icons in the code editor
      </label>
      <button id="save-settings">Save</button>
    </section>

    <section>
      <h2>Project Documents</h2>
      <button id="open-readme">README</button>
      <button id="open-privacy">Privacy</button>
      <button id="open-license">License</button>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'init-settings') {
        document.getElementById('show-code-icons').checked = Boolean(message.showCodeIcons);
        document.getElementById('usage').textContent = message.usageText || 'Unlimited memories';
      }
    });

    document.getElementById('save-settings').addEventListener('click', () => {
      vscode.postMessage({
        type: 'save-settings',
        showCodeIcons: document.getElementById('show-code-icons').checked
      });
    });
    document.getElementById('open-readme').addEventListener('click', () => vscode.postMessage({ type: 'open-readme' }));
    document.getElementById('open-privacy').addEventListener('click', () => vscode.postMessage({ type: 'open-privacy' }));
    document.getElementById('open-license').addEventListener('click', () => vscode.postMessage({ type: 'open-license' }));
  </script>
</body>
</html>`;
  }
}
