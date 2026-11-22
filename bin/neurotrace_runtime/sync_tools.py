"""MCP contracts for shared-memory reads and synchronization barriers."""

SYNC_TOOL_DEFINITIONS = [
    {
        'name': 'neurotrace_sync',
        'description': 'Inspect automatic synchronization or wait for confirmed delivery before a shared-work handoff. retry wakes the worker without resuming a user pause or changing credentials, server or permissions. A device receipt means applied locally, not read by a human.',
        'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
            'action': {'type': 'string', 'enum': ['status', 'wait', 'retry'], 'default': 'status'},
            'thought_id': {'type': 'string', 'description': 'Optional memory ID to inspect or wait for.'},
            'timeout_ms': {'type': 'integer', 'minimum': 0, 'maximum': 30000, 'default': 10000},
            'wait_for_peers': {'type': 'integer', 'minimum': 0, 'maximum': 100, 'default': 0,
                               'description': 'Other devices required to report applying the checkpoint. Offline devices may cause timeout.'},
        }},
        'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': True},
    },
    {
        'name': 'neurotrace_getThought',
        'description': 'Read one memory by ID, its base_text and sync delivery state. Use base_text when editing shared text to preserve concurrent changes. Prefer this over scanning pages when the ID is known.',
        'inputSchema': {'type': 'object', 'additionalProperties': False, 'required': ['thought_id'],
                        'properties': {'thought_id': {'type': 'string'}}},
        'annotations': {'readOnlyHint': True, 'destructiveHint': False, 'idempotentHint': True},
    },
]

SYNC_TOOL_COMMANDS = {'neurotrace_sync': 'sync', 'neurotrace_getThought': 'get_thought'}

SYNC_TOOL_DEFINITIONS += [
 {'name': 'neurotrace_host', 'description': 'Only on an explicit hosting/setup request: start a local NeuroTrace server, verify an administrator-provided HTTPS tunnel URL, or setup a new network/project and return an invitation. Never creates a tunnel or changes Cloudflare. publish_existing requires explicit authorization to share this workspace. No credentials are returned.',
  'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
   'action': {'type': 'string', 'enum': ['status', 'start', 'verify', 'setup', 'stop'], 'default': 'status'},
   'port': {'type': 'integer', 'minimum': 1024, 'maximum': 65535, 'default': 9473},
   'public_url': {'type': 'string'}, 'network_name': {'type': 'string'}, 'project_name': {'type': 'string'},
   'owner_name': {'type': 'string'}, 'invite_name': {'type': 'string'},
   'invite_role': {'type': 'string', 'enum': ['viewer', 'editor', 'admin'], 'default': 'editor'},
   'publish_existing': {'type': 'boolean', 'default': False}}},
  'annotations': {'readOnlyHint': False, 'destructiveHint': True, 'idempotentHint': False}},
 {'name': 'neurotrace_connect', 'description': 'Only when asked to connect shared memory: join using an invitation URL or claim a new cloud server using a private local setup_key_file. Secrets stay out of chat. Explicit publish_existing imports local memories with a logical backup and preserves differing same-ID versions under new IDs.',
  'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
   'invitation_url': {'type': 'string'}, 'server_url': {'type': 'string'}, 'setup_key_file': {'type': 'string'},
   'name': {'type': 'string'}, 'network_name': {'type': 'string'}, 'project_name': {'type': 'string'},
   'publish_existing': {'type': 'boolean', 'default': False}}},
  'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': False}},
 {'name': 'neurotrace_team', 'description': 'Manage team membership only on explicit user request. Inspect members, create single-use invitation links for humans/agents/devices, change roles, remove members or transfer project ownership. Server role checks remain authoritative.',
  'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {
   'action': {'type': 'string', 'enum': ['members', 'invite', 'set_role', 'remove', 'transfer', 'create_project'], 'default': 'members'},
   'name': {'type': 'string'}, 'role': {'type': 'string', 'enum': ['viewer', 'editor', 'admin']},
   'kind': {'type': 'string', 'enum': ['human', 'agent', 'device']}, 'member_id': {'type': 'string'}}},
  'annotations': {'readOnlyHint': False, 'destructiveHint': True, 'idempotentHint': False}},
]
SYNC_TOOL_COMMANDS.update(neurotrace_host='host', neurotrace_connect='connect', neurotrace_team='team')
