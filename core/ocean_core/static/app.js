"use strict";

/* Ocean chat screen. Talks only to this server's own API. */

const OLD_TOKEN_KEY = "ocean.token"; // from the old token sign-in; removed on load
const ROUTE_KEY = "ocean.route";
const COLLAPSED_KEY = "ocean.sidebarCollapsed";
const GAUGE_CIRCUMFERENCE = 87.96; // 2 * pi * 14
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_MS = 5 * 60 * 1000;

const $ = (id) => document.getElementById(id);

// Present only inside the Ocean Windows app.
const desktop = window.oceanDesktop || null;
let desktopInfo = null;

const state = {
  signedIn: false,
  username: "",
  pendingAccessToken: null, // held only during setup, never stored
  recoveryCodes: [],
  brains: null,
  conversations: [],
  query: "",
  current: null, // { id, title, private, messages: [] } or null for a new, unsaved chat
  newChatPrivate: true,
  mode: null, // "research", "image", "code" or null
  files: [], // { key, name, size, status: "uploading" | "ready" | "failed", id, kind, note, error }
  busy: false,
  editing: null, // id of the user message being edited
};

/* --- Storage (can fail in private windows, so always guarded) ------------- */

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (_) { /* ignore */ }
}
function load(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

/* --- API ------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, options = {}) {
  // The session cookie is sent automatically. This header proves the request
  // came from Ocean's own page, not another website.
  const headers = { "X-Requested-With": "ocean" };
  let body;
  if (options.form !== undefined) {
    body = options.form; // FormData: the browser sets the multipart header itself
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(path, { method: options.method || "GET", headers, body });
  } catch (_) {
    throw new ApiError(0, "Ocean could not be reached. Check your connection and try again.");
  }
  if (response.status === 401 && !options.allow401) {
    showSignIn("You have been signed out. Sign in again.");
    throw new ApiError(401, "Not signed in.");
  }
  if (response.status === 204) return null;
  let data = null;
  try { data = await response.json(); } catch (_) { /* no body */ }
  if (!response.ok) {
    let detail = data && data.detail;
    if (Array.isArray(detail)) detail = "That could not be sent. Check it is not empty or too long.";
    if (!detail && response.status === 413) detail = "That file is too big.";
    throw new ApiError(response.status, detail || `Request failed (status ${response.status}).`);
  }
  return data;
}

/* --- Small DOM helpers ------------------------------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  retry: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  sheet: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M4 9.5h16M4 15h16M10 4v16"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-9 8.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.7 5.4 3.7 8.5s-1.2 5.9-3.7 8.5c-2.5-2.6-3.7-5.4-3.7-8.5S9.5 6.1 12 3.5z"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  // ICONS is a fixed list in this file, never user or model text.
  svg.innerHTML = ICONS[name];
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toolButton(iconName, label, onClick, showLabel = false) {
  const b = el("button", "tool");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.appendChild(icon(iconName));
  if (showLabel) b.appendChild(el("span", "", label));
  b.addEventListener("click", onClick);
  return b;
}

async function copyText(text, button) {
  let ok = true;
  try { await navigator.clipboard.writeText(text); } catch (_) { ok = false; }
  if (!button) return ok;
  const label = button.querySelector("span");
  const before = label ? label.textContent : null;
  button.replaceChild(icon(ok ? "check" : "close"), button.querySelector("svg"));
  if (label) label.textContent = ok ? "Copied" : "Copy failed";
  setTimeout(() => {
    button.replaceChild(icon("copy"), button.querySelector("svg"));
    if (label) label.textContent = before;
  }, 1600);
  return ok;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* --- Markdown: parsed by marked, cleaned by DOMPurify ---------------------------- */

let markedReady = false;
function setupMarkdown() {
  if (markedReady || !window.marked || !window.DOMPurify) return;
  // Raw HTML in a reply is shown as text, not built into the page. For web work
  // that is what you want to see anyway, and DOMPurify below is a second guard.
  const escapeHtml = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  window.marked.use({
    gfm: true,
    breaks: false,
    renderer: { html(token) { return escapeHtml(token.text); } },
  });
  markedReady = true;
}

// Turns a reply into safe HTML. DOMPurify removes any script, event handler or
// unsafe link, so the model's text can never run code in Ocean.
function renderMarkdown(text) {
  setupMarkdown();
  const box = el("div", "md");
  if (!markedReady) {
    box.style.whiteSpace = "pre-wrap";
    box.textContent = text;
    return box;
  }
  const html = window.marked.parse(text);
  const fragment = window.DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "img", "iframe", "svg", "math"],
    FORBID_ATTR: ["style", "id", "name"],
  });
  box.appendChild(fragment);

  // Note each code block's language, then drop every class from the model's
  // text, so it cannot borrow the look of Ocean's own buttons.
  const langs = new Map();
  for (const pre of box.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    const match = code && /language-([\w+#.-]+)/.exec(code.className || "");
    langs.set(pre, match ? match[1].slice(0, 30) : "");
  }
  for (const node of box.querySelectorAll("[class]")) node.removeAttribute("class");

  // Code blocks: a header with the language and a copy button.
  for (const pre of [...box.querySelectorAll("pre")]) {
    const code = pre.querySelector("code");
    const lang = langs.get(pre) || "";
    const block = el("div", "codeblock");
    const head = el("div", "code-head");
    head.appendChild(el("span", "", lang || "code"));
    const source = code ? code.textContent : pre.textContent;
    head.appendChild(toolButton("copy", "Copy", (e) => copyText(source, e.currentTarget), true));
    const cleanPre = document.createElement("pre");
    const cleanCode = document.createElement("code");
    cleanCode.textContent = source.replace(/\n$/, "");
    cleanPre.appendChild(cleanCode);
    block.append(head, cleanPre);
    pre.replaceWith(block);
  }
  // Wide tables scroll on their own instead of stretching the page.
  for (const table of [...box.querySelectorAll("table")]) {
    const wrap = el("div", "table-wrap");
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
  for (const a of box.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return box;
}

/* --- Rendering messages -------------------------------------------------------------- */

function renderImage(step) {
  const figure = el("figure", "picture");
  const img = document.createElement("img");
  img.src = `/api/images/${encodeURIComponent(step.id)}`;
  img.alt = step.prompt || "Picture made by Ocean";
  img.loading = "lazy";
  const caption = document.createElement("figcaption");
  const link = el("a", "", "Download picture");
  link.href = img.src;
  link.download = `ocean-picture-${step.id}.jpg`;
  caption.appendChild(link);
  figure.append(img, caption);
  return figure;
}

// A fold-away list of the searches and pages behind a reply.
// A fold-away list of what Ocean did on the laptop or a web page.
function renderActions(steps) {
  const acts = steps.filter((s) => s.type === "action");
  if (!acts.length) return null;
  const details = el("details", "research");
  const summary = document.createElement("summary");
  summary.appendChild(icon("check"));
  const failed = acts.filter((a) => a.ok === false).length;
  summary.appendChild(el("span", "", `Did ${acts.length} ${acts.length === 1 ? "step" : "steps"}` + (failed ? `, ${failed} not done` : "")));
  details.appendChild(summary);
  const list = document.createElement("ul");
  for (const a of acts) list.appendChild(el("li", "", a.summary + (a.ok === false ? " (not done)" : "")));
  details.appendChild(list);
  return details;
}

// Proof of what Claude Code did: status, files, commands with their output.
function renderTaskCard(r) {
  const finished = r.status === "finished";
  const card = el("section", `task-card ${finished ? "ok" : "bad"}`);
  const head = el("div", "task-head");
  head.appendChild(icon(finished ? "check" : "close"));
  head.appendChild(el("strong", "", finished ? "Claude Code finished" : "Claude Code did not finish"));
  if (r.folder) head.appendChild(el("span", "task-folder", r.folder));
  card.appendChild(head);
  const rel = (f) => (r.folder && f.toLowerCase().startsWith(r.folder.toLowerCase()) ? f.slice(r.folder.length).replace(/^[\\/]/, "") : f);
  if (r.files && r.files.length) {
    card.appendChild(el("div", "task-label", `Files made or changed (${r.files.length})`));
    const ul = el("ul", "task-files");
    for (const f of r.files) ul.appendChild(el("li", "", rel(f)));
    card.appendChild(ul);
  } else {
    card.appendChild(el("div", "task-label", "No files were made or changed"));
  }
  if (r.commands && r.commands.length) {
    card.appendChild(el("div", "task-label", "Commands run"));
    for (const c of r.commands) {
      const row = el("div", `task-cmd${c.failed ? " failed" : ""}`);
      row.appendChild(el("code", "", c.command));
      row.appendChild(el("span", "task-status", c.failed ? "failed" : "worked"));
      if (c.output) row.appendChild(el("pre", "task-out", c.output));
      card.appendChild(row);
    }
  }
  if (r.denied && r.denied.length) {
    card.appendChild(el("div", "task-label", "Blocked by your safety rules"));
    const ul = el("ul", "task-files");
    for (const d of r.denied) ul.appendChild(el("li", "", d));
    card.appendChild(ul);
  }
  if (!finished && r.summary) card.appendChild(el("p", "task-note", r.summary.slice(0, 600)));
  if (r.steps && r.steps.length) {
    const more = el("details", "task-steps");
    const sum = document.createElement("summary");
    sum.textContent = `Every step (${r.steps.length})`;
    more.appendChild(sum);
    const ol = document.createElement("ol");
    for (const st of r.steps) ol.appendChild(el("li", "", st));
    more.appendChild(ol);
    card.appendChild(more);
  }
  return card;
}

function renderResearch(steps) {
  const searches = steps.filter((s) => s.type === "search");
  const reads = steps.filter((s) => s.type === "read");
  if (!searches.length && !reads.length) return null;
  const details = el("details", "research");
  const summary = document.createElement("summary");
  summary.appendChild(icon("globe"));
  const parts = [];
  if (searches.length) parts.push(`${searches.length} ${searches.length === 1 ? "search" : "searches"}`);
  if (reads.length) parts.push(`${reads.length} ${reads.length === 1 ? "page" : "pages"} read`);
  summary.appendChild(el("span", "", parts.join(", ")));
  details.appendChild(summary);
  const list = document.createElement("ul");
  for (const s of steps) {
    const li = document.createElement("li");
    if (s.type === "search") {
      li.textContent = s.error ? `Searched for "${s.query}" (failed: ${s.error})` : `Searched for "${s.query}"`;
    } else if (s.type === "read") {
      if (s.error) {
        li.textContent = `Could not open ${s.url}: ${s.error}`;
      } else {
        li.append("Read ");
        const a = el("a", "", s.title || s.url);
        a.href = /^https?:\/\//.test(s.url) ? s.url : "#";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        li.appendChild(a);
      }
    } else {
      continue;
    }
    list.appendChild(li);
  }
  details.appendChild(list);
  return details;
}

function fileIconName(kind) {
  if (kind === "image") return "image";
  if (kind === "excel" || kind === "csv") return "sheet";
  return "file";
}

function attachmentLink(file) {
  const a = el("a", "file-chip");
  a.href = `/api/uploads/${encodeURIComponent(file.id)}`;
  a.download = file.name;
  a.title = `Download ${file.name}`;
  const ic = el("span", "ficon");
  ic.appendChild(icon(fileIconName(file.kind)));
  const meta = el("span", "fmeta");
  meta.appendChild(el("span", "fname", file.name));
  a.append(ic, meta);
  return a;
}

function botAvatar() {
  const img = document.createElement("img");
  img.src = "icon.svg";
  img.alt = "";
  img.className = "who";
  return img;
}

function renderUserMessage(message, isLast) {
  const wrap = el("div", "msg msg-user");
  wrap.dataset.id = message.id || "";
  const files = Array.isArray(message.attachments) ? message.attachments : [];
  if (files.length) {
    const row = el("div", "files");
    for (const f of files) row.appendChild(attachmentLink(f));
    wrap.appendChild(row);
  }
  if (state.editing && state.editing === message.id) {
    wrap.appendChild(editBox(message));
    return wrap;
  }
  wrap.appendChild(el("div", "bubble", message.content));
  if (message.id) {
    const tools = el("div", "msg-tools");
    tools.appendChild(toolButton("copy", "Copy", (e) => copyText(message.content, e.currentTarget)));
    if (isLast) {
      tools.appendChild(toolButton("edit", "Edit", () => {
        state.editing = message.id;
        renderMessages(false);
        const box = document.querySelector(".edit-box textarea");
        if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
      }));
    }
    wrap.appendChild(tools);
  }
  return wrap;
}

function editBox(message) {
  const form = el("form", "edit-box");
  const area = document.createElement("textarea");
  area.value = message.content;
  area.setAttribute("aria-label", "Edit your message");
  const row = el("div", "row");
  const cancel = el("button", "btn btn-ghost", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => { state.editing = null; renderMessages(false); });
  const save = el("button", "btn btn-primary", "Send");
  save.type = "submit";
  row.append(cancel, save);
  form.append(area, row);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = area.value.trim();
    if (!text) return;
    if (text === message.content.trim()) { state.editing = null; renderMessages(false); return; }
    editLastMessage(text);
  });
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarsePointer()) {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      cancel.click();
    }
  });
  return form;
}

function renderBotMessage(message, isLast) {
  const wrap = el("div", "msg msg-bot");
  wrap.dataset.id = message.id || "";
  wrap.appendChild(botAvatar());
  const content = el("div", "content");
  const steps = Array.isArray(message.steps) ? message.steps : [];
  const research = renderResearch(steps);
  if (research) content.appendChild(research);
  const actions = renderActions(steps);
  if (actions) content.appendChild(actions);
  for (const step of steps) {
    if (step.type === "action" && step.report && step.report.kind === "claude_code") content.appendChild(renderTaskCard(step.report));
  }
  for (const step of steps) {
    if (step.type === "image" && step.id) content.appendChild(renderImage(step));
  }
  content.appendChild(renderMarkdown(message.content || ""));
  const tools = el("div", "msg-tools");
  tools.appendChild(toolButton("copy", "Copy", (e) => copyText(message.content, e.currentTarget)));
  if (isLast) tools.appendChild(toolButton("retry", "Try again", () => regenerate()));
  content.appendChild(tools);
  wrap.appendChild(content);
  if (isLast) wrap.classList.add("last");
  return wrap;
}

const THINKING_TEXT = {
  research: "Searching and reading",
  image: "Making your picture",
  code: "Writing the code",
};

function thinkingRow(mode) {
  const wrap = el("div", "msg msg-bot pending");
  wrap.appendChild(botAvatar());
  const content = el("div", "content");
  const row = el("div", "thinking");
  const dots = el("span", "dots");
  dots.append(el("i"), el("i"), el("i"));
  row.append(dots, el("span", "label", THINKING_TEXT[mode] || "Thinking"));
  content.appendChild(row);
  content.appendChild(el("ul", "live-steps"));
  wrap.appendChild(content);
  return wrap;
}

function liveStep(waiting, text, label) {
  const list = waiting.querySelector(".live-steps");
  const li = el("li", "", text);
  list.appendChild(li);
  if (label) waiting.querySelector(".thinking .label").textContent = label;
  scrollToBottom();
  return li;
}

const ACTION_TEXT = {
  list_folder: (a) => `Looking in ${a.path || "your allowed folders"}`,
  find_files: (a) => `Searching for files named "${a.name || ""}"`,
  read_file: (a) => `Reading ${a.path || "a file"}`,
  write_file: (a) => `Saving ${a.path || "a file"} (waiting for your OK)`,
  open_item: (a) => `Opening ${a.path || ""}`,
  open_link: (a) => `Opening ${a.url || "a link"}`,
  open_app: (a) => `Opening ${a.app || "an app"} (waiting for your OK)`,
  claude_code: () => "Claude Code is working (approve it in the box that opens)",
};

// Carry out the laptop actions Ocean asked for, then let it carry on.
async function runActions(result, waiting) {
  while (result.status === "actions") {
    const results = [];
    for (const action of result.actions) {
      const describe = ACTION_TEXT[action.name];
      const li = liveStep(waiting, describe ? describe(action.arguments || {}) : action.name, "Working on your laptop");
      let done;
      if (!desktop) done = { ok: false, message: "This only works in the Ocean Windows app." };
      else {
        // Long tasks (Claude Code) report what they are doing as they go.
        const sub = el("ul", "live-sub");
        li.appendChild(sub);
        const stop = desktop.onProgress ? desktop.onProgress((text) => {
          sub.appendChild(el("li", "", text));
          while (sub.children.length > 8) sub.firstChild.remove();
          scrollToBottom();
        }) : null;
        try { done = await desktop.run(action); }
        catch (err) { done = { ok: false, message: String(err && err.message || err) }; }
        finally { if (stop) stop(); }
      }
      if (!done.ok) { li.classList.add("bad"); li.textContent += ` (${String(done.message).slice(0, 140)})`; }
      const item = { id: action.id, ok: !!done.ok, message: String(done.message || "").slice(0, 19000) };
      if (done.report && typeof done.report === "object") item.report = done.report;
      results.push(item);
    }
    waiting.querySelector(".thinking .label").textContent = "Thinking";
    result = await api(`/api/runs/${result.run_id}/continue`, { method: "POST", body: { results } });
  }
  return result;
}

// "My laptop" in the Windows app: Ollama answers on the laptop, then the chat is saved.
async function askLaptopBrain(text) {
  const history = (state.current ? state.current.messages : []).slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));
  const messages = [
    { role: "system", content: "You are Ocean, Gudani's personal assistant in Johannesburg. Be warm, direct and brief. Use markdown for lists, tables and code." },
    ...history,
    { role: "user", content: text },
  ];
  const answer = await desktop.ollamaChat(messages);
  if (!answer.ok) throw new Error(answer.message);
  if (!state.current) {
    const created = await api("/api/conversations", { method: "POST", body: { private: state.newChatPrivate } });
    state.current = { ...created, messages: [] };
  }
  return api(`/api/conversations/${state.current.id}/local`, {
    method: "POST", body: { content: text, reply: answer.content || "(no answer)", model: answer.model },
  });
}

function renderMessages(scroll = true) {
  const box = $("messages");
  box.replaceChildren();
  const messages = state.current ? state.current.messages : [];
  let lastUser = -1;
  let lastBot = -1;
  messages.forEach((m, i) => { if (m.role === "user") lastUser = i; else lastBot = i; });
  messages.forEach((m, i) => {
    box.appendChild(m.role === "user"
      ? renderUserMessage(m, i === lastUser && !state.busy)
      : renderBotMessage(m, i === lastBot && i === messages.length - 1 && !state.busy));
  });
  updateEmpty();
  if (scroll) scrollToBottom();
}

function scrollToBottom() {
  const s = $("scroller");
  s.scrollTop = s.scrollHeight;
}

function updateEmpty() {
  const empty = !state.busy && (!state.current || !state.current.messages.length);
  document.querySelector(".main").classList.toggle("is-empty", empty);
  if (empty) $("greeting").textContent = greeting();
}

function greeting() {
  const h = new Date().getHours();
  const part = h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return state.username ? `${part}, ${displayName(state.username)}` : part;
}

function displayName(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/* --- Chat list ------------------------------------------------------------------------ */

function groupLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const t = d.getTime();
  if (t >= startOfToday) return "Today";
  if (t >= startOfToday - day) return "Yesterday";
  if (t >= startOfToday - 7 * day) return "Previous 7 days";
  if (t >= startOfToday - 30 * day) return "Previous 30 days";
  return "Older";
}

function highlighted(text, words) {
  const span = el("span", "title");
  if (!words.length) { span.textContent = text; return span; }
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    let best = -1;
    let len = 0;
    for (const w of words) {
      const at = lower.indexOf(w, i);
      if (at !== -1 && (best === -1 || at < best)) { best = at; len = w.length; }
    }
    if (best === -1) { span.append(text.slice(i)); break; }
    span.append(text.slice(i, best));
    span.appendChild(el("mark", "", text.slice(best, best + len)));
    i = best + len;
  }
  return span;
}

function renderChatList() {
  const list = $("chat-list");
  list.replaceChildren();
  const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!state.conversations.length) {
    list.appendChild(el("p", "chat-list-empty",
      state.query ? `No chats match "${state.query}".` : "Your chats will appear here."));
    return;
  }
  let group = null;
  if (state.query) list.appendChild(el("div", "chat-group", "Results"));
  for (const c of state.conversations) {
    if (!state.query) {
      const label = groupLabel(c.updated_at);
      if (label !== group) { list.appendChild(el("div", "chat-group", label)); group = label; }
    }
    const b = el("button", "chat-item");
    b.type = "button";
    b.title = c.title;
    b.appendChild(highlighted(c.title, words));
    if (!c.private) b.appendChild(el("span", "open-tag", "Open"));
    if (state.current && state.current.id === c.id) b.setAttribute("aria-current", "true");
    b.addEventListener("click", () => { openConversation(c.id); closeSidebar(); });
    list.appendChild(b);
  }
}

let searchTimer = null;
let searchSeq = 0;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    state.query = $("search").value.trim();
    const seq = ++searchSeq;
    try {
      const path = state.query ? `/api/conversations?q=${encodeURIComponent(state.query)}` : "/api/conversations";
      const rows = await api(path);
      if (seq !== searchSeq) return; // a newer search has started
      state.conversations = rows;
      renderChatList();
    } catch (err) { setStatus(err.message); }
  }, 250);
}

async function refreshConversations() {
  const path = state.query ? `/api/conversations?q=${encodeURIComponent(state.query)}` : "/api/conversations";
  state.conversations = await api(path);
  renderChatList();
}

/* --- Header: title, private, brain picker ------------------------------------------------ */

function isPrivate() {
  return state.current ? state.current.private : state.newChatPrivate;
}

function renderHeader() {
  $("chat-title").textContent = state.current ? state.current.title : "";
  const priv = isPrivate();
  $("private").setAttribute("aria-pressed", String(priv));
  $("private-label").textContent = priv ? "Private" : "Open";
  $("private").title = priv
    ? "Private: this chat only uses providers that allow client work. Click to make it open."
    : "Open: NVIDIA can be used as a last resort. Keep client work out. Click to make it private.";
  $("chat-menu-button").hidden = !state.current;
  updateRouteOptions();
}

function buildRouteOptions() {
  const select = $("route");
  select.replaceChildren();
  const add = (value, text) => {
    const o = el("option", "", text);
    o.value = value;
    select.appendChild(o);
    return o;
  };
  add("auto", "Automatic");
  if (state.brains) {
    for (const p of state.brains.cloud) {
      if (!p.configured) continue;
      const o = add(`cloud:${p.name}`, p.client_safe ? cap(p.name) : `${cap(p.name)} (open chats)`);
      o.dataset.clientSafe = String(p.client_safe);
    }
    const local = state.brains.local;
    if (desktop) {
      const ready = desktopInfo && desktopInfo.ollama && desktopInfo.ollama.running;
      add("local", ready ? "My laptop (Ollama)" : "My laptop (set up Ollama)");
    } else {
      add("local", local.configured ? "My laptop" : "My laptop (not set up)");
    }
  }
  const saved = load(ROUTE_KEY);
  if (saved && [...select.options].some((o) => o.value === saved)) select.value = saved;
  updateRouteOptions();
}

function updateRouteOptions() {
  const select = $("route");
  const priv = isPrivate();
  for (const o of select.options) {
    if (o.dataset.clientSafe === "false") o.disabled = priv;
  }
  if (select.selectedOptions[0] && select.selectedOptions[0].disabled) select.value = "auto";
}

const DISPLAY_NAMES = {
  groq: "Groq", openrouter: "OpenRouter", cloudflare: "Cloudflare", nvidia: "NVIDIA",
  cerebras: "Cerebras", ollama: "My laptop", tavily: "Tavily (search)", exa: "Exa (search)",
  whisper: "Whisper (voice)",
};
function cap(name) { return DISPLAY_NAMES[name] || name.charAt(0).toUpperCase() + name.slice(1); }

function askOptions() {
  const value = $("route").value;
  const body = {};
  if (value === "local") body.brain = desktop ? "cloud" : "local";
  else if (value.startsWith("cloud:")) { body.brain = "cloud"; body.provider = value.slice(6); }
  if (state.mode) body.mode = state.mode;
  return body;
}

async function togglePrivate() {
  const next = !isPrivate();
  if (!state.current) {
    state.newChatPrivate = next;
    renderHeader();
    setStatus(next ? "Private chat." : "Open chat. NVIDIA can be used as a last resort, so keep client work out.");
    return;
  }
  try {
    const updated = await api(`/api/conversations/${state.current.id}`, { method: "PATCH", body: { private: next } });
    state.current = { ...state.current, ...updated };
    renderHeader();
    await refreshConversations();
    setStatus(next ? "This chat is private." : "This chat is open. Keep client work out of it.");
  } catch (err) { setStatus(err.message); }
}

/* --- Conversations ------------------------------------------------------------------- */

async function openConversation(id) {
  if (state.busy) return;
  setStatus("");
  try {
    state.current = await api(`/api/conversations/${id}`);
  } catch (err) {
    setStatus(err.message);
    return;
  }
  state.editing = null;
  renderHeader();
  renderMessages();
  renderChatList();
  $("input").focus();
}

function startNewChat() {
  if (state.busy) return;
  state.current = null;
  state.editing = null;
  state.newChatPrivate = true;
  renderHeader();
  renderMessages();
  renderChatList();
  setStatus("");
  $("input").focus();
}

function setBusy(busy) {
  state.busy = busy;
  updateSendButton();
}

function showError(box, message, keepNote) {
  const div = el("div", "msg msg-error", keepNote ? `${message} ${keepNote}` : message);
  box.appendChild(div);
  scrollToBottom();
}

async function sendMessage(text) {
  if (state.busy) return;
  const files = state.files.filter((f) => f.status === "ready");
  const mode = state.mode;
  setBusy(true);
  setStatus("");

  // Show the message and a waiting row straight away.
  const box = $("messages");
  const preview = { role: "user", content: text, attachments: files.map((f) => ({ id: f.id, name: f.name, kind: f.kind })) };
  if (!state.current) box.replaceChildren();
  updateEmpty();
  box.querySelectorAll(".msg-tools").forEach((t) => t.remove());
  box.appendChild(renderUserMessage(preview, false));
  const waiting = thinkingRow(mode);
  box.appendChild(waiting);
  scrollToBottom();

  try {
    let result;
    if (desktop && $("route").value === "local") {
      if (files.length) throw new Error("The laptop brain cannot read attached files. Choose Automatic to send files.");
      result = await askLaptopBrain(text);
    } else {
      if (!state.current) {
        const created = await api("/api/conversations", { method: "POST", body: { private: state.newChatPrivate } });
        state.current = { ...created, messages: [] };
      }
      result = await api(`/api/conversations/${state.current.id}/messages`, {
        method: "POST",
        body: { content: text, file_ids: files.map((f) => f.id), laptop: !!desktop, ...askOptions() },
      });
      result = await runActions(result, waiting);
    }
    state.current = { ...result.conversation, messages: [...state.current.messages, ...result.messages] };
    $("input").value = "";
    state.files = [];
    renderAttachments();
    if (state.mode === "image") setMode(null);
    autosize();
    setBusy(false);
    renderHeader();
    renderMessages();
    await refreshConversations();
  } catch (err) {
    waiting.remove();
    setBusy(false);
    showError(box, err.message, "Your message is still in the box, so you can send it again.");
  } finally {
    if (state.busy) setBusy(false);
    refreshUsage();
  }
}

async function regenerate() {
  if (state.busy || !state.current) return;
  setBusy(true);
  setStatus("");
  const box = $("messages");
  const last = box.querySelector(".msg-bot.last");
  const waiting = thinkingRow(state.mode);
  if (last) last.replaceWith(waiting); else box.appendChild(waiting);
  box.querySelectorAll(".msg-tools").forEach((t) => t.remove());
  scrollToBottom();
  try {
    const result = await api(`/api/conversations/${state.current.id}/regenerate`, {
      method: "POST", body: askOptions(),
    });
    state.current = {
      ...result.conversation,
      messages: [...state.current.messages.filter((m) => m.id !== result.replaced), ...result.messages],
    };
    setBusy(false);
    renderMessages();
    await refreshConversations();
  } catch (err) {
    setBusy(false);
    renderMessages();
    showError(box, err.message);
  } finally {
    refreshUsage();
  }
}

async function editLastMessage(text) {
  if (state.busy || !state.current) return;
  const editedId = state.editing;
  setBusy(true);
  setStatus("");
  // Show the edited message and drop everything after it while Ocean answers.
  const messages = state.current.messages;
  const at = messages.findIndex((m) => m.id === editedId);
  const kept = at === -1 ? messages : messages.slice(0, at);
  const original = at === -1 ? null : messages[at];
  state.editing = null;
  const shown = { ...state.current, messages: kept };
  const box = $("messages");
  const saved = state.current;
  state.current = shown;
  renderMessages(false);
  box.querySelectorAll(".msg-tools").forEach((t) => t.remove());
  box.appendChild(renderUserMessage({ role: "user", content: text, attachments: original ? original.attachments : [] }, false));
  box.appendChild(thinkingRow(state.mode));
  scrollToBottom();
  state.current = saved;
  try {
    const result = await api(`/api/conversations/${state.current.id}/edit`, {
      method: "POST", body: { content: text, ...askOptions() },
    });
    const removed = new Set(result.removed);
    state.current = {
      ...result.conversation,
      messages: [...state.current.messages.filter((m) => !removed.has(m.id)), ...result.messages],
    };
    setBusy(false);
    renderMessages();
    await refreshConversations();
  } catch (err) {
    setBusy(false);
    renderMessages();
    showError(box, err.message, "Your original message was kept.");
  } finally {
    refreshUsage();
  }
}

async function renameChat() {
  if (!state.current) return;
  const title = window.prompt("Rename this chat", state.current.title);
  if (title === null) return;
  const clean = title.trim().slice(0, 200);
  if (!clean) return;
  try {
    const updated = await api(`/api/conversations/${state.current.id}`, { method: "PATCH", body: { title: clean } });
    state.current = { ...state.current, ...updated };
    renderHeader();
    await refreshConversations();
  } catch (err) { setStatus(err.message); }
}

async function deleteChat() {
  if (!state.current) return;
  const ok = window.confirm(`Delete "${state.current.title}"? This permanently removes the chat and its messages.`);
  if (!ok) return;
  try {
    await api(`/api/conversations/${state.current.id}`, { method: "DELETE" });
    await refreshConversations();
    startNewChat();
    setStatus("Chat deleted.");
  } catch (err) { setStatus(err.message); }
}

/* --- Quick modes ------------------------------------------------------------------------ */

const MODE_PLACEHOLDER = {
  research: "What should Ocean research?",
  image: "Describe the picture you want",
  code: "What should Ocean build?",
};

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll(".mode")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  }
  $("input").placeholder = MODE_PLACEHOLDER[mode] || "Ask Ocean anything";
}

const SUGGESTIONS = [
  { title: "Build a Shopify section", sub: "Liquid, CSS and schema, ready to paste", mode: "code", text: "Build a Shopify section for " },
  { title: "Draft a Klaviyo email", sub: "Subject lines, copy and layout", mode: null, text: "Draft a Klaviyo email for " },
  { title: "Research a topic", sub: "Searches the web and cites sources", mode: "research", text: "" },
  { title: "Make a picture", sub: "Describe it and Ocean draws it", mode: "image", text: "" },
];

function renderSuggestions() {
  const box = $("suggestions");
  box.replaceChildren();
  for (const s of SUGGESTIONS) {
    const b = el("button", "suggestion");
    b.type = "button";
    b.append(el("strong", "", s.title), el("span", "", s.sub));
    b.addEventListener("click", () => {
      setMode(s.mode);
      const input = $("input");
      input.value = s.text;
      autosize();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    box.appendChild(b);
  }
}

/* --- Attachments --------------------------------------------------------------------- */

let fileKey = 0;

function addFiles(list) {
  for (const file of list) {
    if (state.files.length >= MAX_FILES) {
      setStatus(`You can attach up to ${MAX_FILES} files to one message.`);
      break;
    }
    const entry = { key: ++fileKey, name: file.name || "file", size: file.size, status: "uploading" };
    if (file.size > MAX_FILE_BYTES) {
      entry.status = "failed";
      entry.error = "Bigger than 10 MB";
      state.files.push(entry);
      continue;
    }
    state.files.push(entry);
    uploadFile(entry, file);
  }
  renderAttachments();
}

async function uploadFile(entry, file) {
  const form = new FormData();
  form.append("file", file, entry.name);
  try {
    const result = await api("/api/uploads", { method: "POST", form });
    Object.assign(entry, { status: "ready", id: result.id, kind: result.kind, note: result.note || "" });
    if (result.note) setStatus(`${entry.name}: ${result.note}`);
    else if (result.truncated) setStatus(`${entry.name} is long, so Ocean will read the first part of it.`);
  } catch (err) {
    entry.status = "failed";
    entry.error = err.message;
  }
  if (state.files.includes(entry)) renderAttachments();
}

function renderAttachments() {
  const box = $("attachments");
  box.replaceChildren();
  box.hidden = !state.files.length;
  for (const f of state.files) {
    const chip = el("div", `file-chip${f.status === "failed" ? " failed" : ""}`);
    const ic = el("span", "ficon");
    ic.appendChild(icon(fileIconName(f.kind)));
    const meta = el("span", "fmeta");
    meta.appendChild(el("span", "fname", f.name));
    const sub = f.status === "uploading" ? "Uploading..." : f.status === "failed" ? f.error : fmtSize(f.size);
    meta.appendChild(el("span", "fsub", sub));
    chip.title = f.status === "failed" ? `${f.name}: ${f.error}` : f.note ? `${f.name}: ${f.note}` : f.name;
    const remove = el("button", "icon-btn remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${f.name}`);
    remove.appendChild(icon("close"));
    remove.addEventListener("click", () => {
      state.files = state.files.filter((x) => x !== f);
      renderAttachments();
    });
    chip.append(ic, meta, remove);
    box.appendChild(chip);
  }
  updateSendButton();
}

function updateSendButton() {
  const uploading = state.files.some((f) => f.status === "uploading");
  $("send").disabled = state.busy || uploading;
}

/* --- Voice input --------------------------------------------------------------------- */

const voice = { recorder: null, chunks: [], stream: null, started: 0, timer: null, stopTimer: null };

function pickAudioType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function toggleRecording() {
  if (voice.recorder) { voice.recorder.stop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    setStatus("This browser cannot record sound. Try Chrome or Edge.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus(err && err.name === "NotAllowedError"
      ? "Ocean needs permission to use the microphone. Allow it in your browser's site settings, then try again."
      : "Could not start the microphone.");
    return;
  }
  const type = pickAudioType();
  let recorder;
  try {
    recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
  } catch (_) {
    stream.getTracks().forEach((t) => t.stop());
    setStatus("This browser cannot record sound. Try Chrome or Edge.");
    return;
  }
  Object.assign(voice, { recorder, stream, chunks: [], started: Date.now() });
  recorder.addEventListener("dataavailable", (e) => { if (e.data && e.data.size) voice.chunks.push(e.data); });
  recorder.addEventListener("stop", finishRecording);
  recorder.start();
  const mic = $("mic");
  mic.classList.add("recording");
  mic.replaceChild(icon("stop"), mic.querySelector("svg"));
  mic.setAttribute("aria-label", "Stop recording");
  mic.title = "Stop recording";
  $("rec-time").hidden = false;
  $("rec-time").textContent = "0:00";
  setStatus("Listening. Tap the button again when you are done.");
  voice.timer = setInterval(() => {
    const s = Math.floor((Date.now() - voice.started) / 1000);
    $("rec-time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 250);
  voice.stopTimer = setTimeout(() => { if (voice.recorder) voice.recorder.stop(); }, MAX_RECORD_MS);
}

async function finishRecording() {
  const { recorder, stream, chunks } = voice;
  clearInterval(voice.timer);
  clearTimeout(voice.stopTimer);
  stream.getTracks().forEach((t) => t.stop());
  voice.recorder = null;
  const mic = $("mic");
  mic.classList.remove("recording");
  mic.replaceChild(icon("mic"), mic.querySelector("svg"));
  mic.setAttribute("aria-label", "Speak your message");
  mic.title = "Speak your message";
  $("rec-time").hidden = true;

  const type = (recorder.mimeType || chunks[0]?.type || "audio/webm").split(";")[0];
  const blob = new Blob(chunks, { type });
  if (!blob.size) { setStatus("No sound was recorded."); return; }
  mic.classList.add("busy");
  setStatus("Turning your speech into text...");
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("audio", blob, `speech.${ext}`);
  try {
    const result = await api("/api/transcribe", { method: "POST", form });
    const text = (result.text || "").trim();
    if (!text) { setStatus("Ocean could not hear any words. Try again a little closer to the microphone."); return; }
    const input = $("input");
    input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text;
    autosize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    setStatus("");
  } catch (err) {
    setStatus(err.message);
  } finally {
    mic.classList.remove("busy");
    refreshUsage();
  }
}

/* --- Usage tracker --------------------------------------------------------------- */

let lastUsage = null;

async function refreshUsage() {
  try {
    lastUsage = await api("/api/usage?days=7");
  } catch (_) { return; }
  renderGauge();
  if (!$("usage-panel").hidden) renderUsagePanel();
}

function renderGauge() {
  if (!lastUsage) return;
  const shares = lastUsage.providers
    .filter((p) => p.configured && p.used_share !== null && p.used_share !== undefined)
    .map((p) => p.used_share);
  const top = shares.length ? Math.max(...shares) : 0;
  const pct = Math.min(100, Math.round(top * 100));
  $("gauge-fill").style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE * (1 - Math.min(1, top)));
  $("gauge-text").textContent = `${pct}%`;
  $("gauge").dataset.level = pct >= 80 ? "high" : "normal";
  $("gauge").setAttribute("aria-label", `Usage today: the busiest provider is at ${pct}% of its free daily limit. Open usage details.`);
}

function bar(label, used, limit) {
  const row = el("div", "bar-row");
  const head = el("div", "bar-label");
  head.append(el("span", "", label), el("span", "", limit ? `${fmt(used)} of ${fmt(limit)}` : fmt(used)));
  row.appendChild(head);
  if (limit) {
    const track = el("div", "bar");
    const fill = el("span");
    const share = Math.min(1, used / limit);
    fill.style.width = `${share * 100}%`;
    if (share >= 0.8) fill.className = "high";
    track.appendChild(fill);
    row.appendChild(track);
  }
  return row;
}

function fmt(n) { return Number(n || 0).toLocaleString(); }

function renderUsagePanel() {
  if (!lastUsage) return;
  const reset = new Date(lastUsage.resets_at);
  $("usage-reset").textContent =
    `Daily counts reset at ${reset.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} your time (midnight UTC).`;

  const list = $("usage-list");
  list.replaceChildren();
  for (const p of lastUsage.providers) {
    const card = el("section", "provider");
    const head = el("div", "provider-head");
    head.appendChild(el("span", "provider-name", p.local ? "My laptop" : cap(p.name)));
    if (p.client_safe === false) head.appendChild(el("span", "provider-tag", "Open chats only"));
    card.appendChild(head);
    if (p.model) card.appendChild(el("div", "provider-model", p.model));
    if (!p.configured) {
      card.appendChild(el("p", "provider-off", "Not set up."));
      list.appendChild(card);
      continue;
    }
    const t = p.today || {};
    const l = p.limits || {};
    if (p.kind === "search") {
      card.appendChild(bar("Searches today", t.requests, 0));
      card.appendChild(bar("Searches this month", p.month_requests || 0, l.requests_per_month));
    } else if (p.kind === "voice") {
      card.appendChild(bar("Recordings", t.requests, l.requests_per_day));
    } else {
      card.appendChild(bar("Requests", t.requests, l.requests_per_day));
      if (l.tokens_per_day || !l.units_per_day) card.appendChild(bar("Tokens", t.tokens, l.tokens_per_day));
      if (l.units_per_day) card.appendChild(bar("Units (estimated, includes pictures)", t.units_estimated, l.units_per_day));
    }
    if (t.failed) {
      card.appendChild(el("p", "provider-note", `${t.failed} failed ${t.failed === 1 ? "request" : "requests"} today.`));
    }
    if (l.note) card.appendChild(el("p", "provider-note", l.note));
    list.appendChild(card);
  }

  const history = $("usage-history");
  history.replaceChildren();
  const totals = lastUsage.history.map((d) =>
    Object.values(d.providers).reduce((sum, p) => sum + p.requests, 0));
  const max = Math.max(1, ...totals);
  lastUsage.history.forEach((d, i) => {
    const col = el("div", "history-day");
    const b = el("div", "history-bar");
    b.style.height = `${(totals[i] / max) * 100}%`;
    b.title = `${d.day}: ${totals[i]} ${totals[i] === 1 ? "request" : "requests"}`;
    const date = new Date(`${d.day}T00:00:00Z`);
    col.append(b, el("span", "history-label", date.toLocaleDateString([], { weekday: "short", timeZone: "UTC" })));
    history.appendChild(col);
  });
}

function openUsage() {
  $("usage-panel").hidden = false;
  $("gauge").setAttribute("aria-expanded", "true");
  renderUsagePanel();
  refreshUsage();
  closeSidebar();
  $("close-usage").focus();
}
function closeUsage() {
  $("usage-panel").hidden = true;
  $("gauge").setAttribute("aria-expanded", "false");
  $("gauge").focus();
}

/* --- Settings: Chrome extension and devices ------------------------------------- */

let pairTimer = null;

async function openSettings() {
  $("settings-panel").hidden = false;
  closeSidebar();
  $("close-settings").focus();
  await renderDevices();
}

function closeSettings() {
  $("settings-panel").hidden = true;
  clearInterval(pairTimer);
}

async function makePairingCode() {
  try {
    const r = await api("/api/devices/pair", { method: "POST", body: {} });
    $("pair-code").textContent = r.code;
    $("pair-box").hidden = false;
    const until = Date.now() + r.expires_in * 1000;
    clearInterval(pairTimer);
    const tick = () => {
      const left = Math.max(0, Math.round((until - Date.now()) / 1000));
      $("pair-expiry").textContent = left
        ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
        : "This code has expired. Make a new one.";
      if (!left) clearInterval(pairTimer);
    };
    tick();
    pairTimer = setInterval(() => { tick(); }, 1000);
    // Watch for the new device so the code can be hidden once it is used.
    const before = (await api("/api/devices")).length;
    let checks = 0;
    const watch = setInterval(async () => {
      checks += 1;
      if ($("settings-panel").hidden || checks > 150) { clearInterval(watch); return; }
      let now;
      try { now = (await api("/api/devices")).length; } catch (_) { return; }
      if (now > before) {
        clearInterval(watch);
        clearInterval(pairTimer);
        $("pair-box").hidden = true;
        await renderDevices();
        setStatus("Chrome extension connected.");
      }
    }, 4000);
  } catch (err) { setStatus(err.message); }
}

async function renderDevices() {
  const list = $("device-list");
  let rows;
  try { rows = await api("/api/devices"); } catch (err) { list.replaceChildren(el("p", "muted small", err.message)); return; }
  list.replaceChildren();
  if (!rows.length) { list.appendChild(el("p", "muted small", "No devices connected yet.")); return; }
  for (const d of rows) {
    const row = el("div", "device");
    const meta = el("div");
    meta.appendChild(el("div", "device-name", d.name));
    const used = d.last_used_at ? `last used ${new Date(d.last_used_at).toLocaleString()}` : "not used yet";
    meta.appendChild(el("div", "device-meta", `Connected ${new Date(d.created_at).toLocaleDateString()}, ${used}`));
    const remove = el("button", "link-button small", "Remove");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Remove "${d.name}"? It will stop working straight away and must be connected again.`)) return;
      try { await api(`/api/devices/${d.id}`, { method: "DELETE" }); await renderDevices(); }
      catch (err) { setStatus(err.message); }
    });
    row.append(meta, remove);
    list.appendChild(row);
  }
}

/* --- Small helpers ------------------------------------------------------------------ */

let statusTimer = null;
function setStatus(text) {
  $("status").textContent = text;
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { $("status").textContent = ""; }, 9000);
}

function autosize() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, window.innerHeight * 0.4)}px`;
}

function coarsePointer() {
  return window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
}

function isNarrow() { return window.matchMedia("(max-width: 860px)").matches; }

function openSidebar() {
  if (isNarrow()) {
    $("sidebar").classList.add("open");
    $("scrim").hidden = false;
  } else {
    $("app").classList.remove("collapsed");
    store(COLLAPSED_KEY, null);
  }
}
function closeSidebar() { $("sidebar").classList.remove("open"); $("scrim").hidden = true; }
function collapseSidebar() {
  $("app").classList.add("collapsed");
  store(COLLAPSED_KEY, "1");
}

function toggleMenu(force) {
  const menu = $("chat-menu");
  const open = force !== undefined ? force : menu.hidden;
  menu.hidden = !open;
  $("chat-menu-button").setAttribute("aria-expanded", String(open));
}

/* --- Sign in, setup and start ------------------------------------------------------------ */

function showAuth(id) {
  state.signedIn = false;
  $("app").hidden = true;
  $("auth").hidden = false;
  for (const panel of ["signin-form", "setup-form", "totp-form", "recovery-panel"]) {
    $(panel).hidden = panel !== id;
  }
}

function showFormError(id, message) {
  const node = $(id);
  node.hidden = !message;
  node.textContent = message || "";
}

function showSignIn(message) {
  showAuth("signin-form");
  showFormError("signin-error", message);
  $("login-password").value = "";
  $("login-code").value = "";
  ($("login-username").value ? $("login-password") : $("login-username")).focus();
}

function showSetup(reset) {
  showAuth("setup-form");
  state.resetMode = reset;
  $("setup-title").textContent = reset ? "Reset your login" : "Set up your login";
  $("setup-intro").textContent = reset
    ? "This replaces your username, password and authenticator app, and signs out every browser. You need the access token from the ocean service's Variables tab on Railway."
    : "Create the login you will use to open Ocean. You need the access token once, from the ocean service's Variables tab on Railway.";
  $("cancel-reset").hidden = !reset;
  showFormError("setup-error", "");
  $("setup-token").focus();
}

async function signOut() {
  try { await api("/api/auth/logout", { method: "POST", body: {}, allow401: true }); } catch (_) { /* already out */ }
  state.current = null;
  state.conversations = [];
  showSignIn("");
}

function svgToDataUri(svg) {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function renderRecoveryCodes(codes) {
  state.recoveryCodes = codes;
  const list = $("recovery-list");
  list.replaceChildren();
  for (const code of codes) list.appendChild(el("li", "", code));
  $("saved-recovery").checked = false;
  $("finish-setup").disabled = true;
}

async function boot() {
  store(OLD_TOKEN_KEY, null);
  let status;
  try {
    status = await api("/api/auth/status");
  } catch (err) {
    showAuth("signin-form");
    showFormError("signin-error", err.message);
    return;
  }
  if (!status.setup_done) showSetup(false);
  else if (status.signed_in) start(status.username);
  else showSignIn("");
}

async function start(username) {
  state.signedIn = true;
  state.username = username || "";
  $("auth").hidden = true;
  $("app").hidden = false;
  if (load(COLLAPSED_KEY) === "1") $("app").classList.add("collapsed");
  $("signed-in-as").textContent = username ? displayName(username) : "";
  $("avatar").textContent = username ? username.charAt(0).toUpperCase() : "";
  setMode(null);
  renderSuggestions();
  state.current = null;
  renderHeader();
  renderMessages();
  if (desktop) {
    try { desktopInfo = await desktop.info(); } catch (_) { desktopInfo = null; }
    $("desktop-settings").hidden = false;
    const n = desktopInfo ? desktopInfo.folders.length : 0;
    $("desktop-folders").textContent = n
      ? `Ocean can use ${n} ${n === 1 ? "folder" : "folders"} on this laptop.`
      : "No folders chosen yet, so Ocean cannot see any files on this laptop.";
  }
  try {
    state.brains = await api("/brains");
  } catch (err) {
    if (err.status !== 401) setStatus(err.message);
    return;
  }
  buildRouteOptions();
  try { await refreshConversations(); } catch (err) { setStatus(err.message); }
  refreshUsage();
  if (!coarsePointer()) $("input").focus();
}

function wireAuth() {
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showFormError("signin-error", "");
    const button = e.submitter || $("signin-form").querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const result = await api("/api/auth/login", {
        method: "POST",
        allow401: true,
        body: {
          username: $("login-username").value.trim(),
          password: $("login-password").value,
          code: $("login-code").value.trim(),
        },
      });
      $("login-password").value = "";
      $("login-code").value = "";
      await start(result.username);
      if (result.recovery_code_used) {
        setStatus(`You used a recovery code. ${result.recovery_codes_left} left. If you lost your phone, reset the login to link a new one.`);
      }
    } catch (err) {
      showFormError("signin-error", err.message);
      $("login-code").value = "";
      $("login-code").focus();
    } finally {
      button.disabled = false;
    }
  });

  $("show-reset").addEventListener("click", () => showSetup(true));
  $("cancel-reset").addEventListener("click", () => showSignIn(""));

  $("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showFormError("setup-error", "");
    const password = $("setup-password").value;
    if (password !== $("setup-password2").value) {
      showFormError("setup-error", "The two passwords do not match.");
      return;
    }
    const accessToken = $("setup-token").value.trim();
    try {
      const result = await api("/api/auth/setup/start", {
        method: "POST",
        allow401: true,
        body: {
          access_token: accessToken,
          username: $("setup-username").value.trim(),
          password,
          reset: !!state.resetMode,
        },
      });
      state.pendingAccessToken = accessToken;
      $("setup-password").value = "";
      $("setup-password2").value = "";
      $("setup-token").value = "";
      $("totp-qr").src = svgToDataUri(result.qr_svg);
      $("totp-secret").textContent = result.secret.replace(/(.{4})/g, "$1 ").trim();
      $("totp-code").value = "";
      showAuth("totp-form");
      showFormError("totp-error", "");
      $("totp-code").focus();
    } catch (err) {
      showFormError("setup-error", err.message);
    }
  });

  $("totp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showFormError("totp-error", "");
    try {
      const result = await api("/api/auth/setup/confirm", {
        method: "POST",
        allow401: true,
        body: { access_token: state.pendingAccessToken, code: $("totp-code").value.trim() },
      });
      state.pendingAccessToken = null;
      state.pendingUsername = result.username;
      renderRecoveryCodes(result.recovery_codes);
      showAuth("recovery-panel");
    } catch (err) {
      showFormError("totp-error", err.message);
      $("totp-code").select();
    }
  });

  $("copy-recovery").addEventListener("click", async () => {
    const ok = await copyText(state.recoveryCodes.join("\n"));
    $("copy-recovery").textContent = ok ? "Copied" : "Copy failed, use download";
  });

  $("download-recovery").addEventListener("click", () => {
    const text = "Ocean recovery codes\nEach code works once, instead of an authenticator code.\n\n"
      + state.recoveryCodes.join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "ocean-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $("saved-recovery").addEventListener("change", (e) => { $("finish-setup").disabled = !e.target.checked; });
  $("finish-setup").addEventListener("click", () => {
    renderRecoveryCodes([]);
    start(state.pendingUsername);
  });
}

function wire() {
  wireAuth();

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("send").disabled) return;
    const text = $("input").value.trim();
    if (!text) {
      if (state.files.length) setStatus("Add a message to go with your files, for example what Ocean should do with them.");
      $("input").focus();
      return;
    }
    if (state.files.some((f) => f.status === "failed")) {
      setStatus("Remove the file that did not upload, or attach it again, before sending.");
      return;
    }
    sendMessage(text);
  });
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarsePointer()) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("input").addEventListener("input", autosize);

  // Files: the paperclip, dragging onto the box, or pasting.
  $("attach").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => {
    addFiles([...e.target.files]);
    e.target.value = "";
  });
  const composer = $("composer");
  composer.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); composer.classList.add("dragging"); }
  });
  composer.addEventListener("dragleave", () => composer.classList.remove("dragging"));
  composer.addEventListener("drop", (e) => {
    composer.classList.remove("dragging");
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });
  $("input").addEventListener("paste", (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  $("mic").addEventListener("click", toggleRecording);

  for (const b of document.querySelectorAll(".mode")) {
    b.addEventListener("click", () => {
      setMode(state.mode === b.dataset.mode ? null : b.dataset.mode);
      $("input").focus();
    });
  }

  $("new-chat").addEventListener("click", () => { startNewChat(); closeSidebar(); });
  $("topbar-new").addEventListener("click", () => startNewChat());
  $("home-link").addEventListener("click", (e) => { e.preventDefault(); startNewChat(); closeSidebar(); });
  $("sign-out").addEventListener("click", () => signOut());
  $("private").addEventListener("click", togglePrivate);
  $("route").addEventListener("change", (e) => store(ROUTE_KEY, e.target.value));
  $("search").addEventListener("input", onSearchInput);

  $("chat-menu-button").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
  $("rename-chat").addEventListener("click", () => { toggleMenu(false); renameChat(); });
  $("delete-chat").addEventListener("click", () => { toggleMenu(false); deleteChat(); });
  document.addEventListener("click", (e) => {
    if (!$("chat-menu").hidden && !$("chat-menu").contains(e.target)) toggleMenu(false);
  });

  $("gauge").addEventListener("click", () => ($("usage-panel").hidden ? openUsage() : closeUsage()));
  $("usage-link").addEventListener("click", openUsage);
  $("settings-link").addEventListener("click", openSettings);
  $("close-settings").addEventListener("click", closeSettings);
  $("make-code").addEventListener("click", makePairingCode);
  $("desktop-open-settings").addEventListener("click", () => desktop && desktop.openSettings());
  $("close-usage").addEventListener("click", closeUsage);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("settings-panel").hidden) closeSettings();
    else if (!$("usage-panel").hidden) closeUsage();
    else if (!$("chat-menu").hidden) toggleMenu(false);
    else if ($("sidebar").classList.contains("open")) closeSidebar();
  });

  $("open-sidebar").addEventListener("click", openSidebar);
  $("collapse-sidebar").addEventListener("click", collapseSidebar);
  $("scrim").addEventListener("click", closeSidebar);

  // Keep the usage gauge fresh while the page is open.
  setInterval(() => { if (state.signedIn && !document.hidden) refreshUsage(); }, 60_000);
}

/* --- Install as an app (phone and computer browsers) --------------------------- */

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("install-box").hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  $("install-box").hidden = true;
  setStatus("Ocean is installed. Open it from your home screen or app list.");
});

async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  try { await installPrompt.userChoice; } catch (_) { /* dismissed */ }
  installPrompt = null;
  $("install-box").hidden = true;
}

if ("serviceWorker" in navigator && !desktop) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* the site still works without it */ });
  });
}

wire();
$("install-app").addEventListener("click", installApp);
boot();
