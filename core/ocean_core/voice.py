"""Voice input: turning speech into text with Groq's Whisper models.

Uses the Groq key that already powers the main brain. Usage is recorded under
the name "whisper" so it shows separately in the usage tracker.
"""

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
