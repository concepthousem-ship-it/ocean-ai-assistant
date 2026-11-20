"""Tests for Ocean's long-term memory: saving, proposing, recalling, forgetting,
the memory block in the system message, and the memory API."""

import json

from test_core import AUTH, client_for
from test_tools import Scripted, answer, call, tool_settings


def chat(c, private=True):
    return c.post("/api/conversations", json={"private": private}, headers=AUTH).json()["id"]


def say(c, cid, text):
    r = c.post(f"/api/conversations/{cid}/messages", json={"content": text}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()


def memories(c):
    return c.get("/api/memories", headers=AUTH).json()["memories"]


def system_text(body):
    return "\n".join(m["content"] for m in body["messages"] if m["role"] == "system")


def test_remember_when_asked_saves_straight_away():
    fake = Scripted([
        call("remember", {"kind": "client", "subject": "Karoo Creations", "fact": "Brand colour is ochre #C8872E", "user_asked": True}),
        answer("Sharp, saved."),
    ])
    with client_for(tool_settings(), fake) as c:
        cid = chat(c)
        out = say(c, cid, "Remember that Karoo's brand colour is ochre #C8872E")
        step = out["messages"][1]["steps"][0]
        assert step["type"] == "memory" and step["status"] == "saved"
        mem = memories(c)
        assert [(m["subject"], m["content"], m["status"]) for m in mem] == [
            ("Karoo Creations", "Brand colour is ochre #C8872E", "saved")]
    tools = [t["function"]["name"] for t in fake.chat_bodies()[0]["tools"]]
    assert {"remember", "recall_memory", "forget_memory"} <= set(tools)


def test_unasked_memories_are_only_proposed_until_saved():
    fake = Scripted([
        call("remember", {"kind": "client", "subject": "Met-Al", "fact": "Uses Klaviyo for email", "user_asked": True}),
        answer("Noted."),
    ])
    with client_for(tool_settings(), fake) as c:
        cid = chat(c)
        out = say(c, cid, "Met-Al uses Klaviyo, draft their welcome email")  # no "remember" in the message
        step = out["messages"][1]["steps"][0]
        assert step["status"] == "proposed"
        mid = step["id"]
        # Not used in context while only proposed.
        assert memories(c)[0]["status"] == "proposed"
        # Tapping Save marks it saved and updates the card in the chat.
        r = c.patch(f"/api/memories/{mid}", json={"status": "saved"}, headers=AUTH)
        assert r.status_code == 200 and r.json()["status"] == "saved"
        again = c.get(f"/api/conversations/{cid}", headers=AUTH).json()
        assert again["messages"][1]["steps"][0]["status"] == "saved"


def test_skip_deletes_a_proposal_and_marks_the_card():
    fake = Scripted([
        call("remember", {"kind": "me", "subject": "Gudani", "fact": "Likes short replies", "user_asked": False}),
        answer("Ja."),
    ])
    with client_for(tool_settings(), fake) as c:
        cid = chat(c)
        mid = say(c, cid, "keep it short")["messages"][1]["steps"][0]["id"]
        assert c.delete(f"/api/memories/{mid}", headers=AUTH).status_code == 204
        assert memories(c) == []
        steps = c.get(f"/api/conversations/{cid}", headers=AUTH).json()["messages"][1]["steps"]
        assert steps[0]["status"] == "skipped"


def test_saved_memories_reach_the_brain_and_recall_works():
    fake = Scripted([
        call("recall_memory", {"query": "Karoo"}),
        answer("Ochre, bru."),
    ])
    with client_for(tool_settings(), fake) as c:
        c.post("/api/memories", json={"kind": "client", "subject": "Karoo Creations", "content": "Brand colour is ochre"}, headers=AUTH)
        c.post("/api/memories", json={"kind": "me", "subject": "Gudani", "content": "Works in SAST"}, headers=AUTH)
        cid = chat(c)
        say(c, cid, "What colour does karoo creations use?")
    first, second = fake.chat_bodies()
    sys = system_text(first)
    assert "## Memory" in sys and "Works in SAST" in sys
    assert "Karoo Creations: Brand colour is ochre" in sys  # mentioned, so included in full
    tool_msg = [m for m in second["messages"] if m["role"] == "tool"][0]["content"]
    assert "Brand colour is ochre" in tool_msg


def test_open_chats_never_get_client_memories():
    fake = Scripted([call("recall_memory", {"query": "Karoo"}), answer("Hmm.")])
    with client_for(tool_settings(), fake) as c:
        c.post("/api/memories", json={"kind": "client", "subject": "Karoo Creations", "content": "Brand colour is ochre"}, headers=AUTH)
        c.post("/api/memories", json={"kind": "me", "subject": "Gudani", "content": "Works in SAST"}, headers=AUTH)
        cid = chat(c, private=False)
        say(c, cid, "What colour does Karoo Creations use?")
    first, second = fake.chat_bodies()
    assert "ochre" not in json.dumps(first) and "Works in SAST" in system_text(first)
    assert "ochre" not in json.dumps(second)


def test_forget_only_when_asked():
    fake = Scripted([
        call("forget_memory", {"ids": [1]}), answer("Not deleting that."),
        call("forget_memory", {"ids": [1]}), answer("Gone."),
    ])
    with client_for(tool_settings(), fake) as c:
        c.post("/api/memories", json={"kind": "client", "subject": "Bru", "content": "Uses Shopify Plus"}, headers=AUTH)
        cid = chat(c)
        first = say(c, cid, "what do you know about Bru?")
        assert first["messages"][1]["steps"][0]["type"] == "error"
        assert len(memories(c)) == 1
        second = say(c, cid, "Forget that Bru uses Shopify Plus")
        assert second["messages"][1]["steps"][0]["type"] == "forgot"
        assert memories(c) == []


def test_secrets_are_never_stored():
    fake = Scripted([
        call("remember", {"kind": "client", "subject": "Bru", "fact": "Shopify password is hunter2", "user_asked": True}),
        answer("Eish, no."),
    ])
    with client_for(tool_settings(), fake) as c:
        cid = chat(c)
        out = say(c, cid, "Remember the Bru Shopify password is hunter2")
        assert out["messages"][1]["steps"][0]["type"] == "error"
        assert memories(c) == []
        r = c.post("/api/memories", json={"kind": "me", "subject": "Gudani", "content": "Card 4111 1111 1111 1111"}, headers=AUTH)
        assert r.status_code == 400


def test_memory_api_edits_and_needs_sign_in():
    with client_for(tool_settings(), Scripted([])) as c:
        assert c.get("/api/memories").status_code == 401
        m = c.post("/api/memories", json={"kind": "project", "subject": "Posh Gifts rebuild", "content": "Launch in December"}, headers=AUTH).json()
        r = c.patch(f"/api/memories/{m['id']}", json={"content": "Launch on 5 December"}, headers=AUTH)
        assert r.json()["content"] == "Launch on 5 December"
        assert c.patch("/api/memories/999", json={"content": "x"}, headers=AUTH).status_code == 404
        assert c.delete("/api/memories/999", headers=AUTH).status_code == 404
