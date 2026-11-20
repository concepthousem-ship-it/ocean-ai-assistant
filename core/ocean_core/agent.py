"""Ocean's agent loop.

The model is offered tools (web search, reading pages). When it asks for one,
Ocean runs it, hands back the result, and asks the model again, until it gives
a final answer or reaches the step limit.

Only the cloud brain gets tools; the small laptop model answers directly.
"""

from dataclasses import dataclass, field, replace

import httpx

from .brains import BrainReply, Recorder, ToolCall, _noop, ask_brain
from .browser import BROWSER_TOOL_NAMES, BROWSER_TOOLS, describe_action
from .laptop import LAPTOP_TOOL_NAMES, LAPTOP_TOOLS

CLIENT_TOOL_NAMES = BROWSER_TOOL_NAMES | LAPTOP_TOOL_NAMES
from .config import Settings
from .tools import IMAGE_TOOL, TOOL_SPECS, ImageSaver, ToolContext, image_settings_from, run_tool

MAX_CALLS_PER_TURN = 4
OUT_OF_STEPS = (
    "You have used all your tool steps for this reply. Answer now with what you "
    "already found. Say clearly what you could not check."
)


@dataclass
class Pending:
    """The loop paused because the model asked for browser actions, which only
    the extension can carry out. Resume with resume_agent and their results."""

    convo: list[dict]
    next_step: int
    max_steps: int
    calls: list[ToolCall]
    tools: list[dict]


@dataclass
class AgentResult:
    reply: BrainReply
    steps: list[dict] = field(default_factory=list)
    pending: Pending | None = None


def image_settings(settings: Settings):
    cloudflare = next((p for p in settings.cloud_providers if p.name == "cloudflare"), None)
    if cloudflare is None:
        return None
    return image_settings_from(cloudflare.base_url, cloudflare.api_key, settings.image_model)


def tools_for(settings: Settings, brain: str, can_save_images: bool = True) -> list[dict]:
    if brain != "cloud" or not settings.tools_enabled:
        return []
    have_search = any(p.configured for p in settings.search_providers)
    tools = [t for t in TOOL_SPECS if have_search or t["function"]["name"] != "web_search"]
    if can_save_images and image_settings(settings) is not None:
        tools.append(IMAGE_TOOL)
    return tools


def _ctx(settings: Settings, client, record, save_image) -> ToolContext:
    return ToolContext(
        client=client,
        search_providers=settings.search_providers,
        image=image_settings(settings),
        save_image=save_image,
        record=record,
    )


async def run_agent(
    settings: Settings,
    brain: str,
    messages: list[dict],
    client: httpx.AsyncClient,
    private: bool = True,
    provider: str | None = None,
    model: str | None = None,
    record: Recorder = _noop,
    save_image: ImageSaver | None = None,
    browser: bool = False,
    laptop: bool = False,
) -> AgentResult:
    tools = tools_for(settings, brain, save_image is not None)
    max_steps = settings.max_tool_steps
    if brain == "cloud" and settings.tools_enabled and (browser or laptop):
        if browser:
            tools = tools + BROWSER_TOOLS
        if laptop:
            tools = tools + LAPTOP_TOOLS
        max_steps = settings.max_browser_steps
    return await _loop(
        settings, brain, list(messages), [], 0, max_steps, tools, client,
        private, provider, model, record, save_image,
    )


async def resume_agent(
    settings: Settings,
    brain: str,
    pending: Pending,
    results: dict[str, str],
    steps: list[dict],
    client: httpx.AsyncClient,
    private: bool = True,
    provider: str | None = None,
    model: str | None = None,
    record: Recorder = _noop,
    save_image: ImageSaver | None = None,
) -> AgentResult:
    """Continue after the extension carried out the paused browser actions.
    results maps each pending call id to what happened."""
    convo = list(pending.convo)
    for call in pending.calls:
        content = results.get(call.id, "Not done: Gudani stopped it or it was skipped.")
        convo.append({"role": "tool", "tool_call_id": call.id, "content": content})
    return await _loop(
        settings, brain, convo, list(steps), pending.next_step, pending.max_steps,
        pending.tools, client, private, provider, model, record, save_image,
    )


async def _loop(
    settings, brain, convo, steps, start_step, max_steps, tools, client,
    private, provider, model, record, save_image,
) -> AgentResult:
    ctx = _ctx(settings, client, record, save_image)
    for step in range(start_step, max_steps + 1):
        last_round = step == max_steps
        if last_round and tools:
            convo.append({"role": "system", "content": OUT_OF_STEPS})

        reply = await ask_brain(
            settings, brain, convo, client, private, provider, model, record, tools or None
        )
        if not reply.tool_calls:
            return AgentResult(reply, steps)
        if last_round:
            text = reply.content or (
                "I ran out of research steps before I could finish. "
                "Ask me to continue, or narrow the question."
            )
            return AgentResult(replace(reply, content=text, tool_calls=()), steps)

        convo.append(
            {
                "role": "assistant",
                "content": reply.content or "",
                "tool_calls": [
                    {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}
                    for c in reply.tool_calls
                ],
            }
        )
        browser_calls: list[ToolCall] = []
        for i, call in enumerate(reply.tool_calls):
            if i >= MAX_CALLS_PER_TURN:
                content = "Skipped: too many tool calls at once. Ask again in the next step if needed."
            elif call.name in CLIENT_TOOL_NAMES and any(
                t["function"]["name"] == call.name for t in tools
            ):
                browser_calls.append(call)
                steps.append({"type": "action", "id": call.id, "name": call.name, "summary": describe_action(call.name, call.arguments)})
                continue
            else:
                result = await run_tool(call.name, call.arguments, ctx)
                steps.append(result.step)
                content = result.content
            convo.append({"role": "tool", "tool_call_id": call.id, "content": content})
        if browser_calls:
            pending = Pending(convo, step + 1, max_steps, browser_calls, tools)
            return AgentResult(reply, steps, pending)

    # Not reached: the last round always returns.
    raise RuntimeError("agent loop ended unexpectedly")
