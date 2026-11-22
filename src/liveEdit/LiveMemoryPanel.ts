import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { PythonServerManager } from '../PythonServerManager';

export class LiveMemoryPanel {
  private static panels = new Map<string, vscode.WebviewPanel>();

  public static async show(server: PythonServerManager, id: string) {
    const previous = this.panels.get(id);
    if (previous) { previous.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('neurotrace.liveMemory', 'Shared memory', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(server.extensionUri, 'media')] });
    this.panels.set(id, panel);
    const nonce = randomBytes(24).toString('base64');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(server.extensionUri, 'media', 'live-edit.js'));
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">body{font:14px/1.6 var(--vscode-font-family);background:var(--vscode-editor-background);color:var(--vscode-foreground);padding:28px;max-width:900px;margin:auto}h1{font-size:23px;margin:0}p{color:var(--vscode-descriptionForeground)}textarea{width:100%;min-height:55vh;box-sizing:border-box;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:8px;padding:20px;font:15px/1.8 var(--vscode-editor-font-family);outline-color:var(--vscode-focusBorder)}footer{display:flex;justify-content:space-between;gap:12px;margin-top:15px}button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:8px 12px;border:0;border-radius:5px;cursor:pointer}#state{font-size:12px}#error{color:var(--vscode-errorForeground)}[hidden]{display:none}</style>
</head><body><h1>Shared memory</h1><p>Write together. Changes merge automatically across your team.</p><p id="error" role="alert" hidden></p><textarea id="text" aria-label="Memory text" readonly></textarea><footer><span id="state" role="status">Connecting…</span><button id="copy">Copy my text</button></footer><script nonce="${nonce}" src="${script}"></script></body></html>`;
    let disposed = false;
    const refresh = async () => {
      try {
        const context = await server.sendCommand('sync_edit_context', { thought_id: id });
        if (!disposed) { await panel.webview.postMessage({ type: 'context', context }); }
      } catch (error) {
        if (!disposed) { await panel.webview.postMessage({ type: 'error', message: String(error) }); }
      }
    };
    const subscription = server.onSyncChanged(() => { void refresh(); });
    panel.onDidDispose(() => { disposed = true; subscription.dispose(); this.panels.delete(id); });
    panel.webview.onDidReceiveMessage(async message => {
      if (message.type === 'ready') { await refresh(); }
      if (message.type === 'copy') { await vscode.env.clipboard.writeText(String(message.text)); }
      if (message.type === 'update') {
        try {
          const context = await server.sendCommand('sync_text_update', { thought_id: id, update: String(message.update) });
          await panel.webview.postMessage({ type: 'saved', context });
          void vscode.commands.executeCommand('neurotrace.refreshSidebar');
        } catch (error) {
          await panel.webview.postMessage({ type: 'error', message: String(error) });
        }
      }
    });
  }
}
