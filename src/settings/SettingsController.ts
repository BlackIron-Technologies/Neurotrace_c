import * as vscode from 'vscode';
import { PythonServerManager } from '../PythonServerManager';
import { workspaceInfo } from './workspaceInfo';

export class SettingsController implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly view: vscode.Webview,
    private readonly backend: PythonServerManager) { }

  dispose() { this.disposed = true; if (this.timer) { clearInterval(this.timer); } }
  private post(value: unknown) { if (!this.disposed) { void this.view.postMessage(value); } }

  private async workspace() {
    try { this.post({ type: 'workspace', workspace: await workspaceInfo(this.backend) }); }
    catch (error) {
      this.post({ type: 'workspace', workspace: { name: vscode.workspace.workspaceFolders?.[0]?.name || 'Current workspace', local: { ready: false, count: 0, message: 'Could not check local memories. Check the NeuroTrace backend, then try again.' } } });
      this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

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
      await this.workspace();
      try { this.post({ type: 'hosting', hosting: await this.backend.sendCommand('sync_host_status') }); }
      catch (error) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
      if (!this.timer) { this.timer = setInterval(() => { void this.refresh(); }, 2000); }
      return;
    }
    if (this.busy) { return; }
    this.busy = true;
    this.post({ type: 'busy', busy: true });
    try {
      switch (message.type) {
        case 'workspace-info':
          await this.workspace();
          break;
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
          if (!vscode.workspace.workspaceFolders?.length) { throw new Error('Open a project folder before connecting.'); }
          const database = await this.backend.sendCommand<{ status: string }>('check_db_status');
          if (database.status === 'NO_DB') { await this.backend.sendCommand('init'); }
          const result = await this.backend.sendCommand<{ import_report?: unknown }>('sync_connect', {
            server_url: serverUrl, mode: message.mode, code, setup_key: String(message.setupKey || ''),
            name: String(message.name || ''), network_name: String(message.networkName || ''),
            project_name: String(message.projectName || ''), publish: Boolean(message.publish),
            confirm_legacy_repository: Boolean(message.confirmLegacy), path_policy: String(message.pathPolicy || 'reject'), type_map: message.typeMap || {}
          });
          this.post({ type: 'connected', importReport: result.import_report });
          await this.workspace();
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
          const result = await this.backend.sendCommand<{ invitation: string; name: string }>('sync_manage', { action: 'create_project', data: { name: String(message.name), repository_url: String(message.repositoryUrl || ''), workspace_scope: String(message.workspaceScope || '') } });
          await vscode.env.clipboard.writeText(result.invitation);
          this.post({ type: 'notice', message: result.name + ' created; its link is copied and expires in one hour. Open the other workspace → Team sync → I have a project invitation. This workspace stays connected to its current project.' });
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
        case 'server-check':
          this.post({ type: 'server-checked', result: await this.backend.sendCommand('sync_server_info', { server_url: String(message.serverUrl || ''), local: Boolean(message.local) }) });
          break;
        case 'service-refresh':
          this.post({ type: 'hosting', hosting: await this.backend.sendCommand('sync_host_status') });
          break;
        case 'service-install':
        case 'service-uninstall': {
          if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before changing background hosting.'); }
          if (message.type === 'service-uninstall') {
            const choice = await vscode.window.showWarningMessage('Remove background hosting and stop this local server? Shared data is preserved. The tunnel is unaffected.', { modal: true }, 'Remove service');
            if (choice !== 'Remove service') { break; }
          }
          await this.backend.sendCommand('sync_service', { action: message.type === 'service-install' ? 'install' : 'uninstall', port: Number(message.port || 9473) });
          this.post({ type: 'hosting', hosting: await this.backend.sendCommand('sync_host_status') });
          break;
        }
        case 'import-preview':
          this.post({ type: 'import-preview', result: await this.backend.sendCommand('sync_import_preview', { path_policy: String(message.pathPolicy || 'reject'), type_map: message.typeMap || {} }) });
          break;
        case 'preview-connection': {
          let code = String(message.code || ''), serverUrl = String(message.serverUrl || '');
          if (/^https?:/.test(code)) { const link = new URL(code); serverUrl = link.origin; code = new URLSearchParams(link.hash.slice(1)).get('join') || ''; }
          const result = await this.backend.sendCommand('preview_connection', { server_url: serverUrl, code });
          this.post({ type: 'invitation-preview', result, requestId: message.requestId });
          break;
        }
        case 'protect-repository': {
          if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before protecting shared memory.'); }
          const context = await this.backend.sendCommand<{ repository?: { origin: string; scope: string } }>('repository_context');
          if (!context.repository) { throw new Error('Open the matching Git repository first.'); }
          const choice = await vscode.window.showWarningMessage('Bind this existing shared project to ' + context.repository.origin + (context.repository.scope ? ' / ' + context.repository.scope : '') + '? Confirm only if its existing memories belong to this repository. Other repositories will be blocked.', { modal: true }, 'Protect project');
          if (choice === 'Protect project') { await this.backend.sendCommand('sync_repository', { action: 'protect_project' }); await this.workspace(); this.post({ type: 'notice', message: 'Repository protection enabled. Different branches of this repository can synchronize.' }); }
          break;
        }
        case 'open-tunnel-setup':
          await vscode.env.openExternal(vscode.Uri.parse('https://dash.cloudflare.com/?to=/:account/networks/tunnels'));
          break;
        case 'host-stop': {
          const choice = await vscode.window.showWarningMessage('Stop the NeuroTrace server? The administrator-managed tunnel is unaffected. Team devices will work offline until it restarts.', { modal: true }, 'Stop server');
          if (choice === 'Stop server') { this.post({ type: 'hosting', hosting: await this.backend.sendCommand('sync_host_stop') }); }
          break;
        }
        case 'open-doc': {
          const paths: Record<string, string> = { readme: 'README.md', license: 'LICENSE.md' };
          if (paths[message.doc]) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.context.extensionUri, paths[message.doc]));
            await vscode.window.showTextDocument(document);
          }
          break;
        }
        case 'open-reference': {
          const references: Record<string, string> = { docker: 'https://docs.docker.com/engine/install/', cloudflare: 'https://developers.cloudflare.com/tunnel/get-started/' };
          if (references[String(message.reference)]) { await vscode.env.openExternal(vscode.Uri.parse(references[String(message.reference)])); }
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
