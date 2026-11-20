"use strict";

/* Finding LinkedIn jobs for Gudani. Ocean only reads job posts and collects
   their links; it never applies, messages or clicks anything on LinkedIn.

   1. First it reads LinkedIn's public job listings (the same results anyone
      sees without signing in), without sending Gudani's LinkedIn cookies.
   2. If that does not work, it opens the search in a background tab of his
      Chrome, reads the result cards and closes the tab.
   Searches are spaced out with pauses, and there are at most two pages each. */

const JOB_VIEW = /linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i;

function jobKeyFromUrl(url) {
  const m = JOB_VIEW.exec(String(url || ""));
  return m ? m[1] : null;
}

function clean(text, n = 300) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, n);
}

// LinkedIn's public listing, as HTML cards.
function guestUrl(searchUrl, start) {
  const u = new URL(searchUrl);
  const g = new URL("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search");
  for (const [k, v] of u.searchParams) g.searchParams.set(k, v);
  g.searchParams.set("start", String(start));
  return g.toString();
}

function parseGuestCards(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = [];
  for (const card of doc.querySelectorAll("li, div.base-card")) {
    const link = card.querySelector("a[href*='/jobs/view/']");
    if (!link) continue;
    const id = jobKeyFromUrl(link.getAttribute("href"));
    if (!id) continue;
    const title = clean((card.querySelector(".base-search-card__title, h3") || link).textContent);
    const company = clean((card.querySelector(".base-search-card__subtitle, h4") || {}).textContent);
    const location = clean((card.querySelector(".job-search-card__location") || {}).textContent);
    const time = card.querySelector("time");
    const posted = clean(time ? (time.textContent || time.getAttribute("datetime")) : "", 100);
    out.push({ url: `https://www.linkedin.com/jobs/view/${id}/`, title, company, location, posted });
  }
  return out;
}

// Runs inside the LinkedIn tab: scroll the results list and read the cards.
async function oceanJobCards() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const signedOut = /\/(login|authwall|checkpoint)/.test(location.pathname);
  if (signedOut) return { signedOut: true, jobs: [] };
  const anchors = () => [...document.querySelectorAll("a[href*='/jobs/view/']")];
  let list = null;
  const first = anchors()[0];
  for (let p = first; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 50) { list = p; break; }
  }
  for (let i = 0; i < 8; i++) {
    const before = anchors().length;
    if (list) list.scrollBy(0, list.clientHeight * 0.9); else window.scrollBy(0, innerHeight * 0.9);
    await wait(700);
    if (i > 2 && anchors().length === before) break;
  }
  const jobs = new Map();
  for (const a of anchors()) {
    const m = /\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/.exec(a.href);
    if (!m) continue;
    const card = a.closest("li") || a.closest("[data-job-id]") || a.parentElement;
    const lines = (card ? card.innerText : a.innerText).split("\n").map((x) => x.trim()).filter(Boolean);
    const title = (a.getAttribute("aria-label") || a.innerText || lines[0] || "").split("\n")[0].trim();
    const rest = lines.filter((x) => x !== title && !/^(promoted|easy apply|viewed|be an early applicant|actively reviewing)/i.test(x));
    const time = card && card.querySelector("time");
    const prev = jobs.get(m[1]);
    if (prev && prev.title.length >= title.length) continue;
    jobs.set(m[1], {
      url: `https://www.linkedin.com/jobs/view/${m[1]}/`,
      title: title.slice(0, 300),
      company: (rest[0] || "").slice(0, 300),
      location: (rest[1] || "").slice(0, 300),
      posted: time ? (time.innerText || time.getAttribute("datetime") || "").trim().slice(0, 100) : "",
    });
  }
  return { signedOut: false, jobs: [...jobs.values()] };
}

async function jobsFromGuest(search, progress) {
  const found = [];
  for (let page = 0; page < 2; page++) {
    progress(`Reading LinkedIn jobs: ${search.name}${page ? " (more)" : ""}`);
    const res = await fetch(guestUrl(search.url, page * 25), { credentials: "omit", cache: "no-store" });
    if (res.status === 429) throw new Error("LinkedIn asked Ocean to slow down.");
    if (!res.ok) throw new Error(`LinkedIn answered with status ${res.status}.`);
    const cards = parseGuestCards(await res.text());
    found.push(...cards);
    if (cards.length < 10) break;
    await sleep(2500 + Math.random() * 2500);
  }
  return found;
}

async function jobsFromTab(tabId, search, progress) {
  const found = [];
  for (let page = 0; page < 2; page++) {
    progress(`Searching LinkedIn in a background tab: ${search.name}${page ? " (page 2)" : ""}`);
    await chrome.tabs.update(tabId, { url: page ? `${search.url}&start=${page * 25}` : search.url });
    await waitForLoad(tabId, 20000);
    await sleep(2500 + Math.random() * 2000);
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: oceanJobCards });
    const r = (res && res.result) || { jobs: [] };
    if (r.signedOut) throw new Error("LinkedIn wants you to sign in first. Sign in to LinkedIn in Chrome, then ask again.");
    found.push(...r.jobs);
    if (r.jobs.length < 20) break;
  }
  return found;
}

async function findLinkedInJobs(args, progress) {
  const searches = (Array.isArray(args.searches) ? args.searches : [])
    .filter((s) => s && /^https:\/\/www\.linkedin\.com\/jobs\/search\//.test(String(s.url || "")))
    .slice(0, 8);
  if (!searches.length) return { ok: false, message: "There were no LinkedIn searches to run. Check the job settings in Ocean." };
  const all = [];
  const notes = [];
  let tab = null;
  try {
    for (const [i, search] of searches.entries()) {
      if (state.stop) break;
      if (i) await sleep(3000 + Math.random() * 3000);
      let got = [];
      try {
        got = await jobsFromGuest(search, progress);
      } catch (err) {
        notes.push(`Public listing for "${search.name}": ${err.message}`);
      }
      if (!got.length) {
        try {
          if (!tab) tab = await chrome.tabs.create({ url: "about:blank", active: false });
          got = await jobsFromTab(tab.id, search, progress);
        } catch (err) {
          notes.push(`"${search.name}": ${err.message}`);
          if (/sign in/i.test(err.message)) break;
        }
      }
      all.push(...got);
    }
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
  const unique = new Map();
  for (const j of all) {
    const id = jobKeyFromUrl(j.url);
    if (id && !unique.has(id)) unique.set(id, j);
  }
  const jobs = [...unique.values()].slice(0, 300);
  const message = `Ran ${searches.length} LinkedIn searches and saw ${jobs.length} different posts.` + (notes.length ? ` Notes: ${notes.join(" ")}` : "");
  return { ok: jobs.length > 0 || !notes.length, message: message.slice(0, 1900), report: { kind: "linkedin_jobs", jobs } };
}
