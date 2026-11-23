"""TLS settings for connections to remote sync servers."""
import ssl
from functools import lru_cache

import certifi


@lru_cache(maxsize=1)
def client_context():
    """Return a verifying client context that trusts the system roots and the bundled certifi roots."""
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    return context
