"use strict";

/* Ocean side panel. Talks to your Ocean server with this browser's device
   token, reads the page you are on, and carries out page actions Ocean asks
   for, asking you first before anything that sends, saves, pays or deletes. */

const $ = (id) => document.getElementById(id);

const state = {
  server: "",
  token: "",
  conv: null, // { id, title, messages }
  busy: false,
  runId: null,
  stop: false,
  usePage: true,
  canAct: false,
  elements: new Map(), // latest snapshot: element id -> element
};

/* --- Storage ------------------------------------------------------------- */

const local = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
  remove: (keys) => chrome.storage.local.remove(keys),
};

/* --- API ----------------------------------------------------------------- */

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(state.server + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (_) {
    throw new ApiError(0, "Ocean could not be reached. Check your connection.");
  }
  if (response.status === 204) return null;
  let data = null;
  try { data = await response.json(); } catch (_) { /* no body */ }
  if (!response.ok) {
    let detail = data && data.detail;
    if (Array.isArray(detail)) detail = "That could not be sent. It may be empty or too long.";
    if (response.status === 401 && auth) {
      await local.remove(["token"]);
      state.token = "";
      showConnect(detail || "This browser is no longer connected. Connect it again.");
    }
    throw new ApiError(response.status, detail || `Request failed (status ${response.status}).`);
  }
  return data;
}

/* --- Helpers --------------------------------------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let statusTimer = null;
function setStatus(text) {
  $("status").textContent = text || "";
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { $("status").textContent = ""; }, 9000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scrollDown() { const s = $("scroller"); s.scrollTop = s.scrollHeight; }

function autosize() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, window.innerHeight * 0.3)}px`;
}

async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); button.lastChild.textContent = "Copied"; }
  catch (_) { button.lastChild.textContent = "Copy failed"; }
  setTimeout(() => { button.lastChild.textContent = "Copy"; }, 1500);
}

function copyButton(text) {
  const b = el("button", "tool");
  b.type = "button";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [k, v] of Object.entries({ x: 8.5, y: 8.5, width: 11, height: 11, rx: 2.5 })) r.setAttribute(k, v);
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5");
  svg.append(r, p);
  b.append(svg, el("span", "", "Copy"));
  b.addEventListener("click", () => copyText(text, b));
  return b;
}

/* --- Markdown (same rules as the web app) ------------------------------------ */

let markedReady = false;
function renderMarkdown(text) {
  const box = el("div", "md");
  if (!window.marked || !window.DOMPurify) { box.style.whiteSpace = "pre-wrap"; box.textContent = text; return box; }
  if (!markedReady) {
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    window.marked.use({ gfm: true, breaks: false, renderer: { html(token) { return esc(token.text); } } });
    markedReady = true;
  }
  const fragment = window.DOMPurify.sanitize(window.marked.parse(text), {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "img", "iframe", "svg", "math"],
    FORBID_ATTR: ["style", "id", "name"],
  });
  box.appendChild(fragment);
  const langs = new Map();
  for (const pre of box.querySelectorAll("pre")) {
    const m = /language-([\w+#.-]+)/.exec(pre.querySelector("code")?.className || "");
    langs.set(pre, m ? m[1].slice(0, 30) : "code");
  }
  for (const n of box.querySelectorAll("[class]")) n.removeAttribute("class");
  for (const pre of [...box.querySelectorAll("pre")]) {
    const source = pre.textContent.replace(/\n$/, "");
    const block = el("div", "codeblock");
    const head = el("div", "code-head");
    head.append(el("span", "", langs.get(pre)), copyButton(source));
    const p = document.createElement("pre");
    const c = document.createElement("code");
    c.textContent = source;
    p.appendChild(c);
    block.append(head, p);
    pre.replaceWith(block);
  }
  for (const t of [...box.querySelectorAll("table")]) {
    const w = el("div", "table-wrap");
    t.replaceWith(w);
    w.appendChild(t);
  }
  for (const a of box.querySelectorAll("a")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  return box;
}

/* --- Rendering ----------------------------------------------------------------- */

function renderUser(m) {
  const wrap = el("div", "msg msg-user");
  const page = (m.steps || []).find((s) => s.type === "page");
  if (page) wrap.appendChild(el("div", "page-ref", `On: ${page.title || page.url}`));
  wrap.appendChild(el("div", "bubble", m.content));
  return wrap;
}

function renderBot(m) {
  const wrap = el("div", "msg msg-bot");
  const actions = (m.steps || []).filter((s) => s.type === "action");
  if (actions.length) {
    const box = el("div", "actions-log");
    const list = el("ul");
    for (const a of actions) {
      const li = el("li", a.ok === false ? "bad" : "", a.summary + (a.ok === false ? " (not done)" : ""));
      list.appendChild(li);
    }
    box.append(el("div", "", `Did ${actions.length} ${actions.length === 1 ? "step" : "steps"} on the page`), list);
    wrap.appendChild(box);
  }
  const searches = (m.steps || []).filter((s) => s.type === "search" || s.type === "read").length;
  if (searches) wrap.appendChild(el("div", "actions-log", `${searches} web ${searches === 1 ? "lookup" : "lookups"}`));
  wrap.appendChild(renderMarkdown(m.content || ""));
  const tools = el("div", "tools");
  tools.appendChild(copyButton(m.content || ""));
  wrap.appendChild(tools);
  return wrap;
}

function renderAll() {
  const box = $("messages");
  box.replaceChildren();
  const msgs = state.conv ? state.conv.messages : [];
  for (const m of msgs) box.appendChild(m.role === "user" ? renderUser(m) : renderBot(m));
  $("empty").hidden = msgs.length > 0 || state.busy;
  $("title").textContent = state.conv ? state.conv.title : "Ocean";
  scrollDown();
}

/* --- The page ------------------------------------------------------------------ */

// For automated tests the panel can be opened as a page with ?tab=<id>.
const TEST_TAB = Number(new URLSearchParams(location.search).get("tab")) || null;

async function activeTab() {
  if (TEST_TAB) { try { return await chrome.tabs.get(TEST_TAB); } catch (_) { return null; } }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function readable(tab) {
  return tab && /^https?:\/\//.test(tab.url || "") && !/^https:\/\/chromewebstore\.google\.com/.test(tab.url);
}

async function snapshot(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: oceanSnapshot });
    const page = res && res.result;
    if (page) state.elements = new Map(page.elements.map((e) => [e.id, e]));
    return page || null;
  } catch (_) {
    return null;
  }
}

async function updatePageChip() {
  const tab = await activeTab();
  const show = state.usePage && tab;
  $("page-chip").hidden = !show;
  if (show) $("page-name").textContent = readable(tab) ? (tab.title || tab.url) : "Ocean cannot read this kind of page";
}

async function waitForLoad(tabId, timeout = 15000) {
  const start = Date.now();
  await sleep(400);
  while (Date.now() - start < timeout) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") break;
    } catch (_) { break; }
    await sleep(250);
  }
  await sleep(600);
}

/* --- Approval for risky steps ----------------------------------------------------- */

const RISKY = /submit|send|pay\b|payment|buy|purchase|order|checkout|check out|delete|remove|discard|post\b|publish|confirm|apply|sign in|log ?in|sign up|register|subscribe|unsubscribe|transfer|book now|donate|place|save|accept|agree|invite|share/i;

function describe(action) {
  const a = action.arguments || {};
  const e = state.elements.get(Number(a.element));
  const label = e ? (e.label || e.href || `${e.tag} ${e.id}`) : `element ${a.element}`;
  switch (action.name) {
    case "click": return `Click "${label.slice(0, 80)}"${a.why ? ` (${String(a.why).slice(0, 80)})` : ""}`;
    case "type_text": return `Type into "${label.slice(0, 60)}"${a.press_enter ? " and press Enter" : ""}`;
    case "fill_form": return `Fill ${(a.fields || []).length} field(s)`;
    case "select_option": return `Choose "${String(a.option || "").slice(0, 60)}" in "${label.slice(0, 60)}"`;
    case "scroll": return `Scroll ${a.direction || ""}`;
    case "open_url": return `Open ${String(a.url || "").slice(0, 100)}`;
    case "read_page": return "Read the page again";
    default: return action.name;
  }
}

function needsApproval(action) {
  const a = action.arguments || {};
  const e = state.elements.get(Number(a.element));
  if (action.name === "click") {
    if (!e) return true;
    const text = `${e.label || ""} ${e.type || ""}`;
    return e.type === "submit" || RISKY.test(text);
  }
  if (action.name === "type_text" && a.press_enter) {
    const search = e && (e.type === "search" || /search|find|filter/i.test(e.label || ""));
    return !search;
  }
  return false;
}

function askApproval(liveBox, action) {
  return new Promise((resolve) => {
    const card = el("div", "approve");
    card.appendChild(el("p", "", `Ocean wants to: ${describe(action)}. Is that okay?`));
    const row = el("div", "row");
    const yes = el("button", "btn small", "Allow");
    const no = el("button", "btn small ghost", "Skip");
    yes.type = no.type = "button";
    yes.addEventListener("click", () => { card.remove(); resolve(true); });
    no.addEventListener("click", () => { card.remove(); resolve(false); });
    row.append(yes, no);
    card.appendChild(row);
    liveBox.appendChild(card);
    scrollDown();
    yes.focus();
  });
}

/* --- Carrying out actions --------------------------------------------------------- */

async function runAction(tabId, action) {
  if (action.name === "open_url") {
    const url = String((action.arguments || {}).url || "");
    if (!/^https?:\/\//i.test(url)) return { ok: false, message: "Only http and https addresses can be opened." };
    await chrome.tabs.update(tabId, { url });
    await waitForLoad(tabId);
    return { ok: true, message: "Opened." };
  }
  let result;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: oceanAct, args: [action] });
    result = res && res.result;
  } catch (err) {
    // A click that leaves the page can end the script before it reports back.
    result = { ok: true, message: "Done (the page changed).", navigates: true };
  }
  if (!result) result = { ok: true, message: "Done (the page changed).", navigates: true };
  if (result.navigates) await waitForLoad(tabId);
  else await sleep(700);
  return { ok: !!result.ok, message: String(result.message || "").slice(0, 1900) };
}

/* --- Sending ------------------------------------------------------------------------ */

function liveRow() {
  const wrap = el("div", "msg msg-bot");
  const box = el("div", "live");
  const now = el("div", "now");
  const dots = el("span", "dots");
  dots.append(el("i"), el("i"), el("i"));
  const label = el("span", "", "Thinking");
  now.append(dots, label);
  const list = el("ul");
  box.append(now, list);
  wrap.appendChild(box);
  return { wrap, box, label, list };
}

function setBusy(busy) {
  state.busy = busy;
  $("send").hidden = busy;
  $("stop").hidden = !busy;
  $("input").disabled = false;
}

async function send(text) {
  if (state.busy) return;
  setBusy(true);
  setStatus("");
  state.stop = false;
  const tab = await activeTab();
  let page = null;
  if (state.usePage && tab) {
    if (readable(tab)) {
      page = await snapshot(tab.id);
      if (!page) setStatus("Ocean could not read this page, so it was not sent.");
    } else {
      setStatus("Ocean cannot read this kind of page, so it was not sent.");
    }
  }
  const act = state.canAct && !!page;

  $("empty").hidden = true;
  const box = $("messages");
  box.appendChild(renderUser({ content: text, steps: page ? [{ type: "page", title: page.title, url: page.url }] : [] }));
  const live = liveRow();
  live.label.textContent = page ? (act ? "Reading the page" : "Reading the page") : "Thinking";
  box.appendChild(live.wrap);
  scrollDown();

  try {
    if (!state.conv) {
      const c = await api("/api/conversations", { method: "POST", body: {} });
      state.conv = { ...c, messages: [] };
      await local.set({ convId: c.id });
    }
    let result = await api(`/api/conversations/${state.conv.id}/messages`, {
      method: "POST",
      body: { content: text, page: page || undefined, browser: act },
    });
    $("input").value = "";
    autosize();

    while (result.status === "actions") {
      state.runId = result.run_id;
      const results = [];
      let latest = null;
      for (const action of result.actions) {
        if (state.stop) break;
        const line = el("li", "", describe(action));
        live.list.appendChild(line);
        live.label.textContent = "Working on the page";
        scrollDown();
        if (needsApproval(action)) {
          live.label.textContent = "Waiting for you";
          const ok = await askApproval(live.box, action);
          if (!ok) {
            line.className = "bad";
            line.textContent += " (you skipped it)";
            results.push({ id: action.id, ok: false, message: "Gudani said no to this step. Do not try it again; tell him what is left." });
            continue;
          }
        }
        const done = await runAction(tab.id, action);
        if (!done.ok) { line.className = "bad"; line.textContent += ` (${done.message})`; }
        results.push({ id: action.id, ...done });
      }
      if (state.stop) {
        await api(`/api/runs/${state.runId}`, { method: "DELETE" }).catch(() => {});
        state.runId = null;
        live.wrap.remove();
        setStatus("Stopped. Nothing from this task was saved to the chat.");
        renderAll();
        return;
      }
      latest = await snapshot(tab.id);
      if (results.length && latest) results[results.length - 1].page = latest;
      live.label.textContent = "Thinking";
      result = await api(`/api/runs/${state.runId}/continue`, { method: "POST", body: { results } });
    }
    state.runId = null;
    state.conv.title = result.conversation.title;
    state.conv.messages.push(...result.messages);
    live.wrap.remove();
    renderAll();
  } catch (err) {
    live.wrap.remove();
    const e = el("div", "msg msg-error", `${err.message} Your message is still in the box.`);
    box.appendChild(e);
    scrollDown();
  } finally {
    setBusy(false);
  }
}

/* --- Chats -------------------------------------------------------------------------- */

async function openConversation(id) {
  try {
    const c = await api(`/api/conversations/${id}`);
    state.conv = c;
    await local.set({ convId: c.id });
  } catch (err) {
    state.conv = null;
    if (err.status !== 401) setStatus(err.status === 404 ? "" : err.message);
  }
  $("history").hidden = true;
  renderAll();
}

async function newChat() {
  if (state.busy) return;
  state.conv = null;
  await local.remove(["convId"]);
  $("history").hidden = true;
  renderAll();
  $("input").focus();
}

async function toggleHistory() {
  const box = $("history");
  if (!box.hidden) { box.hidden = true; return; }
  box.replaceChildren(el("p", "", "Loading..."));
  box.hidden = false;
  try {
    const rows = await api("/api/conversations");
    box.replaceChildren();
    if (!rows.length) box.appendChild(el("p", "", "No chats yet."));
    for (const c of rows.slice(0, 40)) {
      const b = el("button", "", c.title);
      b.type = "button";
      b.title = c.title;
      if (state.conv && state.conv.id === c.id) b.setAttribute("aria-current", "true");
      b.addEventListener("click", () => openConversation(c.id));
      box.appendChild(b);
    }
  } catch (err) {
    box.replaceChildren(el("p", "", err.message));
  }
}

/* --- Connect --------------------------------------------------------------------- */

function showConnect(message) {
  $("chat").hidden = true;
  $("connect").hidden = false;
  const e = $("connect-error");
  e.hidden = !message;
  e.textContent = message || "";
  if (state.server) $("server").value = state.server;
  $("code").value = "";
  $("code").focus();
}

async function showChat() {
  $("connect").hidden = true;
  $("chat").hidden = false;
  const { convId } = await local.get(["convId"]);
  if (convId) await openConversation(convId);
  else renderAll();
  updatePageChip();
  takeSelection();
  $("input").focus();
}

async function connect(e) {
  e.preventDefault();
  const server = $("server").value.trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(server)) {
    showConnect("The address must start with https://");
    return;
  }
  state.server = server;
  try {
    const r = await api("/api/devices/connect", {
      method: "POST",
      auth: false,
      body: { code: $("code").value.trim(), name: "Chrome extension" },
    });
    state.token = r.token;
    await local.set({ server, token: r.token });
    showChat();
  } catch (err) {
    showConnect(err.message);
  }
}

async function disconnect() {
  $("menu").hidden = true;
  await local.remove(["token", "convId"]);
  state.token = "";
  state.conv = null;
  showConnect("Disconnected. Remove \"Chrome extension\" in Ocean's Settings to cancel its access completely.");
}

/* --- Selection from the right-click menu ------------------------------------------ */

async function takeSelection() {
  const { pendingSelection } = await chrome.storage.session.get(["pendingSelection"]);
  if (!pendingSelection) return;
  await chrome.storage.session.remove(["pendingSelection"]);
  const input = $("input");
  input.value = `About this: "${pendingSelection}"\n\n`;
  autosize();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/* --- Start --------------------------------------------------------------------------- */

const STARTERS = [
  { text: "Summarise this page", act: false },
  { text: "What are the key facts and prices on this page?", act: false },
  { text: "Help me fill in this form", act: true },
  { text: "Find the contact details on this page", act: false },
];

function setToggle(id, on) {
  $(id).setAttribute("aria-pressed", String(on));
}

async function start() {
  const saved = await local.get(["server", "token", "usePage", "canAct"]);
  state.server = saved.server || "";
  // Ocean moved to its own address; carry an existing connection across.
  if (state.server === "https://ocean-production-7b44bbf1.up.railway.app") {
    state.server = "https://ocean.digivireo.com";
    await local.set({ server: state.server });
  }
  state.token = saved.token || "";
  state.usePage = saved.usePage !== false;
  state.canAct = saved.canAct === true;
  setToggle("use-page", state.usePage);
  setToggle("can-act", state.canAct);

  const starters = $("starters");
  for (const s of STARTERS) {
    const b = el("button", "", s.text);
    b.type = "button";
    b.addEventListener("click", async () => {
      if (s.act && !state.canAct) {
        state.canAct = true;
        setToggle("can-act", true);
        await local.set({ canAct: true });
      }
      send(s.text);
    });
    starters.appendChild(b);
  }

  $("connect-form").addEventListener("submit", connect);
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("input").value.trim();
    if (text) send(text);
  });
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("input").addEventListener("input", autosize);
  $("stop").addEventListener("click", () => { state.stop = true; setStatus("Stopping after this step..."); });
  $("use-page").addEventListener("click", async () => {
    state.usePage = !state.usePage;
    setToggle("use-page", state.usePage);
    if (!state.usePage && state.canAct) { state.canAct = false; setToggle("can-act", false); }
    await local.set({ usePage: state.usePage, canAct: state.canAct });
    updatePageChip();
  });
  $("can-act").addEventListener("click", async () => {
    state.canAct = !state.canAct;
    setToggle("can-act", state.canAct);
    if (state.canAct && !state.usePage) { state.usePage = true; setToggle("use-page", true); }
    await local.set({ usePage: state.usePage, canAct: state.canAct });
    setStatus(state.canAct ? "Ocean can now click, type and fill forms. It asks you before anything that sends, saves, pays or deletes." : "Ocean will only read the page.");
    updatePageChip();
  });
  $("new-btn").addEventListener("click", newChat);
  $("history-btn").addEventListener("click", toggleHistory);
  $("menu-btn").addEventListener("click", (e) => { e.stopPropagation(); $("menu").hidden = !$("menu").hidden; });
  document.addEventListener("click", (e) => { if (!$("menu").contains(e.target)) $("menu").hidden = true; });
  $("open-web").addEventListener("click", () => { $("menu").hidden = true; chrome.tabs.create({ url: state.server }); });
  $("disconnect").addEventListener("click", disconnect);

  chrome.tabs.onActivated.addListener(updatePageChip);
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.title || info.status === "complete") updatePageChip(); });
  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "selection-ready") takeSelection(); });

  if (state.token && state.server) showChat();
  else showConnect("");
}

start();
