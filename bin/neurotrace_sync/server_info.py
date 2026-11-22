"""Inspect a server before the user claims its network."""
from .profile import Remote, normalize_url


def inspect_server(server_url, local=False):
    url = normalize_url(server_url)
    if not url.startswith('https://'):
        raise ValueError('Enter the public HTTPS server address')
    if local:
        from .hosting import verify
        verify(url)
    info = Remote(url).request('/v1/status', timeout=5)
    if info.get('protocol') != 1 or 'repository_binding' not in info.get('capabilities', []) or not isinstance(info.get('initialized'), bool) or not info.get('instance_id'):
        raise ValueError('This address does not expose a compatible NeuroTrace server')
    return {'server_url': url, 'initialized': info['initialized']}
