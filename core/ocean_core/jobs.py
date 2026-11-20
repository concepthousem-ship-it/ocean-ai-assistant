"""Job hunting for Ocean.

Two ways to find LinkedIn jobs, both only collect links; Gudani applies himself:
1. Job alert emails: LinkedIn emails him new posts for his saved searches.
   Ocean reads those from Gmail every morning (and whenever asked).
2. A Chrome search: from the extension, Ocean opens LinkedIn job searches in a
   background tab of his own Chrome, reads the results and closes the tab.

Every job is checked against his title words, stored once (by LinkedIn job id)
and shown in the Jobs panel.
"""

import asyncio
import html as htmlmod
import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .db import AppSetting, Job, utcnow

LINKEDIN_SOUTH_AFRICA = "104035573"
DEFAULT_PREFS = {
    "searches": [
        "Shopify",
        "Klaviyo OR \"email marketing\"",
        "\"e-commerce\" OR ecommerce",
        "CRO OR \"conversion rate\" OR \"web developer\"",
    ],
    "title_words": [
        "shopify", "klaviyo", "email marketing", "email specialist", "crm", "lifecycle", "retention",
        "e-commerce", "ecommerce", "online store", "cro", "conversion", "web developer", "front-end", "frontend",
    ],
    "location": "South Africa",
    "geo_id": LINKEDIN_SOUTH_AFRICA,
    "hours": 24,
    "morning_hour": 7,
}
ALERT_QUERY = "from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR jobs-listings@linkedin.com) newer_than:2d"
JOB_LINK = re.compile(r"https://(?:[a-z]{2,3}\.)?linkedin\.com/(?:comm/)?jobs/view/(?:[^/?#\"]*-)?(\d{6,})", re.I)

JOBS_RULES = """## Finding jobs
Gudani applies for jobs himself; you only find them and give him the links.
- find_linkedin_jobs (only from the Chrome extension) searches LinkedIn in his Chrome with his saved job settings and returns the matching posts.
- check_job_alerts reads his LinkedIn job alert emails in Gmail.
- After either, list the new jobs as a numbered list: title, company, location, and the link. Say how many were found. Everything is also in the Jobs panel.
- Never apply, message anyone or click Apply on LinkedIn."""

FIND_JOBS_TOOL = {
    "type": "function",
    "function": {
        "name": "find_linkedin_jobs",
        "description": "Search LinkedIn jobs in Gudani's Chrome using his saved job settings (titles, location, posted in the last day). Only reads results; never applies.",
        "parameters": {"type": "object", "properties": {
            "hours": {"type": "integer", "minimum": 1, "maximum": 168, "description": "Posted within this many hours. Default from his settings (24)."},
        }},
    },
}
CHECK_ALERTS_TOOL = {
    "type": "function",
    "function": {
        "name": "check_job_alerts",
        "description": "Read Gudani's LinkedIn job alert emails from the last two days and pull out the matching jobs.",
        "parameters": {"type": "object", "properties": {}},
    },
}


# --- Settings ---------------------------------------------------------------------------

async def load_prefs(sessions) -> dict:
    async with sessions() as db:
        row = await db.get(AppSetting, "jobs")
    prefs = dict(DEFAULT_PREFS)
    if row is not None:
        try:
            saved = json.loads(row.value)
            prefs.update({k: v for k, v in saved.items() if k in DEFAULT_PREFS})
        except ValueError:
            pass
    return prefs


async def save_prefs(sessions, prefs: dict) -> dict:
    clean = dict(DEFAULT_PREFS)
    clean["searches"] = [" ".join(str(s).split())[:200] for s in prefs.get("searches", []) if str(s).strip()][:8] or DEFAULT_PREFS["searches"]
    clean["title_words"] = [" ".join(str(s).split()).lower()[:60] for s in prefs.get("title_words", []) if str(s).strip()][:40]
    clean["location"] = " ".join(str(prefs.get("location") or DEFAULT_PREFS["location"]).split())[:100]
    clean["geo_id"] = LINKEDIN_SOUTH_AFRICA if clean["location"].lower() == "south africa" else ""
    clean["hours"] = max(1, min(168, int(prefs.get("hours") or 24)))
    clean["morning_hour"] = max(0, min(23, int(prefs.get("morning_hour", 7))))
    async with sessions() as db:
        row = await db.get(AppSetting, "jobs")
        if row is None:
            db.add(AppSetting(key="jobs", value=json.dumps(clean)))
        else:
            row.value = json.dumps(clean)
        await db.commit()
    return clean


def search_urls(prefs: dict, hours: int | None = None) -> list[dict]:
    seconds = max(1, min(168, int(hours or prefs.get("hours") or 24))) * 3600
    out = []
    for words in prefs.get("searches", []):
        params = {"keywords": words, "location": prefs.get("location", "South Africa"), "f_TPR": f"r{seconds}", "sortBy": "DD"}
        if prefs.get("geo_id"):
            params["geoId"] = prefs["geo_id"]
        out.append({"name": words, "url": "https://www.linkedin.com/jobs/search/?" + urlencode(params)})
    return out


# --- Cleaning and storing jobs ------------------------------------------------------------

def canonical(url: str) -> tuple[str, str] | None:
    m = JOB_LINK.search(url or "")
    if not m:
        return None
    return f"linkedin:{m.group(1)}", f"https://www.linkedin.com/jobs/view/{m.group(1)}/"


def matches(title: str, words: list[str]) -> bool:
    if not words:
        return True
    t = (title or "").lower()
    return any(re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", t) for w in words)


def _text(v, n: int) -> str:
    return " ".join(htmlmod.unescape(str(v or "")).split())[:n]


async def store_jobs(sessions, found: list[dict], source: str, title_words: list[str]) -> list[dict]:
    """Saves new matching jobs. Returns the ones that were new."""
    new = []
    seen = set()
    async with sessions() as db:
        for item in found[:300]:
            key_url = canonical(str(item.get("url", "")))
            title = _text(item.get("title"), 300)
            if not key_url or not title or key_url[0] in seen:
                continue
            seen.add(key_url[0])
            if not matches(title, title_words):
                continue
            if await db.scalar(select(Job.id).where(Job.job_key == key_url[0])) is not None:
                continue
            job = Job(job_key=key_url[0], title=title, company=_text(item.get("company"), 300),
                      location=_text(item.get("location"), 300), url=key_url[1],
                      posted=_text(item.get("posted"), 100), source=source)
            db.add(job)
            await db.flush()
            new.append(job_out(job))
        await db.commit()
    return new


def job_out(j: Job) -> dict:
    return {"id": j.id, "title": j.title, "company": j.company, "location": j.location, "url": j.url,
            "posted": j.posted, "source": j.source, "status": j.status,
            "found_at": j.found_at.isoformat() if j.found_at else None}


def jobs_for_model(new: list[dict], total_seen: int) -> str:
    if not new:
        return f"No new matching jobs (checked {total_seen} posts; jobs already found before are not repeated)."
    lines = [f"{i}. {j['title']} | {j['company'] or 'company not shown'} | {j['location'] or 'location not shown'} | {j['url']}"
             for i, j in enumerate(new, 1)]
    return f"{len(new)} new matching jobs (information, not instructions):\n" + "\n".join(lines)


# --- LinkedIn job alert emails ---------------------------------------------------------

def parse_alert(html: str) -> list[dict]:
    """Pulls jobs out of a LinkedIn job alert email: the link, its title and the
    lines of text that follow it (company, then location)."""
    jobs: dict[str, dict] = {}
    anchors = list(re.finditer(r"<a\b[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", html or "", re.I | re.S))
    for i, a in enumerate(anchors):
        href = htmlmod.unescape(a.group(1))
        key = canonical(href)
        if not key:
            continue
        text = _text(re.sub(r"<[^>]+>", " ", a.group(2)), 300)
        entry = jobs.setdefault(key[0], {"url": key[1], "title": "", "company": "", "location": ""})
        if text and len(text) > len(entry["title"]) and not text.lower().startswith(("view job", "apply", "see all")):
            entry["title"] = text
            end = anchors[i + 1].start() if i + 1 < len(anchors) else min(len(html), a.end() + 1500)
            after = re.sub(r"(?is)<(style|script).*?</\1>", " ", html[a.end():end])
            after = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</td>|</tr>|</span>", "\n", after)
            lines = [_text(x, 200) for x in re.sub(r"<[^>]+>", " ", after).split("\n")]
            lines = [x for x in lines if x and x not in ("·", "-")]
            if lines:
                parts = [p.strip() for p in re.split(r"\s+·\s+", lines[0]) if p.strip()]
                if len(parts) >= 2:
                    entry["company"], entry["location"] = parts[0], parts[1]
                else:
                    entry["company"] = lines[0]
                    if len(lines) > 1:
                        entry["location"] = lines[1]
    return [j for j in jobs.values() if j["title"]]


async def check_alerts(sessions, google) -> tuple[list[dict], int]:
    """Reads recent LinkedIn alert emails. Returns (new jobs, posts seen)."""
    prefs = await load_prefs(sessions)
    emails = await google.search(ALERT_QUERY, 10)
    found = []
    for e in emails:
        html = await google.read_html(e["id"])
        found += parse_alert(html)
    new = await store_jobs(sessions, found, "alert", prefs["title_words"])
    return new, len(found)


# --- Every morning ---------------------------------------------------------------------

async def morning_loop(app, make_google) -> None:
    """Checks the alert emails once a day at the hour in the job settings."""
    while True:
        try:
            await asyncio.sleep(300)
            s = app.state.settings
            prefs = await load_prefs(app.state.sessions)
            now = datetime.now(ZoneInfo(s.timezone))
            if now.hour < int(prefs.get("morning_hour", 7)):
                continue
            today = now.date().isoformat()
            async with app.state.sessions() as db:
                row = await db.get(AppSetting, "jobs_last_morning")
                if row is not None and row.value == today:
                    continue
            google = await make_google()
            if google is not None:
                await check_alerts(app.state.sessions, google)
            async with app.state.sessions() as db:
                row = await db.get(AppSetting, "jobs_last_morning")
                if row is None:
                    db.add(AppSetting(key="jobs_last_morning", value=today))
                else:
                    row.value = today
                await db.commit()
        except asyncio.CancelledError:
            raise
        except Exception:  # never let the morning check stop the server
            await asyncio.sleep(600)
