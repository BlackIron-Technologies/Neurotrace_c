import * as vscode from 'vscode';
import { PythonServerManager } from '../PythonServerManager';

class BackendTool implements vscode.LanguageModelTool<Record<string, unknown>> {
  constructor(private readonly server: PythonServerManager, private readonly command: string) { }
  async invoke(options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>) {
    const result = await this.server.sendCommand(this.command, options.input);
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
  }
}

export function syncTools(server: PythonServerManager): [string, vscode.LanguageModelTool<any>][] {
  return [['neurotrace_sync', new BackendTool(server, 'sync')], ['neurotrace_getThought', new BackendTool(server, 'get_thought')],
    ['neurotrace_host', new BackendTool(server, 'host')], ['neurotrace_connect', new BackendTool(server, 'connect')],
    ['neurotrace_team', new BackendTool(server, 'team')], ['neurotrace_repository', new BackendTool(server, 'sync_repository')]];
}
