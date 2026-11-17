import base64
import hashlib
import secrets


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(16)}"


def new_token() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def pkce_s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
