import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { setupHtml } from './views/setup';
import { connectedHtml } from './views/connected';
import { deploymentHtml } from './views/deployment';

export function settingsHtml(view: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomBytes(24).toString('base64');
  const asset = (name: string) => view.asWebviewUri(vscode.Uri.joinPath(media, name));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('settings.css')}"><title>NeuroTrace Settings</title></head>
<body><main>
<header><div class="eyebrow">NEUROTRACE / SETTINGS</div><h1>Shared memory, step by step.</h1><p>Connect this workspace. Keep your other projects separate.</p><div class="workspace-scope"><strong id="workspace-name">Current workspace</strong><span>These settings apply to this workspace only.</span></div></header>
<nav aria-label="Settings sections"><button class="tab selected" data-tab="sync" aria-selected="true">Team sync</button><button class="tab" data-tab="activity" aria-selected="false">Activity</button><button class="tab" data-tab="general" aria-selected="false">Editor &amp; privacy</button></nav>
<div id="feedback" role="status" aria-live="polite" hidden></div>
<section id="sync" class="page"><div class="status-strip"><span class="dot" id="state-dot"></span><strong id="state-label">Checking connection…</strong><span id="queue-label">Local memory stays on this device</span></div>${setupHtml}${connectedHtml}</section>
<section id="activity" class="page" hidden><div class="section-heading"><div><h2>Project activity</h2><p>Changes attributed to people and agents in this shared project.</p></div><button id="reload-activity" class="secondary">Refresh</button></div><div id="activity-list" class="card"><p>Connect this workspace to a shared project to see its activity.</p></div></section>
<section id="general" class="page" hidden><div class="card"><h2>Editor</h2><label class="checkbox"><input type="checkbox" id="show-code-icons"><span>Show NeuroTrace icons beside linked code</span></label></div><div class="card"><h2>What is shared?</h2><p>Connecting is optional. This workspace keeps a local database and queues changes when offline. Shared content is readable by your chosen server; your local encryption passphrase stays on this device.</p><p>Project members can download shared memories according to their permissions. Revoking access prevents future downloads but cannot remove copies already received. End-to-end encryption is not provided.</p><div class="actions"><button data-doc="readme" class="secondary">README</button><button data-doc="license" class="secondary">License</button></div></div></section>
<footer>NeuroTrace · One network can host many separate projects.</footer>
</main>${deploymentHtml}${['wizard.js', 'team.js', 'settings.js'].map(name => `<script nonce="${nonce}" src="${asset(name)}"></script>`).join('')}</body></html>`;
}
