import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

export function settingsHtml(view: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomBytes(24).toString('base64');
  const css = view.asWebviewUri(vscode.Uri.joinPath(media, 'settings.css'));
  const js = view.asWebviewUri(vscode.Uri.joinPath(media, 'settings.js'));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"><title>NeuroTrace Settings</title></head>
<body><main>
<header><div class="eyebrow">NEUROTRACE / SETTINGS</div><h1>Your memory. Your team.</h1><p>Keep project knowledge in sync, wherever your team works.</p></header>
<nav aria-label="Settings sections"><button class="tab selected" data-tab="sync" aria-selected="true">Team sync</button><button class="tab" data-tab="hosting" aria-selected="false">Server</button><button class="tab" data-tab="activity" aria-selected="false">Activity</button><button class="tab" data-tab="general" aria-selected="false">Editor &amp; privacy</button></nav>
<div id="feedback" role="status" aria-live="polite" hidden></div>
<section id="sync" class="page">
  <div class="status-strip"><span class="dot" id="state-dot"></span><strong id="state-label">Checking connection…</strong><span id="queue-label">Local memory stays on this device</span></div>
  <div id="setup">
    <div class="section-heading"><div><h2>A shared home for your project</h2><p>Connect to your team's server or create your own network.</p></div><span class="step">SETUP</span></div>
    <div class="choices" role="group" aria-label="Connection type"><button class="choice active" id="choose-join"><strong>Join a team</strong><span>I have an invitation from my team.</span></button><button class="choice" id="choose-create"><strong>Create a network</strong><span>I am setting up the team's server.</span></button></div>
    <div class="card form-card">
      <label for="server-url">Server address</label><input id="server-url" type="url" placeholder="https://memory.your-team.com" autocomplete="url">
      <p class="hint">Cloud and self-hosted servers work the same way. <button class="text-button" id="go-hosting">Use this computer as server →</button></p>
      <div id="join-fields"><label for="invite-code">Invitation link or code</label><input id="invite-code" type="password" autocomplete="off" placeholder="Paste the invitation your team shared"><p class="hint">An invitation works once and expires in one hour.</p></div>
      <div id="create-fields" hidden>
        <div class="columns"><div><label for="your-name">Your name</label><input id="your-name" maxlength="100" placeholder="Alex Rivera" autocomplete="name"></div><div><label for="network-name">Network name</label><input id="network-name" maxlength="100" placeholder="Acme Engineering"></div></div>
        <label for="project-name">Shared project name</label><input id="project-name" maxlength="100" placeholder="Platform knowledge">
        <label for="setup-key">Server setup key</label><input id="setup-key" type="password" autocomplete="off" placeholder="Provided by the person hosting this server"><p class="hint">Used once to claim a new network. You become its first owner.</p>
      </div>
      <label class="checkbox"><input type="checkbox" id="publish"><span>Import and share existing memories from this workspace</span></label>
      <p class="hint">If this workspace already has memories, select the checkbox to import them with a local backup. Different versions with the same ID are both preserved. Nothing is uploaded until you connect.</p>
      <div class="actions"><button id="connect" class="primary">Join team</button><span class="hint">Device credentials stay in your operating system's secure store.</span></div>
      <details><summary>Recover an owner device</summary><p class="hint">Import a recovery file created by your server operator. Use an empty local workspace.</p><button id="recover-owner" class="secondary">Import recovery file</button></details>
    </div>
  </div>
  <div id="connected" hidden>
    <div class="card" id="import-summary" hidden role="status"><h3>Your existing work is preserved</h3><p id="import-counts"></p><p class="hint">Different versions remain separate memories for your team to review. A memory missing from one database is never treated as a deletion.</p><details><summary>Import details</summary><p id="import-backup" class="hint"></p><ul id="import-versions"></ul></details></div>
    <div class="section-heading"><div><h2 id="project-title">Shared project</h2><p id="connection-detail"></p></div><div class="actions"><button id="check-sync" class="secondary">Check delivery</button><button id="pause" class="secondary">Pause sync</button></div></div>
    <div class="card compact"><div><strong id="identity-label"></strong><p id="role-description"></p></div><button id="export-drafts" class="secondary">Save pending work</button></div>
    <div class="section-heading"><div><h2>People &amp; agents</h2><p>Everyone has their own identity and permissions.</p></div><button id="reload-team" class="text-button">Refresh</button></div>
    <div class="card" id="team-list"><p class="hint">Loading your team…</p></div>
    <div class="card" id="invite-card" hidden><h3>Invite someone</h3>
      <div class="columns"><div><label for="member-name">Name</label><input id="member-name" maxlength="100" placeholder="Teammate or agent name"></div><div><label for="member-kind">Who is joining?</label><select id="member-kind"><option value="human">Person</option><option value="agent">Agent</option></select></div><div><label for="member-role">Permission</label><select id="member-role"><option value="editor">Can edit</option><option value="viewer">Can view</option><option value="admin">Administrator</option></select></div></div>
      <p class="hint">Editors add, edit and delete memories. Readers can view only. Agents cannot manage members.</p><button id="invite" class="primary">Copy invitation</button><p class="hint">Single use · Expires in 1 hour · Share it privately</p>
    </div>
    <div class="card" id="device-card"><h3>Continue on another device</h3><p>Create an invitation for another machine using your own identity.</p><button id="pair-device" class="secondary">Copy device invitation</button></div>
    <details id="ownership" hidden><summary>Ownership &amp; administration</summary><p id="network-detail"></p><p class="hint">The network owner creates shared projects. The project owner manages this project's team. Hosting operators can read server storage; end-to-end encryption is not provided.</p><label for="transfer-member">New owner</label><select id="transfer-member"></select><div class="actions"><button id="transfer" class="secondary">Transfer project ownership</button><button id="network-transfer" class="secondary" hidden>Transfer network ownership</button></div></details>
    <div class="card" id="new-project-card" hidden><h3>Another shared project</h3><p>Create a separate project in this network, then connect it from another workspace.</p><label for="new-project-name">Project name</label><input id="new-project-name" maxlength="100" placeholder="Another project"><div class="actions"><button id="create-project" class="secondary">Create project &amp; copy connection link</button></div></div>
  </div>
</section>
<section id="hosting" class="page" hidden>
  <div class="section-heading"><div><h2>One server. Any home.</h2><p>Your server can run in the cloud or on a machine you control.</p></div></div>
  <div class="card"><div class="eyebrow">ON THIS MACHINE</div><h3>1. Start your team's server</h3><p>Keep this machine running so your team can sync. Use Docker or a system service for permanent hosting.</p><label for="host-port">Local port</label><input id="host-port" type="number" min="1024" max="65535" value="9473"><div class="actions"><button class="primary" id="host-start">Start local server</button><button class="secondary" id="host-stop" hidden>Stop server</button></div><p id="host-status" class="hint">Server is not running from this panel.</p>
    <div id="host-running" hidden>
      <h3>2. Choose how your team connects</h3><p>A local server needs a public address before other machines can reach it.</p>
      <p class="hint">Your administrator creates and runs the tunnel or HTTPS reverse proxy. NeuroTrace only verifies the address. The origin must be the local address shown above.</p>
      <div class="actions"><button id="open-tunnel-setup" class="secondary">Open Cloudflare setup</button><button id="hosting-guide-inline" class="secondary">Administrator deployment guide</button></div>
      <label for="public-url">Public HTTPS address from your administrator</label><input id="public-url" type="url" placeholder="https://memory.your-team.com">
      <button id="host-verify" class="secondary">Verify public address</button><p id="tunnel-url" class="hint" role="status"></p>
      <h3>3. Connect this workspace</h3><p class="hint">The public address must be verified against this server before it can be shared.</p><button id="use-host" class="primary" disabled>Continue to network setup →</button>
    </div>
  </div>
  <div class="card"><div class="eyebrow">CLOUD OR PERMANENT SERVER</div><h3>Deploy once, connect everyone</h3><p>Run the included Docker service with persistent storage and HTTPS. Keep the setup key private, then claim the network from Team sync.</p><button id="hosting-guide" class="secondary">Open deployment guide</button></div>
</section>
<section id="activity" class="page" hidden><div class="section-heading"><div><h2>A history you can trust</h2><p>Every change is attributed to a person or agent.</p></div><button id="reload-activity" class="secondary">Refresh</button></div><div id="activity-list" class="card"><p>Connect a team to see its activity.</p></div></section>
<section id="general" class="page" hidden><div class="card"><h2>Editor</h2><label class="checkbox"><input type="checkbox" id="show-code-icons"><span>Show NeuroTrace icons beside linked code</span></label></div><div class="card"><h2>Local first, shared by choice</h2><p>Sync is optional. This device keeps a local database and queues changes when offline. Shared content is readable by your chosen server; your local encryption passphrase stays on your device.</p><div class="actions"><button data-doc="privacy" class="secondary">Privacy</button><button data-doc="readme" class="secondary">README</button><button data-doc="license" class="secondary">License</button></div></div></section>
<footer>NeuroTrace · Shared knowledge, clear ownership.</footer>
</main><script nonce="${nonce}" src="${js}"></script></body></html>`;
}
