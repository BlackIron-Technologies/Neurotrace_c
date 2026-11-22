import * as vscode from 'vscode';
import { PythonServerManager } from '../PythonServerManager';

export class SettingsController implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly view: vscode.Webview,
    private readonly backend: PythonServerManager) { }

  dispose() { this.disposed = true; if (this.timer) { clearInterval(this.timer); } }
  private post(value: unknown) { if (!this.disposed) { void this.view.postMessage(value); } }

  private async refresh() {
    if (this.busy || this.disposed) { return; }
    try {
      this.post({ type: 'status', status: await this.backend.sendCommand('sync_status') });
    } catch (error) {
      this.post({ type: 'status', status: { state: 'unavailable', error: error instanceof Error ? error.message : String(error) } });
    }
  }

  public async receive(message: { type: string; [key: string]: any }) {
    if (message.type === 'ready') {
      this.post({ type: 'editor', ownerName: process.env.USERNAME || process.env.USER || 'Owner', projectName: vscode.workspace.workspaceFolders?.[0]?.name || 'Shared project', showCodeIcons: vscode.workspace.getConfiguration('neurotrace').get('showCodeIcons', true) });
      await this.refresh();
      if (!this.timer) { this.timer = setInterval(() => { void this.refresh(); }, 2000); }
      return;
    }
    if (this.busy) { return; }
    this.busy = true;
    this.post({ type: 'busy', busy: true });
    try {
      switch (message.type) {
        case 'save-editor':
          await vscode.workspace.getConfiguration('neurotrace').update('showCodeIcons', Boolean(message.enabled), vscode.ConfigurationTarget.Global);
          break;
        case 'connect': {
          if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before connecting shared memory.'); }
          let serverUrl = String(message.serverUrl || '').trim();
          let code = String(message.code || '').trim();
          if (code.startsWith('https://') || code.startsWith('http://')) {
            const invitation = new URL(code);
            code = new URLSearchParams(invitation.hash.slice(1)).get('join') || '';
            serverUrl = invitation.origin;
          }
          const result = await this.backend.sendCommand<{ import_report?: unknown }>('sync_connect', {
            server_url: serverUrl, mode: message.mode, code, setup_key: String(message.setupKey || ''),
            name: String(message.name || ''), network_name: String(message.networkName || ''),
            project_name: String(message.projectName || ''), publish: Boolean(message.publish)
          });
          this.post({ type: 'connected', importReport: result.import_report });
          await vscode.commands.executeCommand('neurotrace.refreshSidebar');
          break;
        }
        case 'recover': {
          if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before importing owner credentials.'); }
          const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, openLabel: 'Import owner recovery' });
          if (files?.[0]) {
            await this.backend.sendCommand('sync_recover', { file_path: files[0].fsPath });
            this.post({ type: 'connected' });
          }
          break;
        }
        case 'pause':
          await this.backend.sendCommand('sync_pause', { paused: Boolean(message.paused) });
          break;
        case 'check-sync': {
          const result = await this.backend.sendCommand<{ success: boolean; reason?: string; synced_through?: number }>('sync', { action: 'wait', timeout_ms: 5000 });
          this.post({ type: result.success ? 'notice' : 'error', message: result.success ? 'Server confirmed changes through checkpoint ' + result.synced_through + '.' : 'Sync could not be confirmed: ' + result.reason + '. Your pending work stays local.' });
          break;
        }
        case 'team': {
          const team = await this.backend.sendCommand('sync_manage', { action: 'members' });
          const network = await this.backend.sendCommand('sync_manage', { action: 'network' });
          this.post({ type: 'team', team, network });
          break;
        }
        case 'invite': {
          const result = await this.backend.sendCommand<{ code: string }>('sync_manage', {
            action: 'invite', data: { name: String(message.name), role: String(message.role), kind: String(message.kind) }
          });
          const status = await this.backend.sendCommand<{ server_url: string }>('sync_status');
          await vscode.env.clipboard.writeText(status.server_url + '/#join=' + encodeURIComponent(result.code));
          this.post({ type: 'notice', message: 'Invitation copied. It works once and expires in one hour.' });
          break;
        }
        case 'member':
          if (message.role === null) {
            const choice = await vscode.window.showWarningMessage('Remove this member from the shared project? Future access will be revoked.', { modal: true }, 'Remove member');
            if (choice !== 'Remove member') { break; }
          }
          await this.backend.sendCommand('sync_manage', { action: 'member', data: { member: String(message.member), role: message.role } });
          this.post({ type: 'reload-team' });
          break;
        case 'transfer': {
          const choice = await vscode.window.showWarningMessage('Transfer project ownership? You will become an administrator.', { modal: true }, 'Transfer ownership');
          if (choice === 'Transfer ownership') {
            await this.backend.sendCommand('sync_manage', { action: 'transfer', data: { member: String(message.member) } });
            this.post({ type: 'reload-team' });
          }
          break;
        }
        case 'network-transfer': {
          const choice = await vscode.window.showWarningMessage('Transfer network ownership? This member will control creation of shared projects.', { modal: true }, 'Transfer network');
          if (choice === 'Transfer network') {
            await this.backend.sendCommand('sync_manage', { action: 'network_transfer', data: { member: String(message.member) } });
            this.post({ type: 'reload-team' });
          }
          break;
        }
        case 'create-project': {
          const result = await this.backend.sendCommand<{ invitation: string; name: string }>('sync_manage', { action: 'create_project', data: { name: String(message.name) } });
          await vscode.env.clipboard.writeText(result.invitation);
          this.post({ type: 'notice', message: result.name + ' created. Open another workspace and paste the copied connection link to use it.' });
          break;
        }
        case 'activity':
          this.post({ type: 'activity', activity: await this.backend.sendCommand('sync_manage', { action: 'activity' }) });
          break;
        case 'export-drafts': {
          const drafts = await this.backend.sendCommand('sync_drafts');
          const target = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, saveLabel: 'Save pending work' });
          if (target) { await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(drafts, null, 2))); }
          break;
        }
        case 'host-start': {
          if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before starting a server.'); }
          this.post({ type: 'hosting', hosting: await this.backend.sendCommand('sync_host_start', { port: Number(message.port) }) });
          break;
        }
        case 'host-verify':
          this.post({ type: 'tunnel', tunnel: await this.backend.sendCommand('sync_host_verify', { public_url: String(message.publicUrl || '') }) });
          break;
        case 'open-tunnel-setup':
          await vscode.env.openExternal(vscode.Uri.parse('https://dash.cloudflare.com/?to=/:account/networks/tunnels'));
          break;
        case 'host-stop': {
          const choice = await vscode.window.showWarningMessage('Stop the NeuroTrace server? The administrator-managed tunnel is unaffected. Team devices will work offline until it restarts.', { modal: true }, 'Stop server');
          if (choice === 'Stop server') { this.post({ type: 'hosting', hosting: await this.backend.sendCommand('sync_host_stop') }); }
          break;
        }
        case 'open-doc': {
          const paths: Record<string, string> = { readme: 'README.md', privacy: 'docs/PRIVACY.md', sync: 'docs/CLOUD_DEPLOYMENT.md', license: 'LICENSE.md' };
          if (paths[message.doc]) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.context.extensionUri, paths[message.doc]));
            await vscode.window.showTextDocument(document);
          }
          break;
        }
      }
    } catch (error) {
      this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.busy = false;
      this.post({ type: 'busy', busy: false });
      await this.refresh();
    }
  }
}
