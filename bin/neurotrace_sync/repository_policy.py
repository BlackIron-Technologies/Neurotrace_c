"""Server-side repository binding and invitation previews."""
import json
import time

from .repository import require_same_repository, validate_repository
from .store import digest, require


class RepositoryPolicy:
    def __init__(self, store, identity):
        self.store, self.identity = store, identity

    def project_repository(self, project):
        row = self.store.one('SELECT repository FROM projects WHERE id=?', (project,))
        require(row, 'Project not found', 404)
        require(row['repository'], 'Project repository is not configured. Its owner must protect this legacy project first.', 409)
        return json.loads(row['repository'])

    def check(self, project, fingerprint):
        repository = self.project_repository(project)
        require(fingerprint and fingerprint == repository['id'], 'Repository identity mismatch or missing. Upgrade the client and open the matching repository.', 409)

    def pin(self, actor, project, repository):
        self.identity.role(actor, project, 'owner')
        require(actor['kind'] == 'human', 'Only the project owner can protect its repository', 403)
        repository = validate_repository(repository)
        with self.store.transaction():
            previous = self.store.one('SELECT repository FROM projects WHERE id=?', (project,))
            if previous['repository']:
                require_same_repository(json.loads(previous['repository']), repository)
            else:
                self.store.conn.execute('UPDATE projects SET repository=? WHERE id=?', (json.dumps(repository), project))
                self.store.log(project, actor['id'], 'repository_protected', repository)
        return repository

    def preview(self, code, repository):
        repository = validate_repository(repository)
        invite = self.store.one('SELECT * FROM invites WHERE hash=? AND used=0 AND expires>?', (digest(code), time.time()))
        require(invite, 'Invitation expired or already used', 403)
        sponsor = self.store.one('SELECT *, NULL AS scope FROM actors WHERE id=?', (invite['sponsor'],))
        self.identity.role(sponsor, invite['project'], 'viewer' if invite['kind'] == 'device' else 'admin')
        expected = self.project_repository(invite['project'])
        require_same_repository(expected, repository)
        project = self.store.one('SELECT name FROM projects WHERE id=?', (invite['project'],))
        return {'project_id': invite['project'], 'project_name': project['name'],
                'network_name': self.store.one('SELECT name FROM network')['name'],
                'repository': expected, 'role': invite['role'], 'expires_at': invite['expires']}
