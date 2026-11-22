/* global acquireVsCodeApi */
(() => {
  const vscode = acquireVsCodeApi();
  const get = id => document.getElementById(id);
  const send = (type, data = {}) => vscode.postMessage({ type, ...data });
  let mode = 'join', status = {}, team = null, network = null, hosting = {}, publicUrl = '', busy = false;
  let loadedProject = '';
  let exposureVerified = false;
  const labels = { owner: 'Owner', admin: 'Administrator', editor: 'Can edit', viewer: 'Can view' };
  function notice(message, error = false) { get('feedback').hidden = false; get('feedback').textContent = message; get('feedback').classList.toggle('error', error); }
  function tab(id) {
    document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== id; });
    document.querySelectorAll('.tab').forEach(button => { button.classList.toggle('selected', button.dataset.tab === id); button.setAttribute('aria-selected', String(button.dataset.tab === id)); });
    if (id === 'activity' && status.project_id) { send('activity'); }
  }
  function choose(value) {
    mode = value;
    get('create-fields').hidden = mode !== 'create'; get('join-fields').hidden = mode !== 'join';
    get('choose-join').classList.toggle('active', mode === 'join'); get('choose-create').classList.toggle('active', mode === 'create');
    get('connect').textContent = mode === 'create' ? 'Create shared project' : 'Join team';
  }
  function node(tag, text, className) { const element = document.createElement(tag); if (text !== undefined) { element.textContent = text; } if (className) { element.className = className; } return element; }
  function renderTeam() {
    if (!team || !network) { return; }
    const container = get('team-list'); container.replaceChildren();
    const role = team.role, manage = ['owner', 'admin'].includes(role), human = network.actor.kind === 'human';
    get('invite-card').hidden = !(manage && human); get('device-card').hidden = !human;
    get('ownership').hidden = !(role === 'owner' || network.network.is_owner);
    get('transfer').hidden = role !== 'owner'; get('network-transfer').hidden = !network.network.is_owner;
    get('new-project-card').hidden = !network.network.is_owner;
    get('network-detail').textContent = network.network.name + (network.network.is_owner ? ' · You own this network' : ' · Project ownership is separate from network ownership');
    const transfer = get('transfer-member'); transfer.replaceChildren();
    for (const member of team.members) {
      const row = node('div', undefined, 'member');
      row.append(node('span', member.kind === 'agent' ? 'AI' : member.name.slice(0, 2).toUpperCase(), 'avatar'));
      const name = node('div', member.name + (member.id === network.actor.id ? ' (you)' : ''), 'member-name');
      name.append(node('small', member.kind === 'agent' ? 'Agent · permissions limited by sponsor' : 'Team member')); row.append(name);
      const canChange = manage && member.role !== 'owner' && (role === 'owner' || member.role !== 'admin');
      if (canChange) {
        const select = node('select'); select.setAttribute('aria-label', 'Permission for ' + member.name);
        for (const value of ['viewer', 'editor', ...(role === 'owner' && member.kind === 'human' ? ['admin'] : [])]) { const option = node('option', labels[value]); option.value = value; select.append(option); }
        select.value = member.role; select.addEventListener('change', () => send('member', { member: member.id, role: select.value })); row.append(select);
        const remove = node('button', 'Remove', 'text-button'); remove.addEventListener('click', () => send('member', { member: member.id, role: null })); row.append(remove);
      } else { row.append(node('span', labels[member.role], 'badge')); }
      container.append(row);
      if (member.kind === 'human' && member.id !== network.actor.id) { const option = node('option', member.name); option.value = member.id; transfer.append(option); }
    }
    get('transfer').disabled = !transfer.options.length; get('network-transfer').disabled = !transfer.options.length;
    get('member-role').querySelector('option[value="admin"]').hidden = role !== 'owner' || get('member-kind').value === 'agent';
  }
  function renderStatus(value) {
    const previousRole = status.role;
    status = value;
    const configured = Boolean(status.project_id);
    get('setup').hidden = configured; get('connected').hidden = !configured;
    const states = { unconfigured: 'Local only', live: 'Live sync', connecting: 'Connecting…', offline: 'Working offline', paused: 'Sync paused', locked: 'Unlock to sync', access_denied: 'Access changed', unavailable: 'Backend unavailable', error: 'Sync needs attention' };
    get('state-label').textContent = states[status.state] || status.state;
    get('state-dot').className = 'dot ' + (status.state === 'live' ? 'live' : status.state === 'offline' ? 'offline' : '');
    const pending = status.counts?.pending || 0, recovered = status.counts?.recovered || 0;
    get('queue-label').textContent = recovered ? recovered + ' saved draft(s) · ' + pending + ' pending' : pending ? pending + ' change(s) waiting for server confirmation' : status.synced ? 'Server confirmed · Downloads up to date' : configured ? 'Saved locally · ' + (status.state === 'live' ? 'Checking server' : 'Not currently connected') : 'Local memory stays on this device';
    if (configured) {
      get('project-title').textContent = status.project_name; get('connection-detail').textContent = status.server_url;
      get('identity-label').textContent = status.actor_name + ' · ' + (labels[status.role] || status.role);
      get('role-description').textContent = status.error || (status.role === 'viewer' ? 'You can read shared memories. Ask an administrator for editing access.' : 'Changes sync automatically. Concurrent text edits merge across devices.');
      get('pause').textContent = status.enabled ? 'Pause sync' : 'Resume sync';
      if (loadedProject !== status.project_id || previousRole !== status.role) { loadedProject = status.project_id; send('team'); }
    }
  }
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => tab(button.dataset.tab)));
  get('choose-join').onclick = () => choose('join'); get('choose-create').onclick = () => choose('create');
  get('go-hosting').onclick = () => tab('hosting');
  get('recover-owner').onclick = () => send('recover');
  get('connect').onclick = () => {
    const serverUrl = get('server-url').value.trim(), code = get('invite-code').value.trim();
    if (!serverUrl && !code.startsWith('http')) { notice('Enter your server address or paste a complete invitation link.', true); get('server-url').focus(); return; }
    if (mode === 'join' && !code) { notice('Paste your team invitation to continue.', true); get('invite-code').focus(); return; }
    if (mode === 'create' && ['your-name', 'network-name', 'project-name', 'setup-key'].some(id => !get(id).value.trim())) { notice('Enter your name, network name, project name and setup key.', true); return; }
    send('connect', { serverUrl, code, mode, setupKey: get('setup-key').value, name: get('your-name').value, networkName: get('network-name').value, projectName: get('project-name').value, publish: get('publish').checked });
  };
  get('pause').onclick = () => send('pause', { paused: status.enabled });
  get('check-sync').onclick = () => send('check-sync');
  get('reload-team').onclick = () => send('team'); get('reload-activity').onclick = () => send('activity');
  get('invite').onclick = () => { if (!get('member-name').value.trim()) { notice('Enter a name for the invitation.', true); return; } send('invite', { name: get('member-name').value.trim(), kind: get('member-kind').value, role: get('member-role').value }); };
  get('pair-device').onclick = () => send('invite', { name: status.actor_name, kind: 'device', role: 'viewer' });
  get('member-kind').onchange = () => { if (get('member-kind').value === 'agent' && get('member-role').value === 'admin') { get('member-role').value = 'editor'; } renderTeam(); };
  get('transfer').onclick = () => send('transfer', { member: get('transfer-member').value });
  get('network-transfer').onclick = () => send('network-transfer', { member: get('transfer-member').value });
  get('create-project').onclick = () => { if (get('new-project-name').value.trim()) { send('create-project', { name: get('new-project-name').value.trim() }); } };
  get('export-drafts').onclick = () => send('export-drafts');
  get('show-code-icons').onchange = () => send('save-editor', { enabled: get('show-code-icons').checked });
  get('host-start').onclick = () => send('host-start', { port: Number(get('host-port').value) });
  function exposureControls() { get('use-host').disabled = busy || !exposureVerified; }
  get('public-url').oninput = () => { exposureVerified = false; exposureControls(); };
  get('host-stop').onclick = () => send('host-stop');
  get('host-verify').onclick = () => send('host-verify', { publicUrl: get('public-url').value.trim() });
  get('open-tunnel-setup').onclick = () => send('open-tunnel-setup');
  get('hosting-guide-inline').onclick = () => send('open-doc', { doc: 'sync' });
  get('use-host').onclick = () => {
    if (!exposureVerified) { notice('Ask your administrator for the public address, then verify it.', true); return; }
    get('server-url').value = publicUrl; get('setup-key').value = hosting.setup_key || '';
    choose('create'); tab('sync'); get('your-name').focus();
  };
  get('hosting-guide').onclick = () => send('open-doc', { doc: 'sync' });
  document.querySelectorAll('[data-doc]').forEach(button => button.onclick = () => send('open-doc', { doc: button.dataset.doc }));
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'status') { renderStatus(message.status); }
    if (message.type === 'editor') { get('show-code-icons').checked = message.showCodeIcons; get('your-name').value ||= message.ownerName || ''; get('project-name').value ||= message.projectName || ''; get('network-name').value ||= (message.projectName || 'My team') + ' team'; }
    if (message.type === 'error' || message.type === 'notice') { notice(message.message, message.type === 'error'); }
    if (message.type === 'busy') {
      busy = message.busy; document.querySelectorAll('button:not(.tab)').forEach(button => { button.disabled = busy; });
      if (!busy && team) { renderTeam(); }
      exposureControls();
    }
    if (message.type === 'connected') {
      get('setup-key').value = ''; get('invite-code').value = '';
      const report = message.importReport;
      if (report) {
        get('import-summary').hidden = false;
        get('import-counts').textContent = report.imported_memories + ' imported · ' + report.reused_memories + ' already shared · ' + report.preserved_versions.length + ' different version(s) preserved' + (report.skipped_relations.length ? ' · ' + report.skipped_relations.length + ' link(s) saved in the backup for review' : '');
        get('import-backup').textContent = 'Local backup: ' + report.backup_id + '. ' + report.backup_location;
        const versions = get('import-versions'); versions.replaceChildren();
        for (const version of report.preserved_versions) { versions.append(node('li', 'Original: ' + version.original_id + ' · Your preserved version: ' + version.preserved_local_id)); }
      }
      notice('Connected. Your team’s changes will appear automatically.'); window.scrollTo(0, 0); send('team');
    }
    if (message.type === 'team') { team = message.team; network = message.network; renderTeam(); }
    if (message.type === 'reload-team') { send('team'); }
    if (message.type === 'activity') {
      const container = get('activity-list'); container.replaceChildren();
      for (const entry of message.activity.events) { const row = node('div', undefined, 'activity-entry'); row.append(node('div', entry.actor + ' · ' + entry.action.replaceAll('_', ' ')), node('small', new Date(entry.at * 1000).toLocaleString())); container.append(row); }
      if (!message.activity.events.length) { container.append(node('p', 'No activity yet.')); }
    }
    if (message.type === 'hosting') {
      hosting = message.hosting; exposureVerified = false; publicUrl = '';
      get('host-running').hidden = !hosting.running; get('host-stop').hidden = !hosting.running;
      get('host-status').textContent = hosting.running ? 'Running · ' + hosting.url + ' · Next: configure how your team connects' : 'Server stopped. Team clients can continue offline.';
      if (hosting.running) { get('host-running').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      exposureControls();
    }
    if (message.type === 'tunnel') {
      publicUrl = message.tunnel.public_url; exposureVerified = Boolean(message.tunnel.verified);
      get('tunnel-url').textContent = (publicUrl || '') + (exposureVerified ? ' · Verified: reaches this NeuroTrace server' : ' · Not verified yet: ' + (message.tunnel.error || 'check the route and try again'));
      if (publicUrl) { get('public-url').value = publicUrl; }
      exposureControls();
    }
  });
  exposureControls();
  send('ready');
})();
