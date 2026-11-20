"""Voice: speech to text with Groq's Whisper, and text to speech with Cloudflare.

Uses the Groq key that already powers the main brain. Usage is recorded under
the name "whisper" so it shows separately in the usage tracker.
"""

import base64
import math
import re

import httpx

from .brains import CallRecord, Recorder, _noop

MAX_AUDIO_BYTES = 20 * 1024 * 1024  # Groq's free limit is 25 MB; stay below it
AUDIO_TYPES = {
    "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "audio/x-m4a": "m4a",
    "audio/aac": "m4a", "video/webm": "webm",
}


class VoiceError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


async def transcribe(
    base_url: str,
    api_key: str,
    model: str,
    audio: bytes,
    content_type: str,
    client: httpx.AsyncClient,
    record: Recorder = _noop,
) -> str:
    if not api_key or not base_url:
        raise VoiceError("Voice input is not set up yet.", 503)
    if not audio:
        raise VoiceError("No sound was recorded.", 400)
    if len(audio) > MAX_AUDIO_BYTES:
        raise VoiceError("That recording is too long. Keep it under about 10 minutes.", 400)
    kind = (content_type or "").split(";")[0].strip().lower()
    ext = AUDIO_TYPES.get(kind)
    if ext is None:
        raise VoiceError("That recording format is not supported.", 400)

    try:
        response = await client.post(
            f"{base_url.rstrip('/')}/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            data={"model": model, "response_format": "json", "temperature": "0"},
            files={"file": (f"speech.{ext}", audio, kind)},
            timeout=120,
        )
    except httpx.TimeoutException:
        await record(CallRecord("whisper", model, False, 504))
        raise VoiceError("Turning speech into text took too long.", 504)
    except httpx.HTTPError:
        await record(CallRecord("whisper", model, False, 502))
        raise VoiceError("Could not reach the speech service.", 502)

    if response.status_code >= 400:
        await record(CallRecord("whisper", model, False, response.status_code))
        if response.status_code == 429:
            raise VoiceError("The speech service is at its limit. Try again shortly.", 429)
        raise VoiceError(f"The speech service returned an error (status {response.status_code}).", 502)
    try:
        text = response.json().get("text", "")
    except (ValueError, AttributeError):
        await record(CallRecord("whisper", model, False, 502))
        raise VoiceError("The speech service sent something Ocean could not read.", 502)
    await record(CallRecord("whisper", model, True, 200))
    return " ".join(str(text).split())


# --- Voice output ------------------------------------------------------------------------

# Cloudflare retired MeloTTS on 20 November 2026. Deepgram Aura is its replacement.
# Aura 1 costs half as much as Aura 2, so it is tried first; Aura 2 is the backup.
# Units per character come from Cloudflare's published rates.
SPEECH_MODELS = (
    ("@cf/deepgram/aura-1", 1.364),
    ("@cf/deepgram/aura-2-en", 2.728),
)
SPEECH_VOICE = "luna"  # a female voice that both Aura models have
MAX_SPEECH_CHARS = 600


def speech_units(text: str, units_per_char: float = SPEECH_MODELS[0][1]) -> int:
    return max(1, math.ceil(len(text) * units_per_char))


def speakable(text: str) -> str:
    """Turn a chat reply into plain sentences that sound right read aloud."""
    t = text or ""
    t = re.sub(r"```.*?```", " (the code is in the chat) ", t, flags=re.S)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", t)  # pictures
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)  # links keep their words
    t = re.sub(r"https?://\S+", " ", t)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"^\s*\|.*\|\s*$", " ", t, flags=re.M)  # table rows
    t = re.sub(r"^\s{0,3}#{1,6}\s*", "", t, flags=re.M)
    t = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", t, flags=re.M)
    t = re.sub(r"[*_~>#]", "", t)
    t = re.sub(r"\s*[\u2013\u2014]\s*", ", ", t)
    t = re.sub(r"[\U0001F000-\U0001FAFF\u2600-\u27BF]", "", t)  # emoji
    t = t.replace("&", " and ")
    return " ".join(t.split())


async def speak(
    run_url: str,
    api_key: str,
    text: str,
    client: httpx.AsyncClient,
    record: Recorder = _noop,
    voice: str = SPEECH_VOICE,
) -> bytes:
    """Read text aloud with Cloudflare Workers AI (Deepgram Aura). Returns MP3 audio."""
    if not api_key or not run_url:
        raise VoiceError("Ocean's voice is not set up yet.", 503)
    text = " ".join((text or "").split())[:MAX_SPEECH_CHARS]
    if not text:
        raise VoiceError("There was nothing to say.", 400)
    last_status = 502
    for model, units_per_char in SPEECH_MODELS:
        try:
            response = await client.post(
                run_url + model,
                headers={"Authorization": f"Bearer {api_key}"},
                json={"text": text, "speaker": voice, "encoding": "mp3"},
                timeout=60,
            )
        except httpx.TimeoutException:
            await record(CallRecord("cloudflare", model, False, 504))
            raise VoiceError("Ocean's voice took too long.", 504)
        except httpx.HTTPError:
            await record(CallRecord("cloudflare", model, False, 502))
            raise VoiceError("Could not reach the voice service.", 502)
        if response.status_code >= 400:
            await record(CallRecord("cloudflare", model, False, response.status_code))
            if response.status_code == 429:
                raise VoiceError("Ocean's voice is at its daily limit. It resets at 02:00.", 429)
            last_status = response.status_code
            continue  # this model may be retired or down: try the next one
        audio = _audio_from(response)
        if not _looks_like_mp3(audio):
            await record(CallRecord("cloudflare", model, False, 502))
            last_status = 502
            continue
        await record(CallRecord("cloudflare", model, True, 200, units=speech_units(text, units_per_char)))
        return audio
    raise VoiceError(f"The voice service returned an error (status {last_status}).", 502)


def _audio_from(response: httpx.Response) -> bytes:
    kind = response.headers.get("content-type", "").split(";")[0].strip().lower()
    if kind.startswith("audio/") or kind == "application/octet-stream":
        return response.content
    try:
        data = response.json()
        encoded = (data.get("result") or {}).get("audio") or data.get("audio")
        return base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError, AttributeError):
        return b""


def _looks_like_mp3(audio: bytes) -> bool:
    if len(audio) < 64:
        return False
    return audio[:3] == b"ID3" or (audio[0] == 0xFF and (audio[1] & 0xE0) == 0xE0)
