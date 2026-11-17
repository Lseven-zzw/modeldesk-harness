import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class SecretBox:
    def __init__(self, key_b64: str):
        key = base64.urlsafe_b64decode(key_b64 + "=" * (-len(key_b64) % 4))
        if len(key) != 32:
            raise ValueError("master key must decode to 32 bytes")
        self._aead = AESGCM(key)

    def encrypt(self, plaintext: str) -> bytes:
        nonce = os.urandom(12)
        return nonce + self._aead.encrypt(nonce, plaintext.encode(), b"modeldesk-model-key")

    def decrypt(self, blob: bytes) -> str:
        return self._aead.decrypt(blob[:12], blob[12:], b"modeldesk-model-key").decode()
