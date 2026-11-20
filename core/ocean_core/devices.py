"""Connecting the Chrome extension (and later the Windows app) to Ocean.

1. In the signed-in app, Settings makes a pairing code (8 characters, valid
   for 10 minutes, works once).
2. The extension sends the code to /api/devices/connect and gets its own
   device token, which it keeps. Ocean stores only a hash of it.
3. The device uses the token as "Authorization: Bearer ...". Removing the
   device in Settings stops the token working straight away.

A device token can chat and use the browser tools, but it cannot make new
pairing codes or remove devices; that needs the signed-in app.
"""

import secrets
import time
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from .auth import hash_secret
from .db import Device, PairingCode, utcnow

PAIRING_MINUTES = 10
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L
DEVICE_TOKEN_PREFIX = "ocd_"
MAX_CONNECT_FAILURES = 20
FAILURE_WINDOW_SECONDS = 15 * 60


def new_pairing_code() -> str:
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def normalise_code(code: str) -> str:
    raw = "".join(ch for ch in code.upper() if ch.isalnum())
    return f"{raw[:4]}-{raw[4:]}" if len(raw) == 8 else raw


def aware(dt):
    from datetime import timezone

    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def find_device(db, token: str) -> Device | None:
    if not token.startswith(DEVICE_TOKEN_PREFIX):
        return None
    return await db.scalar(select(Device).where(Device.token_hash == hash_secret(token)))


class ConnectBody(BaseModel):
    code: str = Field(min_length=6, max_length=20)
    name: str = Field(default="Chrome extension", min_length=1, max_length=80)


def device_out(d: Device) -> dict:
    return {
        "id": d.id,
        "name": d.name,
        "created_at": d.created_at.isoformat(),
        "last_used_at": d.last_used_at.isoformat() if d.last_used_at else None,
    }


def make_router(require_owner) -> APIRouter:
    """require_owner: a dependency that allows the signed-in app or the access
    token, but not a device token."""
    from fastapi import Depends

    router = APIRouter()
    failures: list[float] = []

    @router.post("/api/devices/pair", dependencies=[Depends(require_owner)])
    async def pair(request: Request) -> dict:
        code = new_pairing_code()
        async with request.app.state.sessions() as db:
            await db.execute(delete(PairingCode).where(PairingCode.expires_at < utcnow()))
            db.add(
                PairingCode(
                    code_hash=hash_secret(code),
                    expires_at=utcnow() + timedelta(minutes=PAIRING_MINUTES),
                )
            )
            await db.commit()
        return {"code": code, "expires_in": PAIRING_MINUTES * 60}

    @router.post("/api/devices/connect", status_code=201)
    async def connect(body: ConnectBody, request: Request) -> dict:
        now = time.monotonic()
        failures[:] = [t for t in failures if now - t < FAILURE_WINDOW_SECONDS]
        if len(failures) >= MAX_CONNECT_FAILURES:
            raise HTTPException(429, "Too many wrong codes. Wait 15 minutes and make a new code.")
        async with request.app.state.sessions() as db:
            row = await db.scalar(
                select(PairingCode).where(PairingCode.code_hash == hash_secret(normalise_code(body.code)))
            )
            if row is None or aware(row.expires_at) <= utcnow():
                failures.append(now)
                if row is not None:
                    await db.delete(row)
                    await db.commit()
                raise HTTPException(401, "That code is wrong or has expired. Make a new one in Ocean's settings.")
            await db.delete(row)  # single use
            token = DEVICE_TOKEN_PREFIX + secrets.token_urlsafe(32)
            device = Device(name=body.name.strip()[:80], token_hash=hash_secret(token))
            db.add(device)
            await db.commit()
            return {"token": token, "device": device_out(device)}

    @router.get("/api/devices", dependencies=[Depends(require_owner)])
    async def list_devices(request: Request) -> list[dict]:
        async with request.app.state.sessions() as db:
            rows = await db.scalars(select(Device).order_by(Device.id))
            return [device_out(d) for d in rows]

    @router.delete("/api/devices/{device_id}", status_code=204, dependencies=[Depends(require_owner)])
    async def remove_device(device_id: int, request: Request):
        from fastapi.responses import Response

        async with request.app.state.sessions() as db:
            d = await db.get(Device, device_id)
            if d is None:
                raise HTTPException(404, "Device not found.")
            await db.delete(d)
            await db.commit()
        return Response(status_code=204)

    return router
