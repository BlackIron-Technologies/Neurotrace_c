import * as vscode from 'vscode';
import { PythonServerManager } from './PythonServerManager';
import { SettingsController } from './settings/SettingsController';
import { settingsHtml } from './settings/view';

export class AdvancedPanel {
  private panel?: vscode.WebviewPanel;
  constructor(private readonly ctx: vscode.ExtensionContext) { }

  public async show() {
    if (this.panel) { this.panel.reveal(); return; }
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'settings');
    const panel = vscode.window.createWebviewPanel('neurotrace.advanced', 'NeuroTrace Settings', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    this.panel = panel;
    const controller = new SettingsController(this.ctx, panel.webview, PythonServerManager.getInstance(this.ctx));
    panel.webview.html = settingsHtml(panel.webview, media);
    panel.onDidDispose(() => { controller.dispose(); this.panel = undefined; });
    panel.webview.onDidReceiveMessage(message => { void controller.receive(message); });
  }
}
