"""Tests for the login: passwords, authenticator codes, recovery codes,
sessions, lockout and protection against other websites (CSRF)."""

import time

import pytest

from ocean_core import auth
from test_core import TOKEN, FakeBrains, client_for, make_settings

PASSWORD = "a long test password"
APP = {"X-Requested-With": "ocean"}


# --- Building blocks -------------------------------------------------------------

def test_totp_matches_rfc_6238_reference_values():
    # RFC 6238 appendix B, SHA-1, secret "12345678901234567890", 8 digits.
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    assert auth.totp_at(secret, 59 // 30, digits=8) == "94287082"
    assert auth.totp_at(secret, 1111111109 // 30, digits=8) == "07081804"
    assert auth.totp_at(secret, 1234567890 // 30, digits=8) == "89005924"
    assert auth.totp_at(secret, 2000000000 // 30, digits=8) == "69279037"


def test_totp_window_and_no_replay():
    secret = auth.new_totp_secret()
    now = 1_800_000_000.0
    step = auth.current_step(now)
    assert auth.check_totp(secret, auth.totp_at(secret, step), None, now) == step
    assert auth.check_totp(secret, auth.totp_at(secret, step - 1), None, now) == step - 1
    assert auth.check_totp(secret, auth.totp_at(secret, step - 2), None, now) is None
    # The same code cannot be used twice.
    assert auth.check_totp(secret, auth.totp_at(secret, step), step, now) is None
    assert auth.check_totp(secret, "12345", None, now) is None
    assert auth.check_totp(secret, "abcdef", None, now) is None


def test_password_hashing():
    stored = auth.hash_password(PASSWORD)
    assert stored.startswith("scrypt$")
    assert PASSWORD not in stored
    assert auth.verify_password(PASSWORD, stored)
    assert not auth.verify_password("wrong password!!", stored)
    assert not auth.verify_password(PASSWORD, "garbage")
    assert auth.hash_password(PASSWORD) != stored  # random salt


def test_password_rules():
    assert auth.password_problem("short") is not None
    assert auth.password_problem(" leading space ok?") is not None
    assert auth.password_problem(PASSWORD) is None


def test_recovery_codes_are_unique_and_readable():
    codes = auth.new_recovery_codes()
    assert len(codes) == 8 and len(set(codes)) == 8
    for c in codes:
        assert len(c) == 11 and c[5] == "-"
        assert not set(c.replace("-", "")) & set("01oli")


# --- Helpers for the flows ---------------------------------------------------------

def setup_login(c, username="gudani", password=PASSWORD):
    r = c.post("/api/auth/setup/start", json={"access_token": TOKEN, "username": username, "password": password})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["otpauth_uri"].startswith("otpauth://totp/Ocean%3A" + username)
    assert "<svg" in data["qr_svg"]
    secret = data["secret"]
    code = auth.totp_at(secret, auth.current_step())
    r = c.post("/api/auth/setup/confirm", json={"access_token": TOKEN, "code": code})
    assert r.status_code == 200, r.text
    return secret, r.json()["recovery_codes"]


def next_code(secret):
    # A code from the next 30-second window, so it was not used yet.
    return auth.totp_at(secret, auth.current_step() + 1)


def login(c, secret=None, code=None, username="gudani", password=PASSWORD):
    return c.post("/api/auth/login", json={
        "username": username, "password": password, "code": code or next_code(secret)})


def fresh():
    return client_for(make_settings(), FakeBrains())


# --- Setup ---------------------------------------------------------------------------

def test_status_before_setup():
    with fresh() as c:
        assert c.get("/api/auth/status").json() == {"setup_done": False, "signed_in": False, "username": None}


def test_setup_needs_the_access_token():
    with fresh() as c:
        r = c.post("/api/auth/setup/start", json={"access_token": "wrong", "username": "gudani", "password": PASSWORD})
    assert r.status_code == 401


def test_setup_rejects_weak_password():
    with fresh() as c:
        r = c.post("/api/auth/setup/start", json={"access_token": TOKEN, "username": "gudani", "password": "short"})
    assert r.status_code == 400


def test_setup_signs_in_and_returns_recovery_codes():
    with fresh() as c:
        _, codes = setup_login(c)
        assert len(codes) == 8
        status = c.get("/api/auth/status").json()
    assert status == {"setup_done": True, "signed_in": True, "username": "gudani"}


def test_setup_cookie_is_locked_down():
    with fresh() as c:
        c.post("/api/auth/setup/start", json={"access_token": TOKEN, "username": "gudani", "password": PASSWORD})
        r = c.post("/api/auth/setup/confirm", json={"access_token": TOKEN, "code": "000000"})
        assert r.status_code == 400  # wrong code
        secret = c.post("/api/auth/setup/start", json={"access_token": TOKEN, "username": "gudani", "password": PASSWORD}).json()["secret"]
        r = c.post("/api/auth/setup/confirm", json={"access_token": TOKEN, "code": auth.totp_at(secret, auth.current_step())})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "samesite=strict" in cookie
    assert "ocean_session=" in cookie


def test_https_only_cookie_in_production():
    settings = make_settings(cookie_secure=True)
    with client_for(settings, FakeBrains()) as c:
        r = c.post("/api/auth/setup/start", json={"access_token": TOKEN, "username": "gudani", "password": PASSWORD})
        secret = r.json()["secret"]
        r = c.post("/api/auth/setup/confirm", json={"access_token": TOKEN, "code": auth.totp_at(secret, auth.current_step())})
    assert "secure" in r.headers["set-cookie"].lower()


def test_setup_cannot_replace_existing_login_without_reset():
    with fresh() as c:
        setup_login(c)
        r = c.post("/api/auth/setup/start", json={"access_token": TOKEN, "username": "someone", "password": PASSWORD})
        assert r.status_code == 409


def test_reset_replaces_login_and_signs_out_old_sessions():
    with fresh() as c:
        setup_login(c)
        old_cookie = c.cookies.get("ocean_session")
        r = c.post("/api/auth/setup/start",
                   json={"access_token": TOKEN, "username": "gudani2", "password": PASSWORD, "reset": True})
        assert r.status_code == 200
        c.cookies.clear()
        c.cookies.set("ocean_session", old_cookie)
        assert c.get("/api/conversations").status_code == 401


# --- Sign in -----------------------------------------------------------------------------

def test_login_with_password_and_code():
    with fresh() as c:
        secret, _ = setup_login(c)
        c.post("/api/auth/logout")
        c.cookies.clear()
        assert c.get("/api/conversations").status_code == 401
        r = login(c, secret)
        assert r.status_code == 200, r.text
        assert c.get("/api/conversations").status_code == 200


def test_login_rejects_wrong_password_username_or_code():
    with fresh() as c:
        secret, _ = setup_login(c)
        c.cookies.clear()
        assert login(c, secret, password="not the password").status_code == 401
        assert login(c, secret, username="intruder").status_code == 401
        assert login(c, code="000000").status_code == 401
        assert c.get("/api/conversations").status_code == 401


def test_code_cannot_be_reused():
    with fresh() as c:
        secret, _ = setup_login(c)
        c.cookies.clear()
        code = next_code(secret)
        assert login(c, code=code).status_code == 200
        c.cookies.clear()
        assert login(c, code=code).status_code == 401


def test_recovery_code_works_once():
    with fresh() as c:
        _, codes = setup_login(c)
        c.cookies.clear()
        r = login(c, code=codes[0].upper())  # case and dash do not matter
        assert r.status_code == 200
        assert r.json()["recovery_code_used"] is True
        assert r.json()["recovery_codes_left"] == 7
        c.cookies.clear()
        assert login(c, code=codes[0]).status_code == 401


def test_lockout_after_five_wrong_attempts():
    with fresh() as c:
        secret, _ = setup_login(c)
        c.cookies.clear()
        for _ in range(4):
            assert login(c, secret, password="wrong password!!").status_code == 401
        assert login(c, secret, password="wrong password!!").status_code == 429
        # Even the right details are refused while locked.
        assert login(c, secret).status_code == 429


def test_login_before_setup_is_refused():
    with fresh() as c:
        assert login(c, code="123456").status_code == 409


def test_logout_ends_the_session():
    with fresh() as c:
        setup_login(c)
        cookie = c.cookies.get("ocean_session")
        c.post("/api/auth/logout")
        c.cookies.set("ocean_session", cookie)
        assert c.get("/api/conversations").status_code == 401


def test_expired_session_is_refused(monkeypatch):
    with fresh() as c:
        setup_login(c)
        monkeypatch.setattr("ocean_core.auth_routes.utcnow",
                            lambda: __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
                            + __import__("datetime").timedelta(days=31))
        assert c.get("/api/conversations").status_code == 401


# --- Using Ocean while signed in ---------------------------------------------------------

def test_cookie_changes_need_the_app_header():
    with fresh() as c:
        setup_login(c)
        # Reading is fine.
        assert c.get("/api/conversations").status_code == 200
        # A change without the header (like a form on another website) is refused.
        assert c.post("/api/conversations", json={}).status_code == 403
        assert c.post("/api/conversations", json={}, headers=APP).status_code == 201


def test_access_token_still_works_for_the_laptop_app():
    with fresh() as c:
        setup_login(c)
        c.cookies.clear()
        r = c.post("/api/conversations", json={}, headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 201


def test_made_up_cookie_is_refused():
    with fresh() as c:
        setup_login(c)
        c.cookies.clear()
        c.cookies.set("ocean_session", "made-up-value")
        assert c.get("/api/conversations").status_code == 401


def test_session_tokens_are_not_stored_readably():
    import asyncio

    from sqlalchemy import select

    from ocean_core.db import LoginSession

    with fresh() as c:
        setup_login(c)
        cookie = c.cookies.get("ocean_session")

        async def stored():
            async with c.app.state.sessions() as db:
                return [s.token_hash for s in await db.scalars(select(LoginSession))]

        hashes = c.portal.call(stored) if hasattr(c, "portal") and c.portal else asyncio.run(stored())
    assert cookie not in hashes
    assert auth.hash_secret(cookie) in hashes
