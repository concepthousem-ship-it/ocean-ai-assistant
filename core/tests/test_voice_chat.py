"""Tests for voice mode: Ocean reading replies aloud, spoken-style replies, and
the personality rules."""

import base64
import json

import httpx

from ocean_core.config import ProviderSettings
from ocean_core.main import VOICE_HINT, without_dashes
from ocean_core.persona import OCEAN_SYSTEM_PROMPT
from ocean_core.voice import speakable, speech_units
from test_core import AUTH, GROQ, FakeBrains, client_for, make_settings

CF = ProviderSettings("cloudflare", "https://api.cloudflare.example/client/v4/accounts/abc/ai/v1", "cf-key", "@cf/m")
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 40


class FakeVoice(FakeBrains):
    def __init__(self, status=200, mode="binary", retired=False):
        super().__init__()
        self.status, self.mode, self.retired = status, mode, retired
        self.speech = []

    def handler(self, request):
        if "/ai/run/@cf/deepgram/aura" in request.url.path:
            self.speech.append(request)
            if self.retired and request.url.path.endswith("aura-1"):
                return httpx.Response(410, json={"errors": ["gone"]})
            if self.status != 200:
                return httpx.Response(self.status, json={"errors": ["x"]})
            if self.mode == "binary":
                return httpx.Response(200, content=MP3, headers={"content-type": "audio/mpeg"})
            if self.mode == "json":
                return httpx.Response(200, json={"result": {"audio": base64.b64encode(MP3).decode()}, "success": True})
            return httpx.Response(200, json={"result": {"audio": base64.b64encode(b"not audio" * 20).decode()}})
        return super().handler(request)


def settings():
    return make_settings(cloud_providers=(GROQ, CF))


def test_speak_returns_mp3_and_counts_usage():
    fake = FakeVoice()
    with client_for(settings(), fake) as c:
        r = c.post("/api/speak", json={"text": "**Sharp**, I sorted it. See [the doc](https://x.example)."}, headers=AUTH)
        assert r.status_code == 200, r.text
        assert r.headers["content-type"] == "audio/mpeg"
        assert r.content == MP3
        usage = c.get("/api/usage", headers=AUTH).json()
    req = fake.speech[-1]
    assert str(req.url) == "https://api.cloudflare.example/client/v4/accounts/abc/ai/run/@cf/deepgram/aura-1"
    assert req.headers["Authorization"] == "Bearer cf-key"
    body = json.loads(req.content)
    assert body == {"text": "Sharp, I sorted it. See the doc.", "speaker": "luna", "encoding": "mp3"}
    cf = next(p for p in usage["providers"] if p["name"] == "cloudflare")
    assert cf["today"]["requests"] == 1


def test_speak_reads_json_audio():
    with client_for(settings(), FakeVoice(mode="json")) as c:
        r = c.post("/api/speak", json={"text": "Howzit"}, headers=AUTH)
        assert r.status_code == 200 and r.content == MP3


def test_speak_errors():
    with client_for(settings(), FakeVoice(status=429)) as c:
        assert c.post("/api/speak", json={"text": "Hi"}, headers=AUTH).status_code == 429
        assert c.post("/api/speak", json={"text": "Hi"}).status_code == 401
        assert c.post("/api/speak", json={"text": ""}, headers=AUTH).status_code == 422
    with client_for(settings(), FakeVoice(mode="junk")) as c:
        assert c.post("/api/speak", json={"text": "Hi"}, headers=AUTH).status_code == 502
    with client_for(make_settings(cloud_providers=(GROQ,)), FakeVoice()) as c:
        assert c.post("/api/speak", json={"text": "Hi"}, headers=AUTH).status_code == 503
    with client_for(settings(), FakeVoice()) as c:
        assert c.post("/api/speak", json={"text": "**  **"}, headers=AUTH).status_code == 400


def test_speakable_strips_markdown():
    text = "## Plan\n- **First** do this\n1. Then `npm test`\n| a | b |\n```js\nx()\n```\nCost: R450 & more — lekker"
    out = speakable(text)
    assert out == "Plan First do this Then npm test (the code is in the chat) Cost: R450 and more, lekker"
    assert speech_units("x" * 1000) == 1364  # Aura 1: about 1.364 units a character


def test_speak_falls_back_to_aura_2_when_aura_1_is_gone():
    fake = FakeVoice(retired=True)
    with client_for(settings(), fake) as c:
        r = c.post("/api/speak", json={"text": "Howzit"}, headers=AUTH)
        assert r.status_code == 200 and r.content == MP3
    assert [q.url.path.rsplit("/", 1)[-1] for q in fake.speech] == ["aura-1", "aura-2-en"]


def test_voice_flag_asks_for_a_spoken_reply():
    fake = FakeVoice()
    with client_for(settings(), fake) as c:
        cid = c.post("/api/conversations", json={}, headers=AUTH).json()["id"]
        r = c.post(f"/api/conversations/{cid}/messages", json={"content": "Howzit", "voice": True}, headers=AUTH)
        assert r.status_code == 200, r.text
        sent = json.loads(fake.requests[-1].content)["messages"]
        assert any(m["role"] == "system" and m["content"] == VOICE_HINT for m in sent)
        r = c.post(f"/api/conversations/{cid}/messages", json={"content": "Typed"}, headers=AUTH)
        sent = json.loads(fake.requests[-1].content)["messages"]
        assert not any(m["content"] == VOICE_HINT for m in sent)


def test_replies_lose_em_and_en_dashes():
    fake = FakeBrains(body={
        "choices": [{"message": {"role": "assistant", "content": "Ja — lekker. Pages 10–20. `a—b`"}}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    })
    with client_for(make_settings(), fake) as c:
        cid = c.post("/api/conversations", json={}, headers=AUTH).json()["id"]
        r = c.post(f"/api/conversations/{cid}/messages", json={"content": "Hi"}, headers=AUTH)
        assert r.json()["messages"][1]["content"] == "Ja, lekker. Pages 10-20. `a—b`"
    assert without_dashes("one – two") == "one, two"


def test_personality_is_witty_and_south_african():
    p = OCEAN_SYSTEM_PROMPT
    for phrase in ("witty, cheeky", "howzit", "strong opinions", "slang-free", "never use em dashes"):
        assert phrase in p
    assert "—" not in p and "–" not in p
