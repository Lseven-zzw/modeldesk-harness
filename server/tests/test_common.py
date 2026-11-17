import base64
from datetime import UTC, datetime

import pytest
from cryptography.exceptions import InvalidTag

from app.common.clock import billing_month, resets_at
from app.common.crypto import SecretBox
from app.common.ids import new_id, new_token, pkce_s256
from app.common.passwords import hash_password, verify_password


def test_ids_are_opaque_and_prefixed():
    assert new_id("gtx").startswith("gtx_")
    assert len(new_id("gsess")) <= 40
    assert new_id("gtx") != new_id("gtx")


def test_token_is_43_char_urlsafe():
    token = new_token()
    assert len(token) == 43
    assert "=" not in token
    assert set(token) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


def test_pkce_known_vector():
    # RFC 7636 附录 B
    assert (
        pkce_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    )


def test_billing_month_uses_shanghai():
    assert billing_month(datetime(2026, 10, 31, 16, 30, tzinfo=UTC)) == "2026-11"
    assert billing_month(datetime(2026, 10, 31, 15, 59, tzinfo=UTC)) == "2026-10"
    assert resets_at("2026-11") == "2026-12-01T00:00:00+08:00"


def test_secret_box_round_trip_and_tamper():
    box = SecretBox(base64.urlsafe_b64encode(b"k" * 32).decode())
    blob = box.encrypt("sk-upstream-key")
    assert blob != b"sk-upstream-key"
    assert box.decrypt(blob) == "sk-upstream-key"
    with pytest.raises(InvalidTag):
        box.decrypt(blob[:-1] + bytes([blob[-1] ^ 1]))


def test_password_hash():
    h = hash_password("correct horse battery staple")
    assert h.startswith("$argon2id$")
    assert verify_password(h, "correct horse battery staple")
    assert not verify_password(h, "wrong")
