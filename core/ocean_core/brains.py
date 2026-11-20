"""Talking to brains over the OpenAI-compatible chat completions API.

- cloud: several hosted providers (for example Groq, OpenRouter, Cloudflare,
  NVIDIA), tried in order until one answers.
- local: Ollama on the laptop, which serves the same API.

Every attempt to call a provider is reported to an optional `record` hook,
which the server uses to keep the usage tracker up to date.
"""

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace

import httpx

from .config import ProviderSettings, Settings


class BrainError(Exception):
    """A brain could not answer. The message is safe to show to the user."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class CallRecord:
    """One attempt to call one provider."""

    provider: str
    model: str
    ok: bool
    status: int
    prompt_tokens: int = 0
    completion_tokens: int = 0
    units: int = 0


Recorder = Callable[[CallRecord], Awaitable[None]]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: str  # JSON text, exactly as the model sent it


@dataclass(frozen=True)
class BrainReply:
    brain: str
    provider: str
    model: str
    content: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    tool_calls: tuple[ToolCall, ...] = ()


async def _noop(_: CallRecord) -> None:
    return None


def _tokens(data: dict) -> tuple[int, int]:
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(usage, dict):
        return 0, 0

    def as_int(value) -> int:
        return value if isinstance(value, int) and value >= 0 else 0

    return as_int(usage.get("prompt_tokens")), as_int(usage.get("completion_tokens"))


def _tool_calls(message: dict) -> tuple[ToolCall, ...]:
    calls = message.get("tool_calls") if isinstance(message, dict) else None
    if not isinstance(calls, list):
        return ()
    out = []
    for i, c in enumerate(calls):
        fn = c.get("function") if isinstance(c, dict) else None
        if not isinstance(fn, dict) or not isinstance(fn.get("name"), str):
            continue
        args = fn.get("arguments")
        if isinstance(args, dict):  # some providers send an object instead of text
            args = json.dumps(args)
        out.append(ToolCall(str(c.get("id") or f"call_{i}"), fn["name"], args if isinstance(args, str) else "{}"))
    return tuple(out)


async def ask_provider(
    provider: ProviderSettings,
    messages: list[dict],
    client: httpx.AsyncClient,
    timeout: float,
    record: Recorder = _noop,
    tools: list[dict] | None = None,
) -> BrainReply:
    """Ask one provider. Returns a BrainReply (brain left blank) or raises BrainError."""
    if not provider.configured:
        raise BrainError(f"{provider.name} is not set up yet.", 503)

    async def fail(message: str, status: int) -> BrainError:
        await record(CallRecord(provider.name, provider.model, False, status))
        return BrainError(message, status)

    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"

    payload = {"model": provider.model, "messages": messages}
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    try:
        response = await client.post(
            f"{provider.base_url}/chat/completions",
            json=payload,
            headers=headers,
            timeout=timeout,
        )
    except httpx.TimeoutException:
        raise await fail(f"{provider.name} took too long to answer.", 504)
    except httpx.HTTPError:
        raise await fail(f"Could not reach {provider.name}.", 502)

    if response.status_code == 429:
        raise await fail(f"{provider.name} hit its usage limit.", 429)
    if response.status_code >= 400:
        await record(CallRecord(provider.name, provider.model, False, response.status_code))
        raise BrainError(
            f"{provider.name} returned an error (status {response.status_code}).", 502
        )

    try:
        data = response.json()
        message = data["choices"][0]["message"]
        content = message.get("content")
    except (ValueError, KeyError, IndexError, TypeError, AttributeError):
        raise await fail(f"{provider.name} sent a reply Ocean could not read.", 502)
    calls = _tool_calls(message) if tools else ()
    if content is None:
        content = ""
    if not isinstance(content, str) or (not content and not calls):
        raise await fail(f"{provider.name} sent an empty reply.", 502)

    prompt_tokens, completion_tokens = _tokens(data)
    await record(
        CallRecord(provider.name, provider.model, True, 200, prompt_tokens, completion_tokens)
    )
    return BrainReply(
        "", provider.name, provider.model, content, prompt_tokens, completion_tokens, calls
    )


async def ask_cloud(
    settings: Settings,
    messages: list[dict],
    client: httpx.AsyncClient,
    private: bool = True,
    only: str | None = None,
    model: str | None = None,
    record: Recorder = _noop,
    tools: list[dict] | None = None,
) -> BrainReply:
    """Try each set-up cloud provider in order until one answers.

    Private chats skip providers that are not client-safe.
    `only` picks one provider by name (no fallback); `model` overrides its model."""
    if model and not only:
        raise BrainError("Choosing a model also needs a provider.", 400)

    if only:
        match = [p for p in settings.cloud_providers if p.name == only]
        if not match:
            raise BrainError(f"{only} is not one of Ocean's cloud providers.", 400)
        provider = match[0]
        if model:
            provider = replace(provider, model=model)
        if private and not provider.client_safe:
            raise BrainError(
                f"{provider.name} is not safe for private chats. "
                f"Send the chat as not private to use it.",
                403,
            )
        reply = await ask_provider(
            provider, messages, client, settings.request_timeout, record, tools
        )
        return replace(reply, brain="cloud")

    configured = [p for p in settings.cloud_providers if p.configured]
    ready = [p for p in configured if p.client_safe or not private]
    if not ready:
        if configured:
            raise BrainError(
                "No cloud provider that is safe for private chats is set up.", 503
            )
        raise BrainError("No cloud provider is set up yet.", 503)

    failures: list[BrainError] = []
    for provider in ready:
        try:
            reply = await ask_provider(
                provider, messages, client, settings.request_timeout, record, tools
            )
            return replace(reply, brain="cloud")
        except BrainError as err:
            failures.append(err)

    summary = "; ".join(str(f) for f in failures)
    status = 429 if all(f.status_code == 429 for f in failures) else 502
    raise BrainError(f"All cloud providers failed: {summary}", status)


async def ask_local(
    settings: Settings,
    messages: list[dict],
    client: httpx.AsyncClient,
    record: Recorder = _noop,
) -> BrainReply:
    try:
        reply = await ask_provider(
            settings.local, messages, client, settings.request_timeout, record
        )
    except BrainError as err:
        raise BrainError(f"Local brain: {err}", err.status_code)
    return replace(reply, brain="local")


async def ask_brain(
    settings: Settings,
    brain: str,
    messages: list[dict],
    client: httpx.AsyncClient,
    private: bool = True,
    only: str | None = None,
    model: str | None = None,
    record: Recorder = _noop,
    tools: list[dict] | None = None,
) -> BrainReply:
    if brain == "cloud":
        return await ask_cloud(settings, messages, client, private, only, model, record, tools)
    if only or model:
        raise BrainError("Choosing a provider or model only works for the cloud brain.", 400)
    if brain == "local":
        return await ask_local(settings, messages, client, record)
    raise BrainError(f"Unknown brain: {brain}", 400)
