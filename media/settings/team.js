(() => {
  window.NeuroTraceTeam = (get, send) => {
    const labels = {owner: 'Owner', admin: 'Administrator', editor: 'Can edit', viewer: 'Can view'};
    const node = (tag, text, className) => { const value = document.createElement(tag); value.textContent = text || ''; if (className) { value.className = className; } return value; };
    return (team, network, busy) => {
      if (!team || !network) { return; }
      const role = team.role, manage = ['owner', 'admin'].includes(role), human = network.actor.kind === 'human';
      get('team-next-title').textContent = human ? (manage ? 'Next: connect your team' : 'Continue on another device') : 'Project access';
      get('team-next-description').textContent = human ? (manage ? 'Invite people or agents to this project, or pair another device.' : 'Pair your own device below. Ask the project owner to invite other members.') : 'Your sponsor controls your project permissions. Agents cannot issue invitations.';
      get('invite-card').hidden = !(manage && human); get('device-card').hidden = !human;
      get('ownership').hidden = !(role === 'owner' || network.network.is_owner);
      get('transfer').hidden = role !== 'owner'; get('network-transfer').hidden = !network.network.is_owner;
      get('new-project-card').hidden = !network.network.is_owner;
      get('network-name-display').textContent = network.network.name;
      get('network-detail').textContent = network.network.name + (network.network.is_owner ? ' · You own this network' : ' · You do not own this network');
      const container = get('team-list'), transfer = get('transfer-member'); container.replaceChildren(); transfer.replaceChildren();
      for (const member of team.members) {
        const row = node('div', '', 'member'); row.append(node('span', member.kind === 'agent' ? 'AI' : member.name.slice(0, 2).toUpperCase(), 'avatar'));
        const name = node('div', member.name + (member.id === network.actor.id ? ' (you)' : ''), 'member-name');
        name.append(node('small', member.kind === 'agent' ? 'Agent · limited by sponsor' : 'Team member')); row.append(name);
        const canChange = manage && human && member.role !== 'owner' && (role === 'owner' || member.role !== 'admin');
        if (canChange) {
          const select = node('select'); select.setAttribute('aria-label', 'Permission for ' + member.name);
          for (const value of ['viewer', 'editor', ...(role === 'owner' && member.kind === 'human' ? ['admin'] : [])]) { const option = node('option', labels[value]); option.value = value; select.append(option); }
          select.value = member.role; select.disabled = busy;
          select.onchange = () => send('member', {member: member.id, role: select.value}); row.append(select);
          const remove = node('button', 'Remove', 'text-button'); remove.disabled = busy; remove.onclick = () => send('member', {member: member.id, role: null}); row.append(remove);
        } else { row.append(node('span', labels[member.role], 'badge')); }
        container.append(row);
        if (member.kind === 'human' && member.id !== network.actor.id) { const option = node('option', member.name); option.value = member.id; transfer.append(option); }
      }
      get('transfer').disabled = busy || !transfer.options.length; get('network-transfer').disabled = busy || !transfer.options.length;
      get('member-role').querySelector('option[value="admin"]').hidden = role !== 'owner' || get('member-kind').value === 'agent';
    };
  };
})();
