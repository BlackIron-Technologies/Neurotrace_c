/* global acquireVsCodeApi */
(() => {
  const vscode = acquireVsCodeApi(), get = id => document.getElementById(id);
  const send = (type, data = {}) => vscode.postMessage({type, ...data});
  const wizard = new window.NeuroTraceWizard(get, send), renderTeam = window.NeuroTraceTeam(get, send);
  let status = {}, team, network, busy = false, loadedProject = '';
  const labels = {owner: 'Owner', admin: 'Administrator', editor: 'Can edit', viewer: 'Can view'};
  const notice = (text, error = false) => { get('feedback').hidden = false; get('feedback').textContent = text; get('feedback').classList.toggle('error', error); };
  function tab(id) {
    document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== id; });
    document.querySelectorAll('.tab').forEach(button => { button.classList.toggle('selected', button.dataset.tab === id); button.setAttribute('aria-selected', String(button.dataset.tab === id)); });
    if (id === 'activity' && status.project_id) { send('activity'); }
  }
  function renderStatus(value) {
    const previousRole = status.role; status = value;
    const configured = Boolean(status.project_id);
    get('setup').hidden = configured; get('connected').hidden = !configured;
    get('reload-activity').disabled = busy || !configured;
    const states = {unconfigured: 'Local only', live: 'Live sync', connecting: 'Connecting…', offline: 'Working offline', paused: 'Sync paused', locked: 'Unlock to sync', access_denied: 'Access changed', unavailable: 'Backend unavailable', error: 'Sync needs attention', incompatible_server: 'Update the server'};
    get('state-label').textContent = states[status.state] || status.state;
    get('state-dot').className = 'dot ' + (status.state === 'live' ? 'live' : status.state === 'offline' ? 'offline' : '');
    const pending = status.counts?.pending || 0, recovered = status.counts?.recovered || 0;
    get('queue-label').textContent = recovered ? recovered + ' saved draft(s) · ' + pending + ' pending' : pending ? pending + ' change(s) waiting for server' : status.synced ? 'Server confirmed · Up to date' : configured ? 'Saved locally · ' + (status.state === 'live' ? 'Checking server' : 'Not connected to server') : 'This workspace is not connected to a shared project';
    if (configured) {
      get('project-title').textContent = status.project_name; get('connection-detail').textContent = status.server_url; get('server-detail-url').textContent = status.server_url;
      get('identity-label').textContent = status.actor_name + ' · ' + (labels[status.role] || status.role);
      get('role-description').textContent = status.error || (status.role === 'viewer' ? 'You can read shared memories. Ask the owner for editing access.' : 'Changes sync automatically, including after working offline.');
      get('pause').textContent = status.enabled ? 'Pause sync' : 'Resume sync';
      if (loadedProject !== status.project_id || previousRole !== status.role) { loadedProject = status.project_id; send('team'); }
    }
  }
  document.querySelectorAll('[data-tab]').forEach(button => { button.onclick = () => tab(button.dataset.tab); });
  document.querySelectorAll('[data-doc]').forEach(button => { button.onclick = () => button.dataset.doc === 'sync' ? get('deployment-guide').showModal() : send('open-doc', {doc: button.dataset.doc}); });
  document.querySelectorAll('[data-reference]').forEach(button => { button.onclick = () => send('open-reference', {reference: button.dataset.reference}); });
  get('close-deployment').onclick = () => get('deployment-guide').close();
  get('recover-owner').onclick = () => send('recover');
  get('open-tunnel-setup').onclick = () => send('open-tunnel-setup');
  get('host-stop').onclick = () => send('host-stop');
  get('pause').onclick = () => send('pause', {paused: status.enabled});
  get('check-sync').onclick = () => send('check-sync');
  get('reload-team').onclick = () => send('team'); get('reload-activity').onclick = () => send('activity');
  get('invite').onclick = () => {
    if (!get('member-name').value.trim()) { notice('Enter the name of the person or agent you are inviting.', true); get('member-name').focus(); return; }
    send('invite', {name: get('member-name').value.trim(), kind: get('member-kind').value, role: get('member-role').value});
  };
  get('pair-device').onclick = () => send('invite', {name: status.actor_name, kind: 'device', role: 'viewer'});
  get('member-kind').onchange = () => { if (get('member-kind').value === 'agent' && get('member-role').value === 'admin') { get('member-role').value = 'editor'; } renderTeam(team, network, busy); };
  get('transfer').onclick = () => send('transfer', {member: get('transfer-member').value});
  get('network-transfer').onclick = () => send('network-transfer', {member: get('transfer-member').value});
  get('create-project').onclick = () => { const name = get('new-project-name').value.trim(); if (!name) { notice('Name the project you want to use in another workspace.', true); get('new-project-name').focus(); return; } send('create-project', {name}); };
  get('export-drafts').onclick = () => send('export-drafts');
  get('show-code-icons').onchange = () => send('save-editor', {enabled: get('show-code-icons').checked});
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'status') { renderStatus(message.status); }
    if (message.type === 'editor') { get('show-code-icons').checked = message.showCodeIcons; get('your-name').value ||= message.ownerName || ''; get('project-name').value ||= message.projectName || ''; get('network-name').value ||= 'My team'; }
    if (message.type === 'workspace') { wizard.workspaceInfo(message.workspace); get('workspace-name').textContent = message.workspace.name; get('connected-workspace').textContent = message.workspace.path || 'No workspace open'; }
    if (message.type === 'error' || message.type === 'notice') { notice(message.message, message.type === 'error'); if (message.type === 'error' && !status.project_id) { wizard.error(message.message); } }
    if (message.type === 'busy') {
      busy = message.busy; wizard.busy = busy;
      document.querySelectorAll('button:not(.tab)').forEach(button => { button.disabled = busy; });
      document.querySelectorAll('input, select').forEach(input => { input.disabled = busy; });
      renderTeam(team, network, busy); wizard.controls();
      get('reload-activity').disabled = busy || !status.project_id;
    }
    if (message.type === 'connected') {
      wizard.connected();
      const report = message.importReport;
      if (report) {
        get('import-summary').hidden = false;
        get('import-counts').textContent = report.imported_memories + ' imported · ' + report.reused_memories + ' already shared · ' + report.preserved_versions.length + ' different version(s) preserved' + (report.skipped_relations.length ? ' · ' + report.skipped_relations.length + ' link(s) in the backup for review' : '');
        get('import-backup').textContent = 'Local backup: ' + report.backup_id + '. ' + report.backup_location;
        const versions = get('import-versions'); versions.replaceChildren();
        for (const version of report.preserved_versions) { const item = document.createElement('li'); item.textContent = 'Original: ' + version.original_id + ' · Your version: ' + version.preserved_local_id; versions.append(item); }
      }
      notice('Connected. This workspace now syncs automatically. Next, invite your team or connect another device.'); window.scrollTo(0, 0);
    }
    if (message.type === 'team') { team = message.team; network = message.network; renderTeam(team, network, busy); }
    if (message.type === 'reload-team') { send('team'); }
    if (message.type === 'activity') {
      const container = get('activity-list'); container.replaceChildren();
      for (const entry of message.activity.events) { const row = document.createElement('div'), detail = document.createElement('small'); row.className = 'activity-entry'; row.textContent = entry.actor + ' · ' + entry.action.replaceAll('_', ' '); detail.textContent = new Date(entry.at * 1000).toLocaleString(); row.append(detail); container.append(row); }
      if (!message.activity.events.length) { container.textContent = 'No project activity yet.'; }
    }
    if (message.type === 'hosting') { wizard.hostInfo(message.hosting); }
    if (message.type === 'server-checked') { wizard.serverChecked(message.result); }
  });
  send('ready');
})();
