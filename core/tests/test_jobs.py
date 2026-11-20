"""Tests for finding LinkedIn jobs: settings, the Chrome search hand-off, alert
emails, filtering, de-duplication and the Jobs panel API."""

import base64
import json
from urllib.parse import parse_qs, urlparse

import httpx

from ocean_core.jobs import DEFAULT_PREFS, canonical, matches, parse_alert, search_urls
from test_core import AUTH, client_for
from test_google import FakeGoogle, chat, connect, gsettings
from test_tools import Scripted, answer, call, tool_settings

ALERT_HTML = """
<table><tr><td>
<a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc&amp;refId=x"><img alt="logo"></a>
<a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc">Shopify Developer</a>
<p>Bloom Digital · Cape Town, Western Cape, South Africa (Remote)</p>
</td></tr><tr><td>
<a href="https://www.linkedin.com/comm/jobs/view/4099999999/?trackingId=def">Klaviyo Email Marketing Specialist</a>
<div>Acme Retail</div><div>Johannesburg, Gauteng</div>
</td></tr><tr><td>
<a href="https://www.linkedin.com/comm/jobs/view/4011111111/">Senior Accountant</a>
<p>Numbers Inc · Durban</p>
</td></tr></table>
<a href="https://www.linkedin.com/comm/jobs/search?keywords=shopify">See all jobs</a>
"""


def b64(text):
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def test_parse_alert_email():
    jobs = parse_alert(ALERT_HTML)
    assert [(j["title"], j["company"], j["location"]) for j in jobs] == [
        ("Shopify Developer", "Bloom Digital", "Cape Town, Western Cape, South Africa (Remote)"),
        ("Klaviyo Email Marketing Specialist", "Acme Retail", "Johannesburg, Gauteng"),
        ("Senior Accountant", "Numbers Inc", "Durban"),
    ]
    assert jobs[0]["url"] == "https://www.linkedin.com/jobs/view/4012345678/"


def test_title_matching_and_links():
    words = DEFAULT_PREFS["title_words"]
    assert matches("Shopify Developer", words) and matches("E-commerce Manager", words)
    assert matches("CRO Specialist", words) and not matches("Senior Accountant", words)
    assert not matches("Microsoft Dynamics CRM Consultant (macro)", ["cro"])
    assert canonical("https://za.linkedin.com/jobs/view/shopify-dev-at-x-4012345678?trk=1") == (
        "linkedin:4012345678", "https://www.linkedin.com/jobs/view/4012345678/")
    links = search_urls(DEFAULT_PREFS)
    q = parse_qs(urlparse(links[0]["url"]).query)
    assert q["keywords"] == ["Shopify"] and q["f_TPR"] == ["r86400"] and q["geoId"] == ["104035573"]
    assert q["location"] == ["South Africa"]


def test_chrome_search_hands_searches_to_the_extension_and_stores_jobs():
    fake = Scripted([call("find_linkedin_jobs", {}), answer("Found 2 jobs for you, bru.")])
    with client_for(tool_settings(), fake) as c:
        cid = c.post("/api/conversations", json={}, headers=AUTH).json()["id"]
        r = c.post(f"/api/conversations/{cid}/messages", json={"content": "find me jobs", "linkedin": True}, headers=AUTH).json()
        assert r["status"] == "actions"
        action = r["actions"][0]
        assert action["name"] == "find_linkedin_jobs" and len(action["arguments"]["searches"]) == 4
        assert all(s["url"].startswith("https://www.linkedin.com/jobs/search/?") for s in action["arguments"]["searches"])
        report = {"kind": "linkedin_jobs", "jobs": [
            {"url": "https://www.linkedin.com/jobs/view/4012345678/", "title": "Shopify Developer", "company": "Bloom", "location": "Cape Town"},
            {"url": "https://www.linkedin.com/jobs/view/4012345678/", "title": "Shopify Developer", "company": "Bloom", "location": "Cape Town"},
            {"url": "https://www.linkedin.com/jobs/view/4055555555/", "title": "E-commerce Manager", "company": "Shop Co", "location": "Remote"},
            {"url": "https://www.linkedin.com/jobs/view/4066666666/", "title": "Payroll Clerk", "company": "X", "location": "Durban"},
        ]}
        done = c.post(f"/api/runs/{r['run_id']}/continue", headers=AUTH,
                      json={"results": [{"id": action["id"], "ok": True, "message": "Saw 3 posts.", "report": report}]}).json()
        step = done["messages"][1]["steps"][0]
        assert [j["title"] for j in step["jobs"]] == ["E-commerce Manager", "Shopify Developer"] or \
            sorted(j["title"] for j in step["jobs"]) == ["E-commerce Manager", "Shopify Developer"]
        assert "report" not in step or not step.get("report")
        listed = c.get("/api/jobs", headers=AUTH).json()
        assert listed["open"] == 2 and {j["title"] for j in listed["jobs"]} == {"Shopify Developer", "E-commerce Manager"}
        jid = listed["jobs"][0]["id"]
        assert c.patch(f"/api/jobs/{jid}", json={"status": "applied"}, headers=AUTH).json()["status"] == "applied"
        assert c.get("/api/jobs", headers=AUTH).json()["open"] == 1
        assert len(c.get("/api/jobs?show=applied", headers=AUTH).json()["jobs"]) == 1
    model_saw = [m for m in fake.chat_bodies()[1]["messages"] if m["role"] == "tool"][-1]["content"]
    assert "2 new matching jobs" in model_saw and "https://www.linkedin.com/jobs/view/4012345678/" in model_saw


def test_find_jobs_tool_only_from_the_extension():
    fake = Scripted([answer("hi")])
    with client_for(tool_settings(), fake) as c:
        cid = c.post("/api/conversations", json={}, headers=AUTH).json()["id"]
        c.post(f"/api/conversations/{cid}/messages", json={"content": "find me jobs"}, headers=AUTH)
    names = [t["function"]["name"] for t in fake.chat_bodies()[0].get("tools", [])]
    assert "find_linkedin_jobs" not in names


class FakeAlerts(FakeGoogle):
    def handler(self, request):
        if request.url.host == "gmail.googleapis.com":
            self.google.append(request)
            if request.url.path.endswith("/messages") and request.method == "GET":
                assert "jobalerts-noreply@linkedin.com" in request.url.params["q"]
                return httpx.Response(200, json={"messages": [{"id": "alert123"}]})
            if request.url.path.endswith("/messages/alert123"):
                headers = [{"name": "From", "value": "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>"},
                           {"name": "Subject", "value": "Shopify Developer: Bloom Digital and more"}]
                payload = {"headers": headers, "mimeType": "multipart/alternative", "parts": [
                    {"mimeType": "text/plain", "body": {"data": b64("plain")}},
                    {"mimeType": "text/html", "body": {"data": b64(ALERT_HTML)}}]}
                return httpx.Response(200, json={"id": "alert123", "threadId": "t", "snippet": "", "payload": payload})
        return super().handler(request)


def test_alert_emails_tool_and_check_now():
    fake = FakeAlerts([call("check_job_alerts", {}), answer("Two new ones.")])
    with client_for(gsettings(), fake) as c:
        connect(c)
        cid = chat(c)
        r = c.post(f"/api/conversations/{cid}/messages", json={"content": "any new jobs?"}, headers=AUTH).json()
        step = r["messages"][1]["steps"][0]
        assert step["type"] == "jobs" and step["seen"] == 3
        assert sorted(j["title"] for j in step["jobs"]) == ["Klaviyo Email Marketing Specialist", "Shopify Developer"]
        # Checking again finds nothing new: jobs are only stored once.
        again = c.post("/api/jobs/check-alerts", headers=AUTH).json()
        assert again["seen"] == 3 and again["new"] == []
    sys = "\n".join(m["content"] for m in fake.chat_bodies()[0]["messages"] if m["role"] == "system")
    assert "## Finding jobs" in sys


def test_job_settings_api():
    with client_for(tool_settings(), Scripted([])) as c:
        s = c.get("/api/jobs/settings", headers=AUTH).json()
        assert s["location"] == "South Africa" and len(s["links"]) == 4
        r = c.put("/api/jobs/settings", headers=AUTH, json={
            "searches": ["Shopify", "  Klaviyo  "], "title_words": ["Shopify", "Klaviyo"], "location": "South Africa",
            "hours": 48, "morning_hour": 6}).json()
        assert r["searches"] == ["Shopify", "Klaviyo"] and r["title_words"] == ["shopify", "klaviyo"]
        assert "f_TPR=r172800" in r["links"][0]["url"]
        assert c.post("/api/jobs/check-alerts", headers=AUTH).status_code == 409
        assert c.put("/api/jobs/settings", json={}).status_code == 401
