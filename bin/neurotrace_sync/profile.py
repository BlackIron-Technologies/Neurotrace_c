"""Machine-local bindings and OS-protected device credentials."""
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.error import HTTPError

import keyring

USER_AGENT = "NeuroTrace/1.3.2"


def normalize_url(value):
    parts = urlsplit(value.strip().rstrip("/"))
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError("Enter the server origin, for example https://memory.example.com")
    if parts.scheme != "https" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("Remote servers require HTTPS")
    return value.strip().rstrip("/")


def sync_home():
    return Path(os.environ.get("NEUROTRACE_SYNC_HOME", str(Path.home() / ".neurotrace" / "sync")))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class RemoteError(Exception):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


class Remote:
    def __init__(self, url, token=""):
        self.url, self.token = normalize_url(url), token

    def request(self, path, data=None, timeout=15):
        headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = Request(self.url + path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
        try:
            with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
                return json.load(response)
        except HTTPError as exc:
            try:
                message = json.load(exc).get("error", "Server rejected request")
            except (ValueError, AttributeError):
                message = "Server rejected request (HTTP " + str(exc.code) + "). Check the server and proxy access rules."
            raise RemoteError(message, exc.code) from None


class Profile:
    def __init__(self, workspace):
        self.key = hashlib.sha256(str(Path(workspace).resolve()).encode()).hexdigest()
        self.path = sync_home() / "profiles" / (self.key + ".json")

    def read(self):
        if not self.path.exists():
            return None
        return json.loads(self.path.read_text(encoding="utf-8"))

    def write(self, value):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value), encoding="utf-8")
        os.replace(temporary, self.path)

    def credential_key(self, url, actor):
        return hashlib.sha256((normalize_url(url) + "/" + actor).encode()).hexdigest()

    def save_token(self, url, actor, token):
        backend = keyring.get_keyring()
        # Refuse plaintext and unavailable keyring backends.
        if backend.priority <= 0 or "plaintext" in type(backend).__name__.lower():
            raise RuntimeError("A secure operating-system credential store is required")
        keyring.set_password("NeuroTrace Sync", self.credential_key(url, actor), token)

    def prepare_credentials(self, url):
        import secrets
        probe = "probe-" + secrets.token_hex(12)
        self.save_token(url, probe, secrets.token_urlsafe(32))
        keyring.delete_password("NeuroTrace Sync", self.credential_key(url, probe))

    def token(self, profile):
        return keyring.get_password("NeuroTrace Sync", self.credential_key(profile["server_url"], profile["actor_id"]))
