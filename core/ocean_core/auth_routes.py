"""Sign-in endpoints.

- GET  /api/auth/status          is Ocean set up, and is this browser signed in
- POST /api/auth/setup/start     create (or reset) the login; needs the access token
- POST /api/auth/setup/confirm   confirm the first authenticator code, get recovery codes
- POST /api/auth/login           username, password and a 6-digit or recovery code
- POST /api/auth/logout          end this browser's session

Setup needs the access token from Railway's variables, so only the owner of
the Railway project can create or reset the login.
"""

import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from .auth import (
    LOCK_MINUTES,
    MAX_FAILED_ATTEMPTS,
    SESSION_COOKIE,
    SESSION_DAYS,
    check_totp,
    dummy_verify,
    hash_password,
    hash_secret,
    new_recovery_codes,
    new_session_token,
    new_totp_secret,
    normalise_recovery_code,
    otpauth_uri,
    password_problem,
    qr_svg,
    verify_password,
)
from .db import LoginSession, RecoveryCode, User, utcnow

router = APIRouter(prefix="/api/auth")


def aware(dt: datetime | None) -> datetime | None:
    """SQLite returns times without a timezone; they are stored as UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def find_session(db, token: str) -> LoginSession | None:
    session = await db.scalar(
        select(LoginSession).where(LoginSession.token_hash == hash_secret(token))
    )
    if session is None or aware(session.expires_at) <= utcnow():
        return None
    return session


async def current_user(db) -> User | None:
    return await db.scalar(select(User).order_by(User.id).limit(1))


def check_access_token(request: Request, given: str) -> None:
    expected = request.app.state.settings.access_token
    if not expected:
        raise HTTPException(503, "Ocean has no access token set yet.")
    if not secrets.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(401, "That access token is not right.")


async def start_session(request: Request, db, user: User, extra: dict | None = None) -> JSONResponse:
    token = new_session_token()
    db.add(
        LoginSession(
            token_hash=hash_secret(token),
            user_id=user.id,
            expires_at=utcnow() + timedelta(days=SESSION_DAYS),
            user_agent=(request.headers.get("user-agent") or "")[:300],
        )
    )
    await db.commit()
    response = JSONResponse({"signed_in": True, "username": user.username, **(extra or {})})
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 24 * 3600,
        httponly=True,
        secure=request.app.state.settings.cookie_secure,
        samesite="strict",
        path="/",
    )
    return response


# --- Status ------------------------------------------------------------------------

@router.get("/status")
async def status(request: Request) -> dict:
    async with request.app.state.sessions() as db:
        user = await current_user(db)
        token = request.cookies.get(SESSION_COOKIE)
        session = await find_session(db, token) if token else None
    return {
        "setup_done": bool(user and user.totp_confirmed),
        "signed_in": session is not None,
        "username": user.username if (user and session) else None,
    }


# --- Setup -------------------------------------------------------------------------

class SetupStart(BaseModel):
    access_token: str = Field(min_length=1, max_length=500)
    username: str = Field(min_length=2, max_length=80, pattern=r"^[A-Za-z0-9._-]+$")
    password: str = Field(min_length=1, max_length=256)
    # Needed to replace a login that is already set up.
    reset: bool = False


@router.post("/setup/start")
async def setup_start(body: SetupStart, request: Request) -> dict:
    check_access_token(request, body.access_token)
    problem = password_problem(body.password)
    if problem:
        raise HTTPException(400, problem)

    async with request.app.state.sessions() as db:
        existing = await current_user(db)
        if existing and existing.totp_confirmed and not body.reset:
            raise HTTPException(
                409, "Ocean already has a login. Choose to reset it if you want to replace it."
            )
        if existing:
            # Replace the old login completely, signing out every browser.
            await db.execute(delete(LoginSession).where(LoginSession.user_id == existing.id))
            await db.execute(delete(RecoveryCode).where(RecoveryCode.user_id == existing.id))
            await db.delete(existing)
            await db.flush()
        secret = new_totp_secret()
        user = User(
            username=body.username,
            password_hash=hash_password(body.password),
            totp_secret=secret,
            totp_confirmed=False,
        )
        db.add(user)
        await db.commit()

    uri = otpauth_uri(secret, body.username)
    return {"otpauth_uri": uri, "secret": secret, "qr_svg": qr_svg(uri)}


class SetupConfirm(BaseModel):
    access_token: str = Field(min_length=1, max_length=500)
    code: str = Field(min_length=6, max_length=12)


@router.post("/setup/confirm")
async def setup_confirm(body: SetupConfirm, request: Request) -> JSONResponse:
    check_access_token(request, body.access_token)
    async with request.app.state.sessions() as db:
        user = await current_user(db)
        if user is None or user.totp_confirmed:
            raise HTTPException(409, "There is no setup waiting to be confirmed.")
        step = check_totp(user.totp_secret, body.code, user.totp_last_step)
        if step is None:
            raise HTTPException(
                400, "That code did not match. Check your phone's clock and try the newest code."
            )
        user.totp_confirmed = True
        user.totp_last_step = step
        codes = new_recovery_codes()
        for code in codes:
            db.add(RecoveryCode(user_id=user.id, code_hash=hash_secret(normalise_recovery_code(code))))
        await db.commit()
        # Recovery codes are shown once and never stored in readable form.
        return await start_session(request, db, user, {"recovery_codes": codes})


# --- Sign in and out -----------------------------------------------------------------

class Login(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=6, max_length=20)


WRONG = "The username, password or code is not right."


@router.post("/login")
async def login(body: Login, request: Request) -> JSONResponse:
    async with request.app.state.sessions() as db:
        user = await current_user(db)
        if user is None or not user.totp_confirmed:
            raise HTTPException(409, "Ocean's login is not set up yet.")

        now = utcnow()
        locked = aware(user.locked_until)
        if locked and locked > now:
            minutes = max(1, int((locked - now).total_seconds() // 60) + 1)
            raise HTTPException(
                429, f"Too many wrong attempts. Try again in about {minutes} minutes."
            )

        if body.username != user.username:
            dummy_verify(body.password)
            ok = False
        else:
            ok = verify_password(body.password, user.password_hash)

        used_recovery = None
        if ok:
            step = check_totp(user.totp_secret, body.code, user.totp_last_step)
            if step is not None:
                user.totp_last_step = step
            else:
                normalised = normalise_recovery_code(body.code)
                used_recovery = await db.scalar(
                    select(RecoveryCode).where(
                        RecoveryCode.user_id == user.id,
                        RecoveryCode.code_hash == hash_secret(normalised),
                        RecoveryCode.used_at.is_(None),
                    )
                )
                if used_recovery is None:
                    ok = False
                else:
                    used_recovery.used_at = now

        if not ok:
            user.failed_attempts = (user.failed_attempts or 0) + 1
            if user.failed_attempts >= MAX_FAILED_ATTEMPTS:
                user.locked_until = now + timedelta(minutes=LOCK_MINUTES)
                user.failed_attempts = 0
                await db.commit()
                raise HTTPException(
                    429, f"Too many wrong attempts. Sign-in is locked for {LOCK_MINUTES} minutes."
                )
            await db.commit()
            raise HTTPException(401, WRONG)

        user.failed_attempts = 0
        user.locked_until = None
        extra = {}
        if used_recovery is not None:
            await db.flush()
            remaining = await db.scalar(
                select(func.count(RecoveryCode.id)).where(
                    RecoveryCode.user_id == user.id, RecoveryCode.used_at.is_(None)
                )
            )
            extra = {"recovery_code_used": True, "recovery_codes_left": int(remaining or 0)}
        return await start_session(request, db, user, extra)


@router.post("/logout")
async def logout(request: Request) -> JSONResponse:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        async with request.app.state.sessions() as db:
            await db.execute(delete(LoginSession).where(LoginSession.token_hash == hash_secret(token)))
            await db.commit()
    response = JSONResponse({"signed_in": False})
    response.delete_cookie(
        SESSION_COOKIE, path="/", secure=request.app.state.settings.cookie_secure,
        httponly=True, samesite="strict",
    )
    return response
