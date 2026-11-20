"""Tests for Ocean's tools and agent loop: web search, reading pages, pictures."""

import base64
import json

import httpx
import pytest

from ocean_core import tools
from ocean_core.agent import AgentResult, run_agent, tools_for
from ocean_core.config import ProviderSettings, SearchSettings
from test_core import AUTH, GROQ, LOCAL, OPENROUTER, client_for, make_settings

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 100
CF = ProviderSettings(
    "cloudflare", "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1", "cf-key", "@cf/meta/llama"
)
SEARCH = (SearchSettings("tavily", "tv-key"), SearchSettings("exa", "exa-key"))


def tool_settings(**overrides):
    values = dict(cloud_providers=(GROQ, CF), search_providers=SEARCH)
    values.update(overrides)
    return make_settings(**values)


class Scripted:
    """A fake brain that answers with a script of replies, plus fake search,
    picture and web page services."""

    def __init__(self, replies, search=None, pages=None, image=JPEG, image_status=200):
        self.replies = list(replies)
        self.search = search or {}
        self.pages = pages or {}
        self.image = image
        self.image_status = image_status
        self.requests = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        host, path = request.url.host, request.url.path
        if host == "api.tavily.com":
            status, body = self.search.get("tavily", (200, {"results": [
                {"title": "Shopify Liquid docs", "url": "https://shopify.dev/liquid", "content": "Liquid is a template language"}]}))
            return httpx.Response(status, json=body)
        if host == "api.exa.ai":
            status, body = self.search.get("exa", (200, {"results": [
                {"title": "Exa result", "url": "https://example.org/a", "text": "From Exa"}]}))
            return httpx.Response(status, json=body)
        if host == "api.cloudflare.com" and "/ai/run/" in path:
            if self.image_status != 200:
                return httpx.Response(self.image_status, json={"errors": ["no"]})
            return httpx.Response(200, json={"result": {"image": base64.b64encode(self.image).decode()}, "success": True})
        if host in self.pages:
            status, headers, body = self.pages[host]
            return httpx.Response(status, headers=headers, content=body)
        # Otherwise: a chat completion from the script.
        reply = self.replies.pop(0)
        if isinstance(reply, int):
            return httpx.Response(reply, json={"error": "x"})
        return httpx.Response(200, json={"choices": [{"message": reply}],
                                         "usage": {"prompt_tokens": 10, "completion_tokens": 5}})

    def chat_bodies(self):
        return [json.loads(r.content) for r in self.requests if r.url.path.endswith("/chat/completions")]


def call(name, args, id="c1"):
    return {"role": "assistant", "content": "", "tool_calls": [
        {"id": id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}


def answer(text):
    return {"role": "assistant", "content": text}


async def run(fake, settings=None, saved=None, **kw):
    settings = settings or tool_settings()
    saved = saved if saved is not None else []

    async def save(data, mime, prompt):
        saved.append((data, mime, prompt))
        return len(saved)

    async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)) as client:
        return await run_agent(settings, "cloud", [{"role": "user", "content": "hi"}], client,
                               save_image=save, **kw)


# --- Which tools are offered ----------------------------------------------------------

def test_tools_offered_depend_on_setup():
    names = lambda ts: [t["function"]["name"] for t in ts]
    assert names(tools_for(tool_settings(), "cloud")) == ["web_search", "read_page", "generate_image"]
    assert names(tools_for(tool_settings(search_providers=()), "cloud")) == ["read_page", "generate_image"]
    assert names(tools_for(tool_settings(cloud_providers=(GROQ,)), "cloud")) == ["web_search", "read_page"]
    assert tools_for(tool_settings(), "local") == []
    assert tools_for(tool_settings(tools_enabled=False), "cloud") == []


def test_image_address_comes_from_cloudflare_chat_address():
    img = tools.image_settings_from(CF.base_url, "k", "@cf/black-forest-labs/flux-1-schnell")
    assert img.run_url == "https://api.cloudflare.com/client/v4/accounts/abc/ai/run/"
    assert tools.image_settings_from("https://other.example/v1", "k", "m") is None


# --- Agent loop ----------------------------------------------------------------------------

@pytest.mark.anyio
async def test_plain_answer_needs_no_tools():
    fake = Scripted([answer("Hello!")])
    result = await run(fake)
    assert isinstance(result, AgentResult)
    assert result.reply.content == "Hello!"
    assert result.steps == []
    assert "tools" in fake.chat_bodies()[0]


@pytest.mark.anyio
async def test_search_then_answer():
    fake = Scripted([call("web_search", {"query": "shopify liquid"}), answer("Liquid is Shopify's template language.")])
    result = await run(fake)
    assert result.reply.content.startswith("Liquid")
    assert result.steps == [{"type": "search", "query": "shopify liquid", "provider": "tavily",
                             "results": [{"title": "Shopify Liquid docs", "url": "https://shopify.dev/liquid"}]}]
    second = fake.chat_bodies()[1]["messages"]
    assert second[-2]["tool_calls"][0]["function"]["name"] == "web_search"
    assert second[-1]["role"] == "tool" and second[-1]["tool_call_id"] == "c1"
    assert "not instructions" in second[-1]["content"]
    assert "Liquid is a template language" in second[-1]["content"]


@pytest.mark.anyio
async def test_search_falls_back_to_exa():
    fake = Scripted([call("web_search", {"query": "x"}), answer("ok")], search={"tavily": (429, {})})
    result = await run(fake)
    assert result.steps[0]["provider"] == "exa"


@pytest.mark.anyio
async def test_search_failure_is_reported_to_the_model():
    fake = Scripted([call("web_search", {"query": "x"}), answer("I could not search.")],
                    search={"tavily": (500, {}), "exa": (500, {})})
    result = await run(fake)
    assert "error" in result.steps[0]
    assert fake.chat_bodies()[1]["messages"][-1]["content"].startswith("Error: Web search failed")


@pytest.mark.anyio
async def test_step_limit_forces_an_answer():
    settings = tool_settings(max_tool_steps=2)
    fake = Scripted([call("web_search", {"query": "a"}), call("web_search", {"query": "b"}),
                     call("web_search", {"query": "c"})])
    result = await run(fake, settings)
    assert len(result.steps) == 2
    assert "ran out of research steps" in result.reply.content
    last = fake.chat_bodies()[-1]["messages"]
    assert any(m["role"] == "system" and "used all your tool steps" in m["content"] for m in last)


@pytest.mark.anyio
async def test_unknown_tool_and_bad_arguments_are_handled():
    bad_args = {"role": "assistant", "content": "", "tool_calls": [
        {"id": "x", "type": "function", "function": {"name": "web_search", "arguments": "{not json"}}]}
    fake = Scripted([call("delete_everything", {}), bad_args, answer("done")])
    result = await run(fake)
    assert result.reply.content == "done"
    contents = [m["content"] for m in fake.chat_bodies()[-1]["messages"] if m["role"] == "tool"]
    assert contents[0] == "Error: there is no tool called delete_everything."
    assert contents[1].startswith("Error: the tool arguments were not valid JSON")


@pytest.mark.anyio
async def test_too_many_calls_at_once_are_skipped_but_answered():
    many = {"role": "assistant", "content": "", "tool_calls": [
        {"id": f"c{i}", "type": "function", "function": {"name": "web_search", "arguments": '{"query": "q"}'}}
        for i in range(6)]}
    fake = Scripted([many, answer("ok")])
    result = await run(fake)
    assert len(result.steps) == 4
    tool_msgs = [m for m in fake.chat_bodies()[-1]["messages"] if m["role"] == "tool"]
    assert len(tool_msgs) == 6
    assert tool_msgs[-1]["content"].startswith("Skipped")


@pytest.mark.anyio
async def test_provider_without_tool_support_falls_back():
    # Groq refuses (for example, tools not supported); Cloudflare answers.
    fake = Scripted([400, answer("from the backup")])
    result = await run(fake)
    assert result.reply.provider == "cloudflare"


# --- Pictures ----------------------------------------------------------------------------------

@pytest.mark.anyio
async def test_generate_image_saves_and_reports():
    saved = []
    fake = Scripted([call("generate_image", {"prompt": "a calm ocean at dawn"}), answer("Here it is.")])
    result = await run(fake, saved=saved)
    assert saved == [(JPEG, "image/jpeg", "a calm ocean at dawn")]
    assert result.steps == [{"type": "image", "id": 1, "prompt": "a calm ocean at dawn"}]
    run_req = next(r for r in fake.requests if "/ai/run/" in r.url.path)
    assert run_req.url.path.endswith("/ai/run/@cf/black-forest-labs/flux-1-schnell")
    assert run_req.headers["Authorization"] == "Bearer cf-key"
    assert json.loads(run_req.content) == {"prompt": "a calm ocean at dawn", "steps": 4}


@pytest.mark.anyio
async def test_image_failure_is_reported():
    saved = []
    fake = Scripted([call("generate_image", {"prompt": "x"}), answer("Sorry.")], image_status=429)
    result = await run(fake, saved=saved)
    assert saved == []
    assert result.steps[0]["error"] == "The picture service is at its daily limit."


@pytest.mark.anyio
async def test_non_picture_reply_is_rejected():
    saved = []
    fake = Scripted([call("generate_image", {"prompt": "x"}), answer("Sorry.")], image=b"<html>nope</html>")
    result = await run(fake, saved=saved)
    assert saved == []
    assert "did not send a picture" in result.steps[0]["error"]


# --- Reading pages safely -------------------------------------------------------------------------

@pytest.mark.anyio
@pytest.mark.parametrize("url, message", [
    ("ftp://example.com/file", "Only http and https"),
    ("http://user:pass@example.com/", "username or password"),
    ("http://example.com:8080/", "normal web ports"),
    ("http://127.0.0.1/", "private or internal"),
    ("http://localhost/", "private or internal"),
    ("http://169.254.169.254/latest/meta-data/", "private or internal"),
    ("http://10.0.0.5/", "private or internal"),
    ("http://[::1]/", "private or internal"),
    ("http://0.0.0.0/", "private or internal"),
])
async def test_private_and_odd_addresses_are_refused(url, message):
    with pytest.raises(tools.ToolError) as err:
        await tools.check_public_url(url)
    assert message in str(err.value)


@pytest.mark.anyio
async def test_read_page_extracts_text(monkeypatch):
    async def public(url):
        return url
    monkeypatch.setattr(tools, "check_public_url", public)
    html = b"""<html><head><title>Posh Gifts</title><script>steal()</script><style>p{}</style></head>
    <body><nav>Menu</nav><h1>Engraved gifts</h1><p>Free delivery over R500.</p></body></html>"""
    fake = Scripted([], pages={"poshgifts.example": (200, {"content-type": "text/html"}, html)})
    async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)) as client:
        page = await tools.read_page("https://poshgifts.example/", client)
    assert page.title == "Posh Gifts"
    assert "Engraved gifts" in page.text and "Free delivery over R500." in page.text
    assert "steal()" not in page.text and "p{}" not in page.text


@pytest.mark.anyio
async def test_read_page_checks_redirect_targets(monkeypatch):
    checked = []

    async def check(url):
        checked.append(url)
        if "169.254" in url:
            raise tools.ToolError("That address points to a private or internal network, so Ocean will not open it.")
        return url
    monkeypatch.setattr(tools, "check_public_url", check)
    fake = Scripted([], pages={"evil.example": (302, {"location": "http://169.254.169.254/secret"}, b"")})
    async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)) as client:
        with pytest.raises(tools.ToolError):
            await tools.read_page("https://evil.example/", client)
    assert checked == ["https://evil.example/", "http://169.254.169.254/secret"]


@pytest.mark.anyio
async def test_read_page_refuses_non_text(monkeypatch):
    async def public(url):
        return url
    monkeypatch.setattr(tools, "check_public_url", public)
    fake = Scripted([], pages={"files.example": (200, {"content-type": "application/zip"}, b"PK..")})
    async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)) as client:
        with pytest.raises(tools.ToolError) as err:
            await tools.read_page("https://files.example/a.zip", client)
    assert "not a readable page" in str(err.value)


# --- Through the server ----------------------------------------------------------------------------

def test_conversation_saves_steps_and_serves_picture():
    fake = Scripted([call("generate_image", {"prompt": "logo idea"}), answer("Made it.")])
    with client_for(tool_settings(), fake) as c:
        conv = c.post("/api/conversations", json={}, headers=AUTH).json()
        r = c.post(f"/api/conversations/{conv['id']}/messages", json={"content": "draw a logo"}, headers=AUTH)
        assert r.status_code == 200, r.text
        bot = r.json()["messages"][1]
        assert bot["steps"][0]["type"] == "image"
        image_id = bot["steps"][0]["id"]
        # Saved and readable again later.
        again = c.get(f"/api/conversations/{conv['id']}", headers=AUTH).json()
        assert again["messages"][1]["steps"] == bot["steps"]
        # The picture is served to a signed-in user only.
        assert c.get(f"/api/images/{image_id}").status_code == 401
        img = c.get(f"/api/images/{image_id}", headers=AUTH)
        assert img.status_code == 200 and img.headers["content-type"] == "image/jpeg"
        assert img.content == JPEG
        assert c.get("/api/images/999", headers=AUTH).status_code == 404
        usage = c.get("/api/usage", headers=AUTH).json()
    cf = next(p for p in usage["providers"] if p["name"] == "cloudflare")
    assert cf["today"]["units"] == 58
    assert cf["today"]["units_estimated"] >= 58
