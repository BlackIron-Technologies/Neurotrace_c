import * as vscode from 'vscode';
import { PythonServerManager } from '../PythonServerManager';

export async function workspaceInfo(backend: PythonServerManager) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const base = { name: folder?.name || 'No workspace open', path: folder?.uri.fsPath || '' };
  if (!folder) { return { ...base, local: { ready: false, count: 0, message: 'Open your project folder in VS Code before connecting shared memory.' } }; }
  const database = await backend.sendCommand<{ status: string }>('check_db_status');
  if (database.status === 'NO_DB') { return { ...base, local: { ready: true, count: 0 } }; }
  if (!['UNLOCKED', 'UNENCRYPTED'].includes(database.status)) {
    return { ...base, local: { ready: false, count: 0, message: 'Unlock this workspace in the NeuroTrace sidebar, then select Check local memories again.' } };
  }
  const result = await backend.sendCommand<{ total: number }>('get_total_count');
  return { ...base, local: { ready: true, count: result.total } };
}
