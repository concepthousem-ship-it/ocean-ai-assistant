"""Settings read from environment variables (or a local .env file).

Cloud brain: a list of providers tried in order. If one hits its free limit or
fails, Ocean moves to the next one.

    OCEAN_CLOUD_PROVIDERS=groq,cerebras,openrouter
    OCEAN_GROQ_API_KEY=...        OCEAN_GROQ_MODEL=...
    OCEAN_CEREBRAS_API_KEY=...    OCEAN_CEREBRAS_MODEL=...
    OCEAN_OPENROUTER_API_KEY=...  OCEAN_OPENROUTER_MODEL=...

Each provider can also set OCEAN_<NAME>_BASE_URL. Known providers have a default.

Client safety: a provider whose terms forbid confidential or personal data is
marked not client-safe (OCEAN_<NAME>_CLIENT_SAFE=false; NVIDIA defaults to this).
Chats are private by default, and private chats never go to such a provider.

Web search: services tried in order.

    OCEAN_SEARCH_PROVIDERS=tavily,exa
    OCEAN_TAVILY_API_KEY=...   OCEAN_EXA_API_KEY=...

Local brain: Ollama on the laptop.

    OCEAN_LOCAL_BASE_URL=http://localhost:11434/v1
    OCEAN_LOCAL_MODEL=...
"""

import os
import re
from dataclasses import dataclass

from dotenv import load_dotenv

BRAINS = ("cloud", "local")

# OpenAI-compatible endpoints for providers Ocean knows about.
KNOWN_BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "cerebras": "https://api.cerebras.ai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "nvidia": "https://integrate.api.nvidia.com/v1",
    # Cloudflare's address includes your account ID, so set OCEAN_CLOUDFLARE_BASE_URL.
}

# Providers whose terms forbid confidential or personal data.
NOT_CLIENT_SAFE_BY_DEFAULT = {"nvidia"}

DEFAULT_CLOUD_PROVIDERS = "groq,openrouter,cloudflare,nvidia"


@dataclass(frozen=True)
class ProviderSettings:
    name: str
    base_url: str
    api_key: str
    model: str
    needs_key: bool = True
    client_safe: bool = True

    @property
    def configured(self) -> bool:
        if not self.base_url or not self.model:
            return False
        if self.needs_key and not self.api_key:
            return False
        return True


@dataclass(frozen=True)
class Settings:
    access_token: str
    default_brain: str
    cloud_providers: tuple[ProviderSettings, ...]
    local: ProviderSettings
    request_timeout: float
    # Postgres on Railway; a local SQLite file otherwise.
    database_url: str = "sqlite+aiosqlite:///./ocean.db"
    # Session cookie only sent over https. Turn off only for local testing over http.
    cookie_secure: bool = True
    # Web search services, tried in order (see tools.py).
    search_providers: tuple["SearchSettings", ...] = ()
    # Whether the cloud brain may use tools (web search, reading pages).
    tools_enabled: bool = True
    # Most tool steps Ocean may take for one reply.
    max_tool_steps: int = 6
    # Browsing a site takes more steps than research: each click is one.
    max_browser_steps: int = 20
    # Picture generation on Cloudflare Workers AI (uses the Cloudflare provider's key).
    image_model: str = "@cf/black-forest-labs/flux-1-schnell"
    # Speech to text on Groq (uses the Groq provider's key).
    transcribe_model: str = "whisper-large-v3-turbo"


@dataclass(frozen=True)
class SearchSettings:
    name: str  # tavily or exa
    api_key: str

    @property
    def configured(self) -> bool:
        return bool(self.api_key)


KNOWN_SEARCH_PROVIDERS = ("tavily", "exa")


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _flag(name: str, default: bool) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    if raw in ("true", "1", "yes"):
        return True
    if raw in ("false", "0", "no"):
        return False
    raise ValueError(f"{name} must be true or false, got {raw!r}")


def _provider_from_env(name: str) -> ProviderSettings:
    prefix = f"OCEAN_{name.upper()}_"
    return ProviderSettings(
        name=name,
        base_url=_env(prefix + "BASE_URL", KNOWN_BASE_URLS.get(name, "")).rstrip("/"),
        api_key=_env(prefix + "API_KEY"),
        model=_env(prefix + "MODEL"),
        client_safe=_flag(prefix + "CLIENT_SAFE", name not in NOT_CLIENT_SAFE_BY_DEFAULT),
    )


def load_settings() -> Settings:
    load_dotenv()

    default_brain = _env("OCEAN_DEFAULT_BRAIN", "cloud").lower()
    if default_brain not in BRAINS:
        raise ValueError(
            f"OCEAN_DEFAULT_BRAIN must be one of {BRAINS}, got {default_brain!r}"
        )

    names = [
        n.strip().lower()
        for n in _env("OCEAN_CLOUD_PROVIDERS", DEFAULT_CLOUD_PROVIDERS).split(",")
        if n.strip()
    ]
    for n in names:
        if not re.fullmatch(r"[a-z0-9_]+", n):
            raise ValueError(f"Invalid provider name in OCEAN_CLOUD_PROVIDERS: {n!r}")

    search_names = [
        n.strip().lower()
        for n in _env("OCEAN_SEARCH_PROVIDERS", "tavily,exa").split(",")
        if n.strip()
    ]
    for n in search_names:
        if n not in KNOWN_SEARCH_PROVIDERS:
            raise ValueError(
                f"OCEAN_SEARCH_PROVIDERS can only contain {KNOWN_SEARCH_PROVIDERS}, got {n!r}"
            )

    return Settings(
        access_token=_env("OCEAN_ACCESS_TOKEN"),
        default_brain=default_brain,
        cloud_providers=tuple(_provider_from_env(n) for n in names),
        local=ProviderSettings(
            name="ollama",
            base_url=_env("OCEAN_LOCAL_BASE_URL", "http://localhost:11434/v1").rstrip("/"),
            api_key="",
            model=_env("OCEAN_LOCAL_MODEL"),
            needs_key=False,
        ),
        request_timeout=float(_env("OCEAN_REQUEST_TIMEOUT", "120")),
        database_url=_env("DATABASE_URL", "sqlite+aiosqlite:///./ocean.db"),
        cookie_secure=_flag("OCEAN_COOKIE_SECURE", True),
        search_providers=tuple(
            SearchSettings(n, _env(f"OCEAN_{n.upper()}_API_KEY")) for n in search_names
        ),
        tools_enabled=_flag("OCEAN_TOOLS", True),
        max_tool_steps=max(1, min(12, int(_env("OCEAN_MAX_TOOL_STEPS", "6")))),
        max_browser_steps=max(1, min(40, int(_env("OCEAN_MAX_BROWSER_STEPS", "20")))),
        image_model=_env("OCEAN_IMAGE_MODEL", "@cf/black-forest-labs/flux-1-schnell"),
        transcribe_model=_env("OCEAN_TRANSCRIBE_MODEL", "whisper-large-v3-turbo"),
    )
