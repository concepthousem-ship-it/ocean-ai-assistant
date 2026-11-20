"""Tests for saved conversations and the usage tracker."""

import json

import httpx

from test_core import AUTH, NVIDIA, FakeBrains, client_for, make_settings


def new_chat(c, **body):
    r = c.post("/api/conversations", json=body, headers=AUTH)
    assert r.status_code == 201
    return r.json()


def send(c, cid, content="Hello Ocean", **extra):
    return c.post(f"/api/conversations/{cid}/messages", json={"content": content, **extra}, headers=AUTH)


# --- Access ------------------------------------------------------------------

def test_conversation_endpoints_need_token():
    with client_for(make_settings(), FakeBrains()) as c:
        assert c.get("/api/conversations").status_code == 401
        assert c.post("/api/conversations", json={}).status_code == 401
        assert c.get("/api/usage").status_code == 401
        assert c.post("/api/conversations/1/messages", json={"content": "x"}).status_code == 401


# --- Conversations -------------------------------------------------------------

def test_new_conversation_is_private_by_default():
    with client_for(make_settings(), FakeBrains()) as c:
        conv = new_chat(c)
    assert conv["private"] is True
    assert conv["title"] == "New chat"


def test_send_message_saves_both_and_sets_title():
    fake = FakeBrains()
    with client_for(make_settings(), fake) as c:
        conv = new_chat(c)
        r = send(c, conv["id"], "Help me build a Shopify landing page for Posh Gifts")
        assert r.status_code == 200
        data = r.json()
        assert [m["role"] for m in data["messages"]] == ["user", "assistant"]
        assert data["messages"][1]["provider"] == "groq"
        assert data["conversation"]["title"] == "Help me build a Shopify landing page for Posh Gifts"

        full = c.get(f"/api/conversations/{conv['id']}", headers=AUTH).json()
        assert [m["content"] for m in full["messages"]] == [
            "Help me build a Shopify landing page for Posh Gifts",
            "echo from groq-model",
        ]


def test_long_first_message_gives_short_title():
    with client_for(make_settings(), FakeBrains()) as c:
        conv = new_chat(c)
        data = send(c, conv["id"], "word " * 50).json()
    assert len(data["conversation"]["title"]) <= 60
    assert data["conversation"]["title"].endswith("...")


def test_history_is_sent_to_the_brain():
    fake = FakeBrains()
    with client_for(make_settings(), fake) as c:
        conv = new_chat(c)
        send(c, conv["id"], "first")
        send(c, conv["id"], "second")
    sent = json.loads(fake.requests[-1].content)["messages"]
    assert [m["role"] for m in sent] == ["system", "user", "assistant", "user"]
    assert [m["content"] for m in sent[1:]] == ["first", "echo from groq-model", "second"]


def test_failed_reply_leaves_conversation_unchanged():
    fake = FakeBrains({"groq.example": 500, "cerebras.example": 500, "or.example": 500})
    with client_for(make_settings(), fake) as c:
        conv = new_chat(c)
        r = send(c, conv["id"])
        assert r.status_code == 502
        full = c.get(f"/api/conversations/{conv['id']}", headers=AUTH).json()
    assert full["messages"] == []
    assert full["title"] == "New chat"


def test_private_conversation_never_reaches_unsafe_provider():
    fake = FakeBrains({"groq.example": 429})
    settings = make_settings(cloud_providers=(make_settings().cloud_providers[0], NVIDIA))
    with client_for(settings, fake) as c:
        conv = new_chat(c)
        r = send(c, conv["id"])
    assert r.status_code == 429
    assert "nvidia.example" not in fake.hosts


def test_non_private_conversation_can_use_unsafe_provider():
    fake = FakeBrains({"groq.example": 429})
    settings = make_settings(cloud_providers=(make_settings().cloud_providers[0], NVIDIA))
    with client_for(settings, fake) as c:
        conv = new_chat(c, private=False)
        r = send(c, conv["id"])
    assert r.status_code == 200
    assert r.json()["messages"][1]["provider"] == "nvidia"


def test_rename_and_change_private():
    with client_for(make_settings(), FakeBrains()) as c:
        conv = new_chat(c)
        r = c.patch(f"/api/conversations/{conv['id']}", json={"title": "Karoo emails", "private": False}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["title"] == "Karoo emails"
    assert r.json()["private"] is False


def test_list_is_newest_first():
    with client_for(make_settings(), FakeBrains()) as c:
        a = new_chat(c, title="A")
        b = new_chat(c, title="B")
        send(c, a["id"])  # A becomes the most recently updated
        titles = [x["title"] for x in c.get("/api/conversations", headers=AUTH).json()]
    assert titles == ["A", "B"]


def test_delete_conversation_removes_messages():
    with client_for(make_settings(), FakeBrains()) as c:
        conv = new_chat(c)
        send(c, conv["id"])
        assert c.delete(f"/api/conversations/{conv['id']}", headers=AUTH).status_code == 204
        assert c.get(f"/api/conversations/{conv['id']}", headers=AUTH).status_code == 404
        assert c.get("/api/conversations", headers=AUTH).json() == []


def test_missing_conversation_gives_404():
    with client_for(make_settings(), FakeBrains()) as c:
        assert c.get("/api/conversations/999", headers=AUTH).status_code == 404
        assert send(c, 999).status_code == 404


def test_empty_message_is_rejected():
    with client_for(make_settings(), FakeBrains()) as c:
        conv = new_chat(c)
        assert send(c, conv["id"], "").status_code == 422


# --- Usage tracker ---------------------------------------------------------------

def provider_entry(data, name):
    return next(p for p in data["providers"] if p["name"] == name)


def test_usage_counts_tokens_per_provider():
    with client_for(make_settings(), FakeBrains()) as c:
        conv = new_chat(c)
        send(c, conv["id"])  # system + user = 2 messages -> 20 prompt tokens
        data = c.get("/api/usage", headers=AUTH).json()
    groq = provider_entry(data, "groq")
    assert groq["today"]["requests"] == 1
    assert groq["today"]["ok"] == 1
    assert groq["today"]["prompt_tokens"] == 20
    assert groq["today"]["completion_tokens"] == 5
    assert groq["today"]["tokens"] == 25
    assert provider_entry(data, "openrouter")["today"]["requests"] == 0


def test_usage_records_failures_and_fallback():
    fake = FakeBrains({"groq.example": 429})
    with client_for(make_settings(), fake) as c:
        conv = new_chat(c)
        send(c, conv["id"])
        data = c.get("/api/usage", headers=AUTH).json()
    groq = provider_entry(data, "groq")
    assert groq["today"]["requests"] == 1
    assert groq["today"]["failed"] == 1
    assert groq["today"]["tokens"] == 0
    assert provider_entry(data, "cerebras")["today"]["ok"] == 1


def test_usage_also_counts_one_off_chats():
    with client_for(make_settings(), FakeBrains()) as c:
        c.post("/chat", json={"messages": [{"role": "user", "content": "hi"}]}, headers=AUTH)
        data = c.get("/api/usage", headers=AUTH).json()
    assert provider_entry(data, "groq")["today"]["requests"] == 1


def test_usage_share_against_daily_limits():
    with client_for(make_settings(), FakeBrains()) as c:
        conv = new_chat(c)
        send(c, conv["id"], provider="openrouter")
        data = c.get("/api/usage", headers=AUTH).json()
    openrouter = provider_entry(data, "openrouter")
    assert openrouter["limits"]["requests_per_day"] == 50
    assert openrouter["used_share"] == round(1 / 50, 4)


def test_usage_estimates_cloudflare_units():
    from ocean_core.config import ProviderSettings

    cf = ProviderSettings("cloudflare", "https://cf.example/v1", "k", "@cf/m")
    with client_for(make_settings(cloud_providers=(cf,)), FakeBrains()) as c:
        conv = new_chat(c)
        send(c, conv["id"])
        data = c.get("/api/usage", headers=AUTH).json()
    entry = provider_entry(data, "cloudflare")
    # 20 prompt tokens * 26,668 / 1M + 5 completion tokens * 204,805 / 1M ≈ 1.56 -> 2
    assert entry["today"]["units_estimated"] == 2
    assert entry["limits"]["units_per_day"] == 10_000


def test_usage_history_has_one_entry_per_day():
    with client_for(make_settings(), FakeBrains()) as c:
        conv = new_chat(c)
        send(c, conv["id"])
        data = c.get("/api/usage?days=7", headers=AUTH).json()
    assert len(data["history"]) == 7
    assert data["history"][-1]["day"] == data["day"]
    assert data["history"][-1]["providers"]["groq"] == {"requests": 1, "tokens": 25}
    from datetime import date, timedelta

    tomorrow = (date.fromisoformat(data["day"]) + timedelta(days=1)).isoformat()
    assert data["resets_at"].startswith(tomorrow + "T00:00:00")


def test_usage_never_shows_keys():
    with client_for(make_settings(), FakeBrains()) as c:
        text = c.get("/api/usage", headers=AUTH).text
    assert "groq-key" not in text and "or-key" not in text


def test_limit_override_from_environment(monkeypatch):
    monkeypatch.setenv("OCEAN_LIMIT_OPENROUTER_REQUESTS_PER_DAY", "1000")
    with client_for(make_settings(), FakeBrains()) as c:
        data = c.get("/api/usage", headers=AUTH).json()
    assert provider_entry(data, "openrouter")["limits"]["requests_per_day"] == 1000


# --- Security headers --------------------------------------------------------------

def test_security_headers_present():
    with client_for(make_settings(), FakeBrains()) as c:
        r = c.get("/health")
    assert "default-src 'self'" in r.headers["Content-Security-Policy"]
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["X-Content-Type-Options"] == "nosniff"


# --- Chat screen ---------------------------------------------------------------

def test_chat_screen_is_served_without_data():
    with client_for(make_settings(), FakeBrains()) as c:
        page = c.get("/")
        script = c.get("/app.js")
        style = c.get("/app.css")
    assert page.status_code == 200
    assert "<title>Ocean</title>" in page.text
    assert script.status_code == 200 and "escapeHtml" in script.text
    assert style.status_code == 200
    # No inline scripts, so the strict security policy holds.
    assert "<script>" not in page.text
    assert "script-src 'self'" in page.headers["Content-Security-Policy"]


def test_api_routes_win_over_chat_screen():
    with client_for(make_settings(), FakeBrains()) as c:
        assert c.get("/health").json()["name"] == "Ocean"
        assert c.get("/api/conversations").status_code == 401
