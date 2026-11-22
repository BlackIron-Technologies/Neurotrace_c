/* global window */
(() => {
  const titles = {
    choice: ['Choose', 'How do you want to connect?', 'Choose the path that matches what you have.'],
    invitation: ['Invitation', 'Paste your project invitation', 'The link connects this workspace to one shared project.'],
    location: ['Server', 'Where will your server run?', 'Prepare one server for your network, then reuse it for all your projects.'],
    start: ['Start server', 'Start NeuroTrace on this computer', 'Only choose this if you are hosting the team’s server here.'],
    endpoint: ['Address', 'Verify your server address', 'You need a public HTTPS address before teammates can connect.'],
    details: ['Team & project', 'Name your team and first project', 'Your network groups projects. Each project keeps its own memories and permissions.'],
    memories: ['Local memories', 'Choose what this workspace shares', 'Review existing local work before joining a shared project.'],
    review: ['Review', 'Review and connect', 'This is the only step that connects this workspace and starts sharing.']
  };
  window.NeuroTraceWizard = class {
    constructor(get, send) {
      this.get = get; this.send = send; this.mode = 'join'; this.location = ''; this.step = 'choice';
      this.busy = false; this.hosting = {}; this.verifiedUrl = ''; this.workspace = {}; this.local = null; this.invitationPreview = null; this.previewRequest = null;
      get('choose-join').onclick = () => this.choose('join');
      get('use-project-link').onclick = () => this.choose('join');
      get('choose-create').onclick = () => this.choose('create');
      for (const place of ['cloud', 'local']) { get('choose-' + place).onclick = () => { this.location = place; this.invalidate(); this.show(place === 'local' ? 'start' : 'endpoint'); }; }
      get('setup-back').onclick = () => this.back(); get('setup-next').onclick = () => this.next();
      get('server-url').oninput = () => this.invalidate();
      get('publish').onchange = () => this.controls();
      get('invite-code').oninput = () => { this.invitationPreview = null; };
      get('join-server-url').oninput = () => { this.invitationPreview = null; };
      get('confirm-legacy').onchange = () => this.controls();
      get('refresh-workspace').onclick = () => this.send('workspace-info');
      get('host-start').onclick = () => { const port = Number(get('host-port').value); if (!Number.isInteger(port) || port < 1024 || port > 65535) { this.error('Choose a port from 1024 to 65535.'); return; } this.send('host-start', {port}); };
      get('verify-server').onclick = () => {
        try { const serverUrl = this.origin(get('server-url').value); this.send('server-check', {serverUrl, local: this.location === 'local'}); }
        catch (error) { this.error(error.message, 'server-url'); }
      };
      this.show('choice', false);
    }
    path() { return this.mode === 'join' ? ['choice', 'invitation', 'memories', 'review'] : ['choice', 'location', ...(this.location === 'local' ? ['start'] : []), 'endpoint', 'details', 'memories', 'review']; }
    choose(mode) { this.mode = mode; this.location = ''; this.invalidate(); this.show(mode === 'join' ? 'invitation' : 'location'); }
    origin(value) {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) { throw Error('Enter an HTTPS server address without a path, credentials or query. Example: https://memory.example.com'); }
      return url.origin;
    }
    invitation() {
      const code = this.get('invite-code').value.trim();
      if (!code) { throw Error('Paste the project invitation your teammate or administrator gave you.'); }
      if (/^https?:/i.test(code)) {
        let url;
        try { url = new URL(code); } catch { throw Error('This invitation link is incomplete. Ask for the complete project invitation.'); }
        const token = new URLSearchParams(url.hash.slice(1)).get('join');
        this.origin(url.origin);
        if (!token || url.search || !['', '/'].includes(url.pathname) || url.username || url.password) { throw Error('Use the complete NeuroTrace invitation containing #join=.'); }
        return {serverUrl: url.origin, code};
      }
      if (!this.get('join-server-url').value.trim()) { throw Error('For a code without a full link, expand “I only have an invitation code” and enter the server address.'); }
      return {serverUrl: this.origin(this.get('join-server-url').value), code};
    }
    error(message, field) { const element = this.get('step-error'); element.hidden = false; element.textContent = message; if (field) { this.get(field).focus(); } }
    invalidate() { this.verifiedUrl = ''; this.get('endpoint-status').textContent = 'Verify the address before continuing.'; this.get('server-already-claimed').hidden = true; this.controls(); }
    show(step, focus = true) {
      this.step = step;
      const path = this.path(), index = path.indexOf(step);
      document.querySelectorAll('[data-step]').forEach(element => { element.hidden = element.dataset.step !== step; });
      this.get('step-error').hidden = true;
      this.get('step-position').textContent = 'STEP ' + (index + 1) + ' OF ' + path.length;
      this.get('step-title').textContent = titles[step][1]; this.get('step-description').textContent = titles[step][2];
      const progress = this.get('setup-progress'); progress.replaceChildren();
      for (const [number, id] of path.entries()) { const item = document.createElement('li'); item.textContent = (number < index ? '✓ ' : (number + 1) + '. ') + titles[id][0]; if (id === step) { item.setAttribute('aria-current', 'step'); } progress.append(item); }
      this.get('local-endpoint-help').hidden = this.location !== 'local'; this.get('cloud-key').hidden = this.location === 'local';
      if (step === 'memories') { this.local = null; this.renderMemories(); this.send('workspace-info'); }
      if (step === 'review') { this.review(); }
      this.controls();
      if (focus) { this.get('step-title').focus(); this.get('wizard').scrollIntoView({block: 'nearest', behavior: 'smooth'}); }
    }
    back() { const path = this.path(); this.show(path[Math.max(0, path.indexOf(this.step) - 1)]); }
    next() {
      if (this.busy) { return; }
      try {
        if (this.step === 'invitation') { const connection = this.invitation(); this.previewRequest = {...connection, id: (this.previewRequest?.id || 0) + 1}; this.send('preview-connection', {...connection, requestId: this.previewRequest.id}); return; }
        if (this.step === 'start' && (!this.hosting.running || !this.hosting.setup_key)) { throw Error('Select Start NeuroTrace server or Use running server before continuing.'); }
        if (this.step === 'endpoint') {
          if (this.verifiedUrl !== this.origin(this.get('server-url').value)) { throw Error('Verify this server address before continuing.'); }
          if (this.location !== 'local' && !this.get('setup-key').value.trim()) { throw Error('Enter the setup key supplied by the administrator of this new server.'); }
        }
        if (this.step === 'details') { for (const id of ['your-name', 'network-name', 'project-name']) { if (!this.get(id).value.trim()) { this.get(id).focus(); throw Error('Enter your name, team name and first shared project name.'); } } }
        if (this.step === 'memories' || this.step === 'review') {
          if (!this.local || !this.local.ready) { throw Error(this.local?.message || 'Wait for the local memory check, or check again.'); }
          if (this.local.count > 0 && this.local.legacy_unverified && !this.get('confirm-legacy').checked) { throw Error('Confirm that these legacy memories belong to the observed repository before importing.'); }
          if (this.local.count > 0 && !this.get('publish').checked) { throw Error('Select the checkbox to share your existing memories, or cancel and use an empty workspace.'); }
        }
        if (this.step === 'review') { this.send('connect', this.payload()); return; }
        const path = this.path(); this.show(path[path.indexOf(this.step) + 1]);
      } catch (error) { this.error(error.message); }
    }
    payload() {
      const connection = this.mode === 'join' ? this.invitation() : {serverUrl: this.verifiedUrl, code: ''};
      return {...connection, mode: this.mode, setupKey: this.mode === 'create' ? (this.location === 'local' ? this.hosting.setup_key : this.get('setup-key').value.trim()) : '',
        name: this.get('your-name').value.trim(), networkName: this.get('network-name').value.trim(), projectName: this.get('project-name').value.trim(), confirmLegacy: this.get('confirm-legacy').checked, publish: this.local.count > 0 && this.get('publish').checked};
    }
    review() {
      const values = [['Workspace', this.workspace.name], ['Server', this.mode === 'join' ? this.invitation().serverUrl : this.verifiedUrl], ['Connection', this.mode === 'join' ? 'Join “' + this.invitationPreview.project_name + '” in “' + this.invitationPreview.network_name + '”' : 'Create network “' + this.get('network-name').value.trim() + '” and project “' + this.get('project-name').value.trim() + '”'], ['Existing memories', this.local.count ? this.local.count + (this.local.count === 1 ? ' local memory will be imported and shared' : ' local memories will be imported and shared') : 'No local memories to upload']];
      values.push(['Repository', this.local.repository.origin + (this.local.repository.scope ? ' / ' + this.local.repository.scope : '')], ['Branches', 'Different branches of this repository are allowed']);
      const list = this.get('setup-review'); list.replaceChildren();
      for (const [label, value] of values) { const term = document.createElement('dt'), detail = document.createElement('dd'); term.textContent = label; detail.textContent = value; list.append(term, detail); }
      this.get('review-effect').textContent = this.mode === 'join' ? 'Connect downloads the shared project and starts automatic sync. Any local memories selected for import will be shared with its members.' : 'Create network & connect makes you the network and project owner. You can invite your team after setup. Other workspaces stay unchanged.';
    }
    workspaceInfo(info) { this.workspace = info; this.local = info.local; const repository = info.local.repository; this.get('repository-observed').textContent = repository ? 'Repository: ' + repository.origin + (repository.scope ? ' / ' + repository.scope : '') + ' · Different branches are allowed.' : (info.local.message || 'Open a Git checkout with one origin remote.'); this.get('repository-adoption').hidden = !info.local.needs_adoption; this.get('protect-repository').hidden = !info.local.can_protect; this.get('repository-adoption-message').textContent = info.local.can_protect ? 'Verify this checkout is the repository for the project’s existing memories, then protect it. Sync stays blocked until this is confirmed.' : 'The project owner must bind this legacy project to its repository before synchronization can resume.'; this.renderMemories(); this.controls(); }
    renderMemories() {
      const local = this.local;
      this.get('local-memory-description').textContent = !local ? 'Checking this workspace’s local memories…' : !local.ready ? local.message : local.count ? 'This workspace contains ' + local.count + (local.count === 1 ? ' local memory. Confirm below before sharing it.' : ' local memories. Confirm below before sharing them.') : 'This workspace has no local memories. The shared project will be downloaded automatically after connection.';
      this.get('legacy-provenance').hidden = !local?.count || !local?.legacy_unverified;
      this.get('import-choice').hidden = !local?.ready || !local.count;
      this.get('publish-label').textContent = 'Share my ' + (local?.count || '') + (local?.count === 1 ? ' existing memory with this project' : ' existing memories with this project');
    }
    invitationChecked(result, requestId) {
      if (this.step !== 'invitation' || requestId !== this.previewRequest?.id) { return; }
      const current = this.invitation();
      if (current.code !== this.previewRequest.code || current.serverUrl !== this.previewRequest.serverUrl) { this.error('Invitation changed; verify it again.'); return; }
      this.invitationPreview = result; this.show('memories');
    }
    hostInfo(hosting) {
      if (hosting.running && hosting.url === this.hosting.url && !hosting.setup_key) { hosting.setup_key = this.hosting.setup_key; }
      this.hosting = hosting; this.invalidate();
      this.get('host-status').textContent = hosting.running ? 'Running at ' + hosting.url + '. Continue to publish this address.' : 'Server has not been started from this window.';
      this.get('origin-address').textContent = hosting.url || '';
      this.get('local-server-management').hidden = !hosting.running;
      this.get('managed-host-status').textContent = hosting.running ? 'This window started a local server at ' + hosting.url + '. Stopping it affects every connected project.' : '';
      this.get('host-start').textContent = hosting.running ? 'Use running server' : 'Start NeuroTrace server';
      this.controls();
    }
    serverChecked(result) {
      if (this.step !== 'endpoint' || this.origin(this.get('server-url').value) !== result.server_url) { return; }
      this.get('server-already-claimed').hidden = !result.initialized;
      this.verifiedUrl = result.initialized ? '' : result.server_url;
      this.get('endpoint-status').textContent = result.initialized ? 'Server reached. It is already configured; use a project invitation.' : 'Verified. This new server is ready for your network.';
      this.controls();
    }
    controls() {
      for (const id of ['choose-join', 'choose-create']) { this.get(id).disabled = this.busy || !this.workspace.local?.ready; }
      const next = this.get('setup-next'); this.get('setup-back').hidden = this.step === 'choice';
      next.hidden = ['choice', 'location'].includes(this.step);
      next.textContent = this.step === 'review' ? (this.mode === 'join' ? 'Connect this workspace' : 'Create network & connect') : 'Continue →';
      next.disabled = this.busy || (this.step === 'start' && (!this.hosting.running || !this.hosting.setup_key)) || (this.step === 'endpoint' && !this.verifiedUrl) || (this.step === 'memories' && !this.local?.ready);
      this.get('host-start').disabled = this.busy || Boolean(this.hosting.running && this.hosting.setup_key);
      this.get('wizard').setAttribute('aria-busy', String(this.busy));
    }
    connected() { this.get('setup-key').value = ''; this.get('invite-code').value = ''; this.hosting.setup_key = ''; }
  };
})();
