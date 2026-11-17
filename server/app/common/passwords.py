from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)


def hash_password(raw: str) -> str:
    return _hasher.hash(raw)


def verify_password(hashed: str, raw: str) -> bool:
    try:
        return _hasher.verify(hashed, raw)
    except (InvalidHashError, VerificationError):
        return False
