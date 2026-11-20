"""Ocean's login: username, password and a 6-digit authenticator code.

- Passwords are hashed with scrypt (memory-hard, from Python's standard library).
- Authenticator codes follow RFC 6238 (TOTP), the standard that Google
  Authenticator, Microsoft Authenticator and similar apps use. A code can only
  be used once.
- Recovery codes are single-use and stored only as hashes.
- Sessions are random tokens kept in a cookie that page scripts cannot read;
  the database stores only a hash of each one.
- After 5 wrong attempts, sign-in is locked for 15 minutes.
"""

import base64
import hashlib
import hmac
import io
import secrets
import struct
import time
from urllib.parse import quote

# --- Passwords ------------------------------------------------------------------

SCRYPT_N = 2**15
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_MAXMEM = 64 * 1024 * 1024
MIN_PASSWORD_LENGTH = 12


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
        maxmem=SCRYPT_MAXMEM, dklen=32,
    )
    return "scrypt${}${}${}${}${}".format(
        SCRYPT_N, SCRYPT_R, SCRYPT_P,
        base64.b64encode(salt).decode(), base64.b64encode(digest).decode(),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        kind, n, r, p, salt_b64, digest_b64 = stored.split("$")
        if kind != "scrypt":
            return False
        expected = base64.b64decode(digest_b64)
        actual = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt_b64), n=int(n), r=int(r),
            p=int(p), maxmem=SCRYPT_MAXMEM, dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# A real hash to compare against when the username is wrong, so a wrong
# username takes as long as a wrong password.
_DUMMY_HASH = None


def dummy_verify(password: str) -> None:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password("not-a-real-password")
    verify_password(password, _DUMMY_HASH)


def password_problem(password: str) -> str | None:
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Use at least {MIN_PASSWORD_LENGTH} characters."
    if len(password) > 256:
        return "That password is too long."
    if password.strip() != password:
        return "The password cannot start or end with a space."
    return None


# --- Authenticator codes (TOTP, RFC 6238) ------------------------------------------

TOTP_DIGITS = 6
TOTP_PERIOD = 30


def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _b32decode(secret: str) -> bytes:
    padded = secret.upper() + "=" * (-len(secret) % 8)
    return base64.b32decode(padded)


def totp_at(secret: str, step: int, digits: int = TOTP_DIGITS, digest=hashlib.sha1) -> str:
    key = _b32decode(secret)
    mac = hmac.new(key, struct.pack(">Q", step), digest).digest()
    offset = mac[-1] & 0x0F
    number = struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(number % (10**digits)).zfill(digits)


def current_step(now: float | None = None) -> int:
    return int((time.time() if now is None else now) // TOTP_PERIOD)


def check_totp(secret: str, code: str, last_used_step: int | None, now: float | None = None) -> int | None:
    """Return the matching time step if the code is valid and unused, else None.

    Accepts one step either side of now, to allow for a phone clock that is
    slightly off. Codes from a step already used are rejected (no replays)."""
    code = "".join(code.split())
    if not (code.isdigit() and len(code) == TOTP_DIGITS):
        return None
    step = current_step(now)
    for candidate in (step - 1, step, step + 1):
        if last_used_step is not None and candidate <= last_used_step:
            continue
        if hmac.compare_digest(totp_at(secret, candidate), code):
            return candidate
    return None


def otpauth_uri(secret: str, username: str, issuer: str = "Ocean") -> str:
    label = quote(f"{issuer}:{username}")
    return (
        f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer)}"
        f"&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_PERIOD}"
    )


def qr_svg(text: str) -> str:
    """The QR code for an authenticator app, as SVG text."""
    import qrcode
    import qrcode.image.svg

    image = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, border=2)
    buffer = io.BytesIO()
    image.save(buffer)
    return buffer.getvalue().decode()


# --- Recovery codes and session tokens ----------------------------------------------

RECOVERY_CODE_COUNT = 8
_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no look-alikes such as 0, o, 1, l, i


def new_recovery_codes() -> list[str]:
    codes = []
    for _ in range(RECOVERY_CODE_COUNT):
        raw = "".join(secrets.choice(_ALPHABET) for _ in range(10))
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes


def normalise_recovery_code(code: str) -> str:
    return "".join(ch for ch in code.lower() if ch.isalnum())


def hash_secret(value: str) -> str:
    """For high-entropy values (recovery codes, session tokens): a fast hash is enough."""
    return hashlib.sha256(value.encode()).hexdigest()


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


SESSION_DAYS = 30
MAX_FAILED_ATTEMPTS = 5
LOCK_MINUTES = 15
SESSION_COOKIE = "ocean_session"
