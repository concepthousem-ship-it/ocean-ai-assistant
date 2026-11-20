"""Free-tier limits the usage tracker compares against.

These figures were checked on 2026-11-19 and can change at any time. Each one
can be overridden with an environment variable, for example:

    OCEAN_LIMIT_GROQ_REQUESTS_PER_DAY=1000
    OCEAN_LIMIT_GROQ_TOKENS_PER_DAY=200000
    OCEAN_LIMIT_CLOUDFLARE_UNITS_PER_DAY=10000

A limit of 0 or unset means "no known daily limit".
"""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Limit:
    requests_per_day: int = 0
    tokens_per_day: int = 0
    # Cloudflare counts "units" (neurons) instead of tokens.
    units_per_day: int = 0
    units_per_million_input: int = 0
    units_per_million_output: int = 0
    requests_per_minute: int = 0
    requests_per_month: int = 0
    note: str = ""


DEFAULT_LIMITS: dict[str, Limit] = {
    "groq": Limit(
        requests_per_day=1000,
        tokens_per_day=200_000,
        requests_per_minute=30,
        note="From the Groq account limits page for gpt-oss-120b.",
    ),
    "openrouter": Limit(
        requests_per_day=50,
        note="Free-model requests per day, as reported by the OpenRouter key.",
    ),
    "cloudflare": Limit(
        units_per_day=10_000,
        units_per_million_input=26_668,
        units_per_million_output=204_805,
        note="Units estimated from tokens using Cloudflare's published rates "
        "for Llama 3.3 70B fp8-fast. Resets at midnight UTC.",
    ),
    "nvidia": Limit(
        requests_per_minute=40,
        note="No published daily limit. About 40 per minute is a community figure.",
    ),
    "whisper": Limit(
        requests_per_day=2000,
        requests_per_minute=20,
        note="Voice input (Groq Whisper). Also limited to about 8 hours of audio a day.",
    ),
    "tavily": Limit(
        requests_per_month=1000,
        note="Web search. 1,000 free searches a month; each basic search uses 1.",
    ),
    "exa": Limit(
        note="Web search backup. Free monthly credits; Exa does not publish a fixed search count.",
    ),
}

FIELDS = (
    "requests_per_day",
    "tokens_per_day",
    "units_per_day",
    "units_per_million_input",
    "units_per_million_output",
    "requests_per_minute",
    "requests_per_month",
)


def limit_for(provider: str) -> Limit:
    base = DEFAULT_LIMITS.get(provider, Limit())
    values = {}
    for field in FIELDS:
        raw = os.getenv(f"OCEAN_LIMIT_{provider.upper()}_{field.upper()}", "").strip()
        if raw:
            try:
                values[field] = max(0, int(raw))
            except ValueError:
                raise ValueError(
                    f"OCEAN_LIMIT_{provider.upper()}_{field.upper()} must be a whole number"
                )
    return Limit(**{**base.__dict__, **values})


def estimate_units(limit: Limit, prompt_tokens: int, completion_tokens: int) -> int:
    if not (limit.units_per_million_input or limit.units_per_million_output):
        return 0
    units = (
        prompt_tokens * limit.units_per_million_input
        + completion_tokens * limit.units_per_million_output
    ) / 1_000_000
    return round(units)
