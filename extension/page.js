"use strict";

/* Functions that run inside the web page (through chrome.scripting).
   Each one must stand alone: it cannot use anything outside itself. */

// A snapshot of the page: address, title, visible text, selected text, and a
// numbered list of things that can be clicked or filled. Each element gets a
// data-ocean-id attribute so later actions can find it again.
function oceanSnapshot() {
  const MAX_ELEMENTS = 400;
  const SELECTOR = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]",
    "[role=menuitem]", "[role=option]", "[role=switch]", "[role=combobox]", "[contenteditable=true]",
  ].join(",");
  const clean = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

  const visible = (el) => {
    if (el.type === "hidden") return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  const labelFor = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (t.trim()) return t;
    }
    if (el.labels && el.labels.length) return [...el.labels].map((l) => l.innerText).join(" ");
    if (el.placeholder) return el.placeholder;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) {
      const wrap = el.closest("label");
      if (wrap) return wrap.innerText;
      const prev = el.previousElementSibling;
      if (prev && prev.innerText && prev.innerText.length < 80) return prev.innerText;
    }
    if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type)) return el.value;
    return el.innerText || el.title || el.getAttribute("name") || el.getAttribute("alt") || "";
  };

  let next = Number(document.documentElement.dataset.oceanNext || "1");
  const found = [...document.querySelectorAll(SELECTOR)].filter(visible);
  // Things in view first, then the rest of the page.
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  };
  found.sort((a, b) => Number(inView(b)) - Number(inView(a)));

  const elements = [];
  for (const el of found.slice(0, MAX_ELEMENTS)) {
    if (!el.dataset.oceanId) el.dataset.oceanId = String(next++);
    const tag = el.tagName.toLowerCase();
    const item = { id: Number(el.dataset.oceanId), tag, label: clean(labelFor(el), 200) };
    const role = el.getAttribute("role");
    if (tag === "input") item.type = (el.type || "text").toLowerCase();
    else if (role) item.type = role;
    if (tag === "input" && ["checkbox", "radio"].includes(item.type)) item.checked = !!el.checked;
    else if (role === "checkbox" || role === "switch") item.checked = el.getAttribute("aria-checked") === "true";
    // Never send what is typed in password fields.
    if ((tag === "input" || tag === "textarea") && item.type !== "password" && !["checkbox", "radio"].includes(item.type) && el.value) {
      item.value = clean(el.value, 300);
    }
    if (tag === "select") {
      item.options = [...el.options].slice(0, 50).map((o) => clean(o.text, 60));
      if (el.selectedOptions[0]) item.value = clean(el.selectedOptions[0].text, 120);
    }
    if (tag === "a") item.href = (el.href || "").slice(0, 500);
    elements.push(item);
  }
  document.documentElement.dataset.oceanNext = String(next);
  elements.sort((a, b) => a.id - b.id);

  return {
    url: location.href.slice(0, 2000),
    title: clean(document.title, 300),
    text: (document.body ? document.body.innerText : "").slice(0, 60000),
    selection: clean(String(getSelection() || ""), 10000) || null,
    elements,
  };
}

// Carry out one action. Returns { ok, message, navigates }.
function oceanAct(action) {
  const name = action.name;
  const args = action.arguments || {};
  const find = (id) => document.querySelector(`[data-ocean-id="${Number(id)}"]`);
  const BLOCKED_FIELD = /pass(word|code)|card.?(number|no)|cc-?(num|csc|exp)|cvv|cvc|security.?code|iban|routing|account.?(number|no)|id.?number|passport|ssn|social.?security|pin\b/i;

  const isBlocked = (el) => {
    if (el.type === "password") return true;
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (auto.startsWith("cc-") || auto.includes("password") || auto === "one-time-code") return true;
    const text = [el.name, el.id, el.getAttribute("aria-label"), el.placeholder,
      el.labels && el.labels[0] && el.labels[0].innerText].filter(Boolean).join(" ");
    return BLOCKED_FIELD.test(text);
  };

  const setValue = (el, value) => {
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return;
    }
    // Use the native setter so frameworks like React notice the change.
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  };

  const choose = (el, option) => {
    const want = String(option).trim().toLowerCase();
    const opts = [...el.options];
    const match = opts.find((o) => o.text.trim().toLowerCase() === want)
      || opts.find((o) => o.value.toLowerCase() === want)
      || opts.find((o) => o.text.trim().toLowerCase().includes(want));
    if (!match) return `No option "${option}". Options: ${opts.map((o) => o.text.trim()).slice(0, 20).join(", ")}`;
    el.value = match.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return null;
  };

  const fillOne = (id, value) => {
    const el = find(id);
    if (!el) return `Element ${id} is not on the page any more.`;
    if (isBlocked(el)) return `Element ${id} is a password, card or ID field. Gudani must fill it himself.`;
    const type = (el.type || "").toLowerCase();
    if (el.tagName === "SELECT") return choose(el, value);
    if (type === "checkbox" || type === "radio" || el.getAttribute("role") === "checkbox") {
      const want = /^(true|yes|on|1|checked)$/i.test(String(value).trim());
      const now = el.getAttribute("role") === "checkbox" ? el.getAttribute("aria-checked") === "true" : el.checked;
      if (want !== now) el.click();
      return null;
    }
    if (["file", "submit", "button", "image", "reset"].includes(type)) return `Element ${id} cannot be filled with text.`;
    setValue(el, String(value));
    return null;
  };

  try {
    if (name === "click") {
      const el = find(args.element);
      if (!el) return { ok: false, message: `Element ${args.element} is not on the page any more.` };
      el.scrollIntoView({ block: "center" });
      const link = el.closest("a[href]");
      const navigates = !!(link && !link.target && !link.href.startsWith("javascript:") && link.href.split("#")[0] !== location.href.split("#")[0]);
      el.click();
      return { ok: true, message: "Clicked.", navigates };
    }
    if (name === "type_text") {
      const el = find(args.element);
      if (!el) return { ok: false, message: `Element ${args.element} is not on the page any more.` };
      if (isBlocked(el)) return { ok: false, message: "That is a password, card or ID field. Gudani must fill it himself." };
      setValue(el, String(args.text ?? ""));
      if (args.press_enter) {
        el.focus();
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        }
        if (el.form) {
          el.form.requestSubmit();
          return { ok: true, message: "Typed and pressed Enter.", navigates: true };
        }
      }
      return { ok: true, message: "Typed." };
    }
    if (name === "fill_form") {
      const problems = [];
      let filled = 0;
      for (const f of args.fields || []) {
        const err = fillOne(f.element, f.value);
        if (err) problems.push(err); else filled += 1;
      }
      return { ok: filled > 0, message: `Filled ${filled} field(s).` + (problems.length ? " Problems: " + problems.join(" ") : "") };
    }
    if (name === "select_option") {
      const err = fillOne(args.element, args.option);
      return err ? { ok: false, message: err } : { ok: true, message: "Chosen." };
    }
    if (name === "scroll") {
      const d = args.direction;
      if (d === "top") scrollTo(0, 0);
      else if (d === "bottom") scrollTo(0, document.body.scrollHeight);
      else scrollBy(0, (d === "up" ? -1 : 1) * innerHeight * 0.8);
      return { ok: true, message: `Scrolled ${d}.` };
    }
    if (name === "read_page") return { ok: true, message: "Here is the page." };
    return { ok: false, message: `Unknown action ${name}.` };
  } catch (err) {
    return { ok: false, message: String(err && err.message || err).slice(0, 300) };
  }
}
