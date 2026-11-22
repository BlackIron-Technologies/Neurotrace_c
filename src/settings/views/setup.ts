export const setupHtml = `
<div id="setup">
  <p class="callout" id="repository-observed">Checking the Git repository for this workspace…</p>
  <div class="section-heading"><div><h2>Set up shared memory</h2><p>Follow the steps for this workspace. Nothing is shared until you confirm.</p></div></div>
  <ol id="setup-progress" class="progress" aria-label="Setup progress"></ol>
  <div class="card wizard" aria-busy="false" id="wizard">
    <div class="eyebrow" id="step-position">STEP 1</div><h2 id="step-title" tabindex="-1">How do you want to connect?</h2><p id="step-description"></p>
    <div data-step="choice">
      <div class="choices">
        <button class="choice" id="choose-join"><strong>I have a project invitation</strong><span>Join a teammate, connect another device, or open a project you already created.</span><span class="choice-action">Use invitation →</span></button>
        <button class="choice" id="choose-create"><strong>Set up sharing for my team</strong><span>Create your team's network and first shared project. You will need a server.</span><span class="choice-action">Set up a new network →</span></button>
      </div>
      <details><summary>Already use NeuroTrace in another project?</summary><p>Reuse your existing network, server and tunnel. In a connected workspace, the network owner selects <strong>Create another project</strong> and copies its connection link. Return to this window and choose <strong>I have a project invitation</strong>.</p><p>Each shared project has separate memories and permissions. Creating another network is unnecessary.</p></details>
      <details><summary>Recover access as the owner</summary><p>Ask the server administrator for an owner recovery file. Import it from an empty workspace.</p><button id="recover-owner" class="secondary">Import owner recovery file</button></details>
    </div>
    <div data-step="invitation" hidden>
      <label for="invite-code">Project invitation link</label><input id="invite-code" type="password" autocomplete="off" placeholder="https://memory.example.com/#join=…">
      <p class="hint">Paste the complete link. It includes the server address and project, so you do not need to enter them separately. Invitations work once and expire in one hour.</p>
      <details><summary>I only have an invitation code</summary><label for="join-server-url">Server address from your administrator</label><input id="join-server-url" type="url" placeholder="https://memory.example.com"><p class="hint">Paste the code in the invitation field above.</p></details>
    </div>
    <div data-step="location" hidden>
      <div class="choices"><button class="choice" id="choose-cloud"><strong>A server is already deployed</strong><span>Your administrator provides an HTTPS address and a setup key for a new server.</span></button><button class="choice" id="choose-local"><strong>Use this computer as the server</strong><span>Start NeuroTrace here. An administrator must provide a tunnel. This computer must stay on.</span></button></div>
      <p class="callout">One server can host many projects. You only prepare a server once for your network.</p>
      <p>Need a cloud server first? Give the deployment guide to your administrator, then return with its address and setup key.</p><button data-doc="sync" class="secondary">Open administrator deployment guide</button>
    </div>
    <div data-step="start" hidden>
      <p>Start the memory service here. This does not create a tunnel or connect any workspace.</p>
      <details><summary>Advanced: local port</summary><label for="host-port">Local port</label><input id="host-port" type="number" min="1024" max="65535" value="9473"></details>
      <div class="actions"><button id="host-start" class="primary">Start NeuroTrace server</button></div><p id="host-status" class="hint" role="status">Server has not been started from this window.</p>
      <p class="callout">Keep this computer running while your team works. For permanent hosting, your administrator should run NeuroTrace as a service or use the cloud deployment guide.</p>
    </div>
    <div data-step="endpoint" hidden>
      <div id="local-endpoint-help" hidden><div class="callout"><strong>Administrator action: publish this local address</strong><p id="origin-address"></p><p>Create and run a tunnel or HTTPS reverse proxy to this address. Give its public URL to the person completing setup here. NeuroTrace only verifies that URL.</p><div class="actions"><button id="open-tunnel-setup" class="secondary">Open Cloudflare setup</button><button data-doc="sync" class="text-button">Deployment instructions</button></div></div></div>
      <label for="server-url">Public HTTPS server address</label><input id="server-url" type="url" placeholder="https://memory.example.com" autocomplete="url">
      <div id="cloud-key"><label for="setup-key">One-time server setup key</label><input id="setup-key" type="password" autocomplete="off" placeholder="Provided by the server administrator"><p class="hint">This claims a new server for your team. Teammates will use invitations instead.</p></div>
      <div class="actions"><button id="verify-server" class="secondary">Verify server address</button></div><p id="endpoint-status" class="hint" role="status">Verify the address before continuing.</p>
      <div id="server-already-claimed" class="callout" hidden><strong>This server already has a network.</strong><p>Use a project invitation to join it. To create another project, open a connected workspace as the network owner and select Create another project.</p><button id="use-project-link" class="secondary">I have a project invitation</button></div>
    </div>
    <div data-step="details" hidden>
      <label for="your-name">Your name</label><input id="your-name" maxlength="100" autocomplete="name">
      <label for="network-name">Team or organization name</label><input id="network-name" maxlength="100" placeholder="My team"><p class="hint">This is your network. It groups your shared projects. You become its first owner.</p>
      <label for="project-name">First shared project</label><input id="project-name" maxlength="100"><p class="hint">This workspace connects to this project. Add more projects later using the same server and tunnel.</p>
    </div>
    <div data-step="memories" hidden>
      <p id="local-memory-description">Checking this workspace's local memories…</p>
      <div id="import-choice" hidden><label class="checkbox"><input type="checkbox" id="publish"><span id="publish-label">Share this workspace's existing memories with the project</span></label><p class="hint">A local snapshot is saved before import. Identical records are reused; different versions of the same memory are both preserved. Missing memories never imply deletion.</p><p class="hint">To keep these memories local, cancel setup. Use an empty workspace if you only want to download the shared project.</p></div>
      <div id="legacy-provenance" class="callout" hidden><strong>These older memories have no repository identity.</strong><p>Git can verify this checkout, but cannot prove where an old database came from. Only import these memories if they belong to the repository shown above.</p><label class="checkbox"><input type="checkbox" id="confirm-legacy"><span>I confirm these existing memories belong to this repository</span></label></div>
      <button id="refresh-workspace" class="text-button">Check local memories again</button>
    </div>
    <div data-step="review" hidden><dl class="review-list" id="setup-review"></dl><p class="callout" id="review-effect"></p><p class="hint">Your device credential is stored securely by your operating system. After connection, edits sync automatically. Server administrators can read shared content.</p></div>
    <div id="step-error" class="field-error" role="alert" hidden></div>
    <div class="wizard-navigation"><button id="setup-back" class="secondary" hidden>Back</button><button id="setup-next" class="primary" hidden>Continue</button></div>
  </div>
</div>`;
