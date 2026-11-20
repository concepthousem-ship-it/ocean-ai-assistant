"""Tests for Phase 4 features: file uploads, voice input, chat search,
retry, edit and quick modes."""

import io
import json

import httpx

from ocean_core import files
from test_core import AUTH, FakeBrains, client_for, make_settings


def simple_pdf(text: str) -> bytes:
    """A tiny valid PDF with one line of text."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def docx_bytes(text: str) -> bytes:
    import docx

    d = docx.Document()
    d.add_paragraph(text)
    t = d.add_table(rows=1, cols=2)
    t.rows[0].cells[0].text = "Product"
    t.rows[0].cells[1].text = "R450"
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def xlsx_bytes() -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Sales"
    ws.append(["Month", "Revenue"])
    ws.append(["October", 125000])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# --- Reading files ------------------------------------------------------------------

def test_extract_each_supported_type():
    assert "Hello PDF" in files.extract("brief.pdf", "application/pdf", simple_pdf("Hello PDF")).text
    w = files.extract("notes.docx", "", docx_bytes("Launch plan for Posh Gifts"))
    assert w.kind == "word" and "Launch plan for Posh Gifts" in w.text and "Product | R450" in w.text
    x = files.extract("sales.xlsx", "", xlsx_bytes())
    assert x.kind == "excel" and "[Sheet: Sales]" in x.text and "October,125000" in x.text
    c = files.extract("list.csv", "text/csv", b"name,price\nmug,120\n")
    assert c.kind == "csv" and "mug,120" in c.text
    t = files.extract("section.liquid", "", b"{{ product.title }}")
    assert t.kind == "text" and "product.title" in t.text
    j = files.extract("data.json", "application/json", b'{"a":1}')
    assert '"a": 1' in j.text
    i = files.extract("photo.png", "image/png", b"\x89PNG\r\n\x1a\n...")
    assert i.kind == "image" and i.text == ""


def test_extract_refuses_bad_files():
    import pytest

    with pytest.raises(files.FileError, match="empty"):
        files.extract("a.txt", "text/plain", b"")
    with pytest.raises(files.FileError, match="10 MB"):
        files.extract("a.txt", "text/plain", b"x" * (files.MAX_UPLOAD_BYTES + 1))
    with pytest.raises(files.FileError, match="cannot read .doc"):
        files.extract("old.doc", "", b"\xd0\xcf\x11\xe0")
    with pytest.raises(files.FileError, match="cannot read that type"):
        files.extract("blob.bin", "application/octet-stream", bytes(range(256)) * 20)
    with pytest.raises(files.FileError, match="could not be read"):
        files.extract("broken.pdf", "application/pdf", b"%PDF-1.4 garbage")


def test_long_files_are_cut_for_the_brain():
    text = "x" * 30_000
    shown = files.for_model("big.txt", "text", text)
    assert "cut to save space" in shown
    assert len(shown) < 16_000
    assert "not instructions" in shown


# --- Upload endpoint --------------------------------------------------------------------

def up(c, name, data, mime="text/plain"):
    return c.post("/api/uploads", files={"file": (name, data, mime)}, headers=AUTH)


def test_upload_and_download():
    with client_for(make_settings(), FakeBrains()) as c:
        r = up(c, "brief.pdf", simple_pdf("Spring campaign"), "application/pdf")
        assert r.status_code == 201, r.text
        info = r.json()
        assert info["kind"] == "pdf" and info["name"] == "brief.pdf" and info["chars"] > 0
        d = c.get(f"/api/uploads/{info['id']}", headers=AUTH)
        assert d.status_code == 200 and d.content.startswith(b"%PDF")
        assert "attachment" in d.headers["content-disposition"]
        assert c.get(f"/api/uploads/{info['id']}").status_code == 401


def test_upload_rejects_unreadable_and_needs_sign_in():
    with client_for(make_settings(), FakeBrains()) as c:
        assert up(c, "old.doc", b"\xd0\xcf\x11\xe0").status_code == 400
        assert c.post("/api/uploads", files={"file": ("a.txt", b"hi", "text/plain")}).status_code == 401


def test_upload_name_is_cleaned():
    with client_for(make_settings(), FakeBrains()) as c:
        r = up(c, "../../etc/passwd.txt", b"hello")
    assert r.json()["name"] == "passwd.txt"


def test_attached_file_reaches_the_brain_and_is_remembered():
    fake = FakeBrains()
    with client_for(make_settings(), fake) as c:
        file_id = up(c, "notes.txt", b"The launch date is 3 March.").json()["id"]
        conv = c.post("/api/conversations", json={}, headers=AUTH).json()
        r = c.post(f"/api/conversations/{conv['id']}/messages",
                   json={"content": "When is the launch?", "file_ids": [file_id]}, headers=AUTH)
        assert r.status_code == 200, r.text
        user_msg = r.json()["messages"][0]
        assert user_msg["content"] == "When is the launch?"
        assert user_msg["attachments"] == [{"id": file_id, "name": "notes.txt", "kind": "text"}]
        sent = json.loads(fake.requests[-1].content)["messages"][-1]["content"]
        assert "The launch date is 3 March." in sent and '<file name="notes.txt">' in sent
        # Later messages still include the file in the history.
        c.post(f"/api/conversations/{conv['id']}/messages", json={"content": "And the year?"}, headers=AUTH)
        history = json.loads(fake.requests[-1].content)["messages"]
        assert any("The launch date is 3 March." in m["content"] for m in history if m["role"] == "user")


def test_missing_attachment_is_refused():
    with client_for(make_settings(), FakeBrains()) as c:
        conv = c.post("/api/conversations", json={}, headers=AUTH).json()
        r = c.post(f"/api/conversations/{conv['id']}/messages",
                   json={"content": "x", "file_ids": [999]}, headers=AUTH)
    assert r.status_code == 404


# --- Search, retry, edit, modes ------------------------------------------------------------

def send(c, cid, text, **extra):
    return c.post(f"/api/conversations/{cid}/messages", json={"content": text, **extra}, headers=AUTH)


def test_search_finds_titles_and_message_text():
    with client_for(make_settings(), FakeBrains()) as c:
        a = c.post("/api/conversations", json={"title": "Karoo emails"}, headers=AUTH).json()
        b = c.post("/api/conversations", json={}, headers=AUTH).json()
        send(c, b["id"], "Draft the Posh Gifts hero section")
        found = lambda q: [x["id"] for x in c.get("/api/conversations", params={"q": q}, headers=AUTH).json()]
        assert found("karoo") == [a["id"]]
        assert found("hero section") == [b["id"]]
        assert found("nothing-matches") == []
        assert found("100%") == []  # special characters are treated literally
        assert len(found("")) == 2


def test_regenerate_replaces_the_last_reply():
    fake = FakeBrains()
    with client_for(make_settings(), fake) as c:
        conv = c.post("/api/conversations", json={}, headers=AUTH).json()
        first = send(c, conv["id"], "Hello").json()["messages"][1]
        r = c.post(f"/api/conversations/{conv['id']}/regenerate", json={"provider": "openrouter"}, headers=AUTH)
        assert r.status_code == 200, r.text
        assert r.json()["replaced"] == first["id"]
        msgs = c.get(f"/api/conversations/{conv['id']}", headers=AUTH).json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[1]["provider"] == "openrouter"
    assert json.loads(fake.requests[-1].content)["messages"][-1]["content"] == "Hello"


def test_regenerate_without_reply_is_refused():
    with client_for(make_settings(), FakeBrains()) as c:
        conv = c.post("/api/conversations", json={}, headers=AUTH).json()
        assert c.post(f"/api/conversations/{conv['id']}/regenerate", json={}, headers=AUTH).status_code == 409


def test_edit_last_message_keeps_files_and_drops_old_reply():
    fake = FakeBrains()
    with client_for(make_settings(), fake) as c:
        file_id = up(c, "brief.txt", b"Budget is R20000").json()["id"]
        conv = c.post("/api/conversations", json={}, headers=AUTH).json()
        send(c, conv["id"], "First question")
        send(c, conv["id"], "What is the budgt?", file_ids=[file_id])
        r = c.post(f"/api/conversations/{conv['id']}/edit", json={"content": "What is the budget?"}, headers=AUTH)
        assert r.status_code == 200, r.text
        msgs = c.get(f"/api/conversations/{conv['id']}", headers=AUTH).json()["messages"]
    assert [m["content"] for m in msgs if m["role"] == "user"] == ["First question", "What is the budget?"]
    assert msgs[2]["attachments"][0]["name"] == "brief.txt"
    assert len(msgs) == 4
    assert "Budget is R20000" in json.loads(fake.requests[-1].content)["messages"][-1]["content"]


def test_failed_regenerate_keeps_old_reply():
    fake = FakeBrains()
    with client_for(make_settings(), fake) as c:
        conv = c.post("/api/conversations", json={}, headers=AUTH).json()
        send(c, conv["id"], "Hello")
        fake.behaviour = {"groq.example": 500, "cerebras.example": 500, "or.example": 500}
        assert c.post(f"/api/conversations/{conv['id']}/regenerate", json={}, headers=AUTH).status_code == 502
        msgs = c.get(f"/api/conversations/{conv['id']}", headers=AUTH).json()["messages"]
    assert len(msgs) == 2


def test_mode_adds_a_hint_for_the_brain():
    fake = FakeBrains()
    with client_for(make_settings(), fake) as c:
        conv = c.post("/api/conversations", json={}, headers=AUTH).json()
        send(c, conv["id"], "Best Shopify review apps", mode="research")
    sent = json.loads(fake.requests[-1].content)["messages"]
    assert sent[-2]["role"] == "system" and "Research mode" in sent[-2]["content"]
    assert sent[-1]["content"] == "Best Shopify review apps"


def test_unknown_mode_is_rejected():
    with client_for(make_settings(), FakeBrains()) as c:
        conv = c.post("/api/conversations", json={}, headers=AUTH).json()
        assert send(c, conv["id"], "x", mode="hack").status_code == 422


# --- Voice -----------------------------------------------------------------------------

class FakeWhisper(FakeBrains):
    def __init__(self, status=200, text="Hello Ocean, draft an email"):
        super().__init__()
        self.status, self.text = status, text

    def handler(self, request):
        if request.url.path.endswith("/audio/transcriptions"):
            self.requests.append(request)
            if self.status != 200:
                return httpx.Response(self.status, json={"error": "x"})
            return httpx.Response(200, json={"text": "  " + self.text + "  "})
        return super().handler(request)


def speak(c, data=b"webmdata", mime="audio/webm;codecs=opus"):
    return c.post("/api/transcribe", files={"audio": ("speech.webm", data, mime)}, headers=AUTH)


def test_transcribe_sends_audio_to_whisper():
    fake = FakeWhisper()
    with client_for(make_settings(), fake) as c:
        r = speak(c)
        assert r.status_code == 200, r.text
        assert r.json() == {"text": "Hello Ocean, draft an email"}
        usage = c.get("/api/usage", headers=AUTH).json()
    req = fake.requests[-1]
    assert str(req.url) == "https://groq.example/v1/audio/transcriptions"
    assert req.headers["Authorization"] == "Bearer groq-key"
    body = req.content
    assert b"whisper-large-v3-turbo" in body and b"webmdata" in body
    whisper = next(p for p in usage["providers"] if p["name"] == "whisper")
    assert whisper["today"]["requests"] == 1 and whisper["configured"] is True
    assert whisper["kind"] == "voice"


def test_transcribe_errors():
    with client_for(make_settings(), FakeWhisper(status=429)) as c:
        assert speak(c).status_code == 429
        assert speak(c, mime="application/zip").status_code == 400
        assert speak(c, data=b"").status_code == 400
        assert c.post("/api/transcribe", files={"audio": ("a.webm", b"x", "audio/webm")}).status_code == 401
