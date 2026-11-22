"""Verify an administrator-provided public endpoint without managing its tunnel."""
from .profile import Remote, normalize_url


class PublicEndpoint:
    def __init__(self):
        self.public_url = None
        self.verified = False

    def status(self):
        return {'public_url': self.public_url, 'verified': self.verified, 'tunnel_managed_externally': True}

    def verify(self, public_url, origin):
        url = normalize_url(public_url)
        if not url.startswith('https://'):
            raise ValueError('A public address must use HTTPS')
        self.verified = False
        local = Remote(origin).request('/v1/status', timeout=3)
        public = Remote(url).request('/v1/status', timeout=5)
        if not local.get('instance_id') or public.get('instance_id') != local['instance_id']:
            raise ValueError('This address points to a different server. Ask the administrator to route it to ' + origin)
        self.public_url, self.verified = url, True
        return self.status()

    def stop(self):
        self.public_url, self.verified = None, False
