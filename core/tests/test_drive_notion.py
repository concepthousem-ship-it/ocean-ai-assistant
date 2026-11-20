"""Tests for Google Drive and Notion."""

import json

import httpx

from ocean_core.notion import blocks_from_text, clean_id
from test_core import AUTH, client_for
from test_google import FakeGoogle, chat, connect, gsettings, say
from test_tools import Scripted, answer, call, tool_settings

DRIVE_SCOPES = ("gmail https://www.googleapis.com/auth/drive.readonly "
                "https://www.googleapis.com/auth/drive.file")
PAGE = "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6"
PAGE_DASHED = "1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6"


class FakeDrive(FakeGoogle):
    def __init__(self, replies=(), scope=DRIVE_SCOPES):
        super().__init__(replies)
        self.scope = scope
        self.uploads = []

    def handler(self, request):
        host, path = request.url.host, request.url.path
        if host == "oauth2.googleapis.com" and b"authorization_code" in request.content:
            resp = super().handler(request)
            data = json.loads(resp.content)
            data["scope"] = self.scope
            return httpx.Response(200, json=data)
        if host == "www.googleapis.com" and path.startswith("/drive/v3"):
            self.google.append(request)
            if path == "/drive/v3/files":
                assert "fullText contains 'brand guide'" in request.url.params["q"]
                return httpx.Response(200, json={"files": [
                    {"id": "doc1234567890", "name": "Karoo brand guide", "mimeType": "application/vnd.google-apps.document",
                     "modifiedTime": "2026-11-10T08:00:00Z", "webViewLink": "https://docs.google.com/document/d/doc1234567890"}]})
            if path.endswith("/export"):
                return httpx.Response(200, content=b"Primary colour: ochre #C8872E. Font: Lora.")
            if path == "/drive/v3/files/doc1234567890":
                return httpx.Response(200, json={"id": "doc1234567890", "name": "Karoo brand guide",
                                                 "mimeType": "application/vnd.google-apps.document",
                                                 "webViewLink": "https://docs.google.com/document/d/doc1234567890"})
        if host == "www.googleapis.com" and path.startswith("/upload/drive/v3/files"):
            self.uploads.append(request)
            return httpx.Response(200, json={"id": "new123", "name": "Karoo banner brief",
                                             "webViewLink": "https://docs.google.com/document/d/new123"})
        return super().handler(request)


def test_drive_search_read_and_create():
    fake = FakeDrive([
        call("drive_search", {"query": "brand guide"}),
        call("drive_read", {"id": "doc1234567890"}, id="c2"),
        call("drive_create_doc", {"title": "Karoo banner brief", "content": "Use ochre.\n\nFont: Lora."}, id="c3"),
        answer("Done, bru."),
    ])
    with client_for(gsettings(), fake) as c:
        connect(c)
        assert c.get("/api/google/status", headers=AUTH).json()["drive"] is True
        bot = say(c, chat(c), "Find Karoo's brand guide and write a banner brief in Drive")
    assert [(s["type"], s["action"]) for s in bot["steps"]] == [("drive", "search"), ("drive", "read"), ("drive", "create")]
    assert bot["steps"][2]["link"] == "https://docs.google.com/document/d/new123"
    body = fake.uploads[0].content.decode()
    assert '"mimeType": "application/vnd.google-apps.document"' in body and "Use ochre." in body
    tool_msgs = [m for m in fake.chat_bodies()[2]["messages"] if m["role"] == "tool"]
    assert "ochre #C8872E" in tool_msgs[-1]["content"]
    assert "drive_search" in [t["function"]["name"] for t in fake.chat_bodies()[0]["tools"]]


def test_drive_tools_need_the_drive_permission():
    fake = FakeDrive([answer("hi")], scope="gmail")
    with client_for(gsettings(), fake) as c:
        connect(c)
        assert c.get("/api/google/status", headers=AUTH).json()["drive"] is False
        say(c, chat(c), "hello")
    names = [t["function"]["name"] for t in fake.chat_bodies()[0]["tools"]]
    assert "gmail_search" in names and "drive_search" not in names


class FakeNotion(Scripted):
    def __init__(self, replies=(), token_ok=True):
        super().__init__(list(replies))
        self.token_ok = token_ok
        self.notion = []

    def handler(self, request):
        if request.url.host != "api.notion.com":
            return super().handler(request)
        self.notion.append(request)
        assert request.headers["Notion-Version"] == "2022-06-28"
        if request.headers["Authorization"] != "Bearer ntn_abcdefghijklmnopqrstuvwxyz123456" or not self.token_ok:
            return httpx.Response(401, json={"message": "API token is invalid."})
        path = request.url.path
        if path == "/v1/users/me":
            return httpx.Response(200, json={"object": "user", "type": "bot", "bot": {"workspace_name": "Gudani's Notion"}})
        if path == "/v1/search":
            return httpx.Response(200, json={"results": [{"object": "page", "id": PAGE_DASHED, "url": "https://notion.so/x",
                "last_edited_time": "2026-11-19T10:00:00Z", "properties": {"title": {"type": "title", "title": [{"plain_text": "Clients"}]}}}]})
        if path == f"/v1/pages/{PAGE_DASHED}":
            return httpx.Response(200, json={"object": "page", "id": PAGE_DASHED, "url": "https://notion.so/x",
                                             "properties": {"title": {"type": "title", "title": [{"plain_text": "Clients"}]}}})
        if path == f"/v1/blocks/{PAGE_DASHED}/children" and request.method == "GET":
            return httpx.Response(200, json={"results": [
                {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Karoo"}]}},
                {"type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"plain_text": "Launch 5 Dec"}]}}], "has_more": False})
        if path == f"/v1/blocks/{PAGE_DASHED}/children" and request.method == "PATCH":
            return httpx.Response(200, json={"results": []})
        if path == "/v1/pages" and request.method == "POST":
            body = json.loads(request.content)
            assert body["parent"] == {"page_id": PAGE_DASHED}
            return httpx.Response(200, json={"id": "p2", "url": "https://notion.so/new"})
        return httpx.Response(404, json={"message": "nope"})


TOKEN = "ntn_abcdefghijklmnopqrstuvwxyz123456"


def test_notion_connect_status_and_disconnect():
    fake = FakeNotion()
    with client_for(tool_settings(), fake) as c:
        assert c.get("/api/notion/status", headers=AUTH).json() == {"connected": False, "workspace": None}
        assert c.post("/api/notion/connect", json={"token": "hello there friend"}, headers=AUTH).status_code == 400
        assert c.post("/api/notion/connect", json={"token": "ntn_wrongwrongwrongwrongwrongwrong"}, headers=AUTH).status_code == 400
        r = c.post("/api/notion/connect", json={"token": TOKEN}, headers=AUTH)
        assert r.json() == {"connected": True, "workspace": "Gudani's Notion"}
        assert c.get("/api/notion/status", headers=AUTH).json()["connected"] is True
        assert c.post("/api/notion/connect", json={"token": TOKEN}).status_code == 401
        assert c.post("/api/notion/disconnect", headers=AUTH).json() == {"connected": False}
        assert c.get("/api/notion/status", headers=AUTH).json()["connected"] is False


def test_notion_tools_search_read_create_append():
    fake = FakeNotion([
        call("notion_search", {"query": "clients"}),
        call("notion_read", {"id": PAGE}, id="c2"),
        call("notion_create_page", {"parent_id": PAGE, "title": "Karoo launch", "content": "## Plan\n- Banner\n1. Email"}, id="c3"),
        call("notion_append", {"page_id": PAGE, "content": "Karoo launch page added."}, id="c4"),
        answer("Sorted."),
    ])
    with client_for(tool_settings(), fake) as c:
        c.post("/api/notion/connect", json={"token": TOKEN}, headers=AUTH)
        cid = c.post("/api/conversations", json={"private": True}, headers=AUTH).json()["id"]
        r = c.post(f"/api/conversations/{cid}/messages", json={"content": "Add a Karoo launch page in Notion"}, headers=AUTH)
        bot = r.json()["messages"][1]
    assert [(s["type"], s["action"]) for s in bot["steps"]] == [
        ("notion", "search"), ("notion", "read"), ("notion", "create"), ("notion", "append")]
    read_msg = [m for m in fake.chat_bodies()[2]["messages"] if m["role"] == "tool"][-1]["content"]
    assert "## Karoo" in read_msg and "- Launch 5 Dec" in read_msg
    sys = "\n".join(m["content"] for m in fake.chat_bodies()[0]["messages"] if m["role"] == "system")
    assert "## Notion" in sys


def test_notion_only_in_private_chats():
    fake = FakeNotion([answer("hi")])
    with client_for(tool_settings(), fake) as c:
        c.post("/api/notion/connect", json={"token": TOKEN}, headers=AUTH)
        cid = c.post("/api/conversations", json={"private": False}, headers=AUTH).json()["id"]
        c.post(f"/api/conversations/{cid}/messages", json={"content": "hi"}, headers=AUTH)
    names = [t["function"]["name"] for t in fake.chat_bodies()[0].get("tools", [])]
    assert "notion_search" not in names


def test_notion_helpers():
    assert clean_id(f"https://www.notion.so/Clients-{PAGE}") == PAGE_DASHED
    kinds = [b["type"] for b in blocks_from_text("# A\n## B\n- c\n2. d\nplain")]
    assert kinds == ["heading_1", "heading_2", "bulleted_list_item", "numbered_list_item", "paragraph"]
