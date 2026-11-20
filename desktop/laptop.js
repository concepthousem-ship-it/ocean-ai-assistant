"use strict";

/* What Ocean can do on the laptop. Everything stays inside the folders
   Gudani allowed in Settings, and writing a file, opening an app or starting
   Claude Code always shows a Windows dialog first. There is no way to delete,
   move or rename files. */

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 15000;
const MAX_LIST = 300;
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", "dist", "build", "AppData"]);
const IS_WIN = process.platform === "win32";

class LaptopError extends Error {
  constructor(message, report) { super(message); this.report = report || null; }
}

function norm(p) {
  const n = path.resolve(p);
  return IS_WIN ? n.toLowerCase() : n;
}

function inside(child, parent) {
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realOrSelf(p) {
  try { return await fsp.realpath(p); } catch (_) { return path.resolve(p); }
}

// Turn what Ocean asked for into a real path inside an allowed folder.
async function resolveAllowed(given, folders, { mustExist = true } = {}) {
  if (!folders.length) throw new LaptopError("No folders are allowed yet. Gudani can add them in the Ocean app's Settings (tray icon, Settings).");
  const raw = String(given || "").trim().replace(/^["']|["']$/g, "");
  if (!raw) throw new LaptopError("No path was given.");
  const candidates = path.isAbsolute(raw) ? [raw] : folders.map((f) => path.join(f, raw));
  for (const c of candidates) {
    const exists = fs.existsSync(c);
    if (mustExist && !exists) continue;
    // For a new file, check the nearest existing parent folder.
    let check = c;
    if (!exists) {
      check = path.dirname(c);
      while (!fs.existsSync(check) && path.dirname(check) !== check) check = path.dirname(check);
    }
    const real = await realOrSelf(check);
    for (const f of folders) {
      if (inside(real, await realOrSelf(f))) return exists ? await realOrSelf(c) : path.resolve(c);
    }
    throw new LaptopError(`${raw} is outside the folders Ocean is allowed to use.`);
  }
  throw new LaptopError(`${raw} was not found in the allowed folders.`);
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function listFolder(args, folders) {
  if (!String(args.path || "").trim()) {
    if (!folders.length) return "No folders are allowed yet. Ask Gudani to add some in the Ocean app's Settings.";
    return "Folders Ocean may use:\n" + folders.map((f) => `- ${f}`).join("\n");
  }
  const dir = await resolveAllowed(args.path, folders);
  const stat = await fsp.stat(dir);
  if (!stat.isDirectory()) throw new LaptopError(`${args.path} is a file, not a folder.`);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const lines = [];
  for (const e of entries.slice(0, MAX_LIST)) {
    if (e.isDirectory()) lines.push(`[folder] ${e.name}`);
    else {
      let size = "";
      try { size = fmtSize((await fsp.stat(path.join(dir, e.name))).size); } catch (_) { /* skip */ }
      lines.push(`${e.name} (${size})`);
    }
  }
  const more = entries.length > MAX_LIST ? `\n(and ${entries.length - MAX_LIST} more)` : "";
  return `${dir}\n${lines.join("\n") || "(empty)"}${more}`;
}

async function findFiles(args, folders) {
  const want = String(args.name || "").trim().toLowerCase();
  if (!want) throw new LaptopError("Say what part of the file name to look for.");
  const roots = args.folder ? [await resolveAllowed(args.folder, folders)] : folders;
  const found = [];
  let visited = 0;
  async function walk(dir, depth) {
    if (found.length >= 100 || visited > 20000 || depth > 6) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      visited += 1;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(full, depth + 1);
      } else if (e.name.toLowerCase().includes(want)) {
        found.push(full);
        if (found.length >= 100) return;
      }
    }
  }
  for (const r of roots) await walk(r, 0);
  if (!found.length) return `No files with "${args.name}" in the name.`;
  return `${found.length}${found.length >= 100 ? "+" : ""} found:\n` + found.join("\n");
}

async function readFile(args, folders) {
  const file = await resolveAllowed(args.path, folders);
  const stat = await fsp.stat(file);
  if (stat.isDirectory()) throw new LaptopError(`${args.path} is a folder. Use list_folder.`);
  if (stat.size > MAX_READ_BYTES) throw new LaptopError(`${path.basename(file)} is ${fmtSize(stat.size)}, too big to read (limit 2 MB).`);
  const data = await fsp.readFile(file);
  if (data.subarray(0, 8000).includes(0)) throw new LaptopError(`${path.basename(file)} is not a text file. Ocean can read text, code, CSV, JSON and HTML files.`);
  const text = data.toString("utf8");
  const cut = text.length > MAX_TEXT ? `\n\n(Only the first ${MAX_TEXT} characters of ${text.length} are shown.)` : "";
  return `<file name="${path.basename(file)}" path="${file}">\n${text.slice(0, MAX_TEXT)}\n</file>${cut}`;
}

async function writeFile(args, folders, confirm) {
  const target = await resolveAllowed(args.path, folders, { mustExist: false });
  const exists = fs.existsSync(target);
  if (exists && (await fsp.stat(target)).isDirectory()) throw new LaptopError(`${args.path} is a folder.`);
  if (exists && !args.overwrite) throw new LaptopError(`${path.basename(target)} already exists. Ask Gudani before replacing it, then write again with overwrite set to true.`);
  const content = String(args.content ?? "");
  const preview = content.split(/\r?\n/).slice(0, 8).join("\n").slice(0, 600);
  const ok = await confirm({
    title: exists ? "Replace a file?" : "Save a new file?",
    message: `Ocean wants to ${exists ? "replace" : "create"} this file:\n${target}`,
    detail: `${fmtSize(Buffer.byteLength(content))}. It starts with:\n\n${preview}`,
  });
  if (!ok) throw new LaptopError("Gudani said no. The file was not saved.");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, "utf8");
  return `Saved ${target} (${fmtSize(Buffer.byteLength(content))}).`;
}

function commandExists(cmd) {
  const r = spawnSync(IS_WIN ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0;
}

// Opens a console program in a new, visible window. A detached process on
// Windows has no window at all, so "start" is used, with the command line
// written out exactly (Node's own quoting broke the "start" title before).
function launchInNewWindow(title, commandLine, cwd) {
  const safeTitle = String(title).replace(/["&|<>^%]/g, "");
  const child = spawn("cmd.exe", ["/d", "/c", `start "${safeTitle}" ${commandLine}`], {
    cwd, detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true,
  });
  child.on("error", () => {});
  child.unref();
}

function quoteArg(p) {
  if (/["%&|<>^]/.test(p)) throw new LaptopError("That path has characters Ocean cannot pass to Windows safely.");
  return `"${p}"`;
}

function launch(command, args, cwd) {
  const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: false, shell: false });
  child.on("error", () => {});
  child.unref();
}

async function openApp(args, folders, confirm, shell) {
  const app = String(args.app || "");
  const target = args.path ? await resolveAllowed(args.path, folders) : null;
  const names = { vscode: "VS Code", explorer: "File Explorer", notepad: "Notepad", chrome: "Chrome", terminal: "Terminal" };
  if (!names[app]) throw new LaptopError(`Ocean can open: ${Object.values(names).join(", ")}.`);
  const ok = await confirm({
    title: "Open an app?",
    message: `Ocean wants to open ${names[app]}${target ? ` with:\n${target}` : "."}`,
  });
  if (!ok) throw new LaptopError("Gudani said no.");
  if (!IS_WIN) {
    if (target) await shell.openPath(target);
    return `Opened ${names[app]} (test mode, not Windows).`;
  }
  const cwd = target && fs.statSync(target).isDirectory() ? target : os.homedir();
  if (app === "vscode") {
    if (!commandExists("code")) throw new LaptopError("VS Code is not installed, or its 'code' command is not set up.");
    launch("cmd.exe", ["/c", "code", target || "."], cwd);
  } else if (app === "explorer") launch("explorer.exe", target ? [target] : [], cwd);
  else if (app === "notepad") launch("notepad.exe", target ? [target] : [], cwd);
  else if (app === "chrome") launch("cmd.exe", ["/c", "start", "chrome"], cwd);
  else if (app === "terminal") {
    if (commandExists("wt")) launch("wt.exe", ["-d", cwd], cwd);
    else launchInNewWindow("Ocean terminal", "cmd.exe", cwd);
  }
  return `Opened ${names[app]}${target ? ` with ${target}` : ""}.`;
}

function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

// What Claude Code may do on its own while Ocean runs it in the background.
// Gudani chose: edit files plus safe commands; nothing that deletes or pushes.
const CLAUDE_ALLOWED = [
  "Read", "Edit", "Write", "Glob", "Grep",
  "Bash(npm *)", "Bash(npx *)", "Bash(node *)", "Bash(python *)", "Bash(py *)",
  "Bash(pip *)", "Bash(pytest *)", "Bash(git status *)", "Bash(git diff *)",
].join(",");
const CLAUDE_DENIED = [
  "Bash(rm *)", "Bash(rmdir *)", "Bash(del *)", "Bash(erase *)", "Bash(rd *)",
  "Bash(git push *)", "Bash(git reset *)", "Bash(git clean *)", "Bash(Remove-Item *)",
].join(",");
const CLAUDE_RULES = "You are working for Ocean, Gudani's assistant, with nobody watching live. " +
  "Do the whole task without asking questions. Never delete files. " +
  "When you finish, end with a short plain summary: what you did, which files you created or changed, and the result of any test you ran.";
const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;

function findClaude() {
  const r = spawnSync(IS_WIN ? "where" : "which", ["claude"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /\.exe$/i.test(l)) || lines.find((l) => /\.(cmd|bat)$/i.test(l)) || lines[0] || null;
}

function cmdQuote(s) {
  if (/["%\r\n]/.test(s)) throw new LaptopError("A Claude Code setting has characters Windows cannot pass safely.");
  return `"${s}"`;
}

function describeToolUse(block) {
  const i = block.input || {};
  const file = i.file_path || i.path || i.notebook_path || "";
  const short = (p) => String(p).split(/[\\/]/).slice(-2).join("/");
  switch (block.name) {
    case "Write": return `Writing ${short(file)}`;
    case "Edit": case "MultiEdit": return `Editing ${short(file)}`;
    case "Read": return `Reading ${short(file)}`;
    case "Bash": return `Running: ${String(i.command || "").slice(0, 120)}`;
    case "Glob": case "Grep": return `Searching for ${String(i.pattern || "").slice(0, 60)}`;
    case "TodoWrite": return "Planning the steps";
    default: return block.name;
  }
}

async function claudeCode(args, folders, confirm, progress) {
  const folder = await resolveAllowed(args.folder, folders);
  if (!fs.statSync(folder).isDirectory()) throw new LaptopError(`${args.folder} is not a folder.`);
  const task = String(args.task || "").trim();
  if (!task) throw new LaptopError("No task was given for Claude Code.");
  const exe = findClaude();
  if (!exe) {
    throw new LaptopError("Claude Code is not installed on this laptop. Install it from https://claude.com/claude-code, sign in with the Max plan, then try again.");
  }
  const ok = await confirm({
    title: "Start Claude Code?",
    message: `Ocean wants Claude Code to work in:\n${folder}`,
    detail: `It may create and edit files there and run npm, node, python, pip, pytest and git status/diff. It cannot delete files or push to GitHub.\n\nTask:\n${task.slice(0, 1500)}`,
  });
  if (!ok) throw new LaptopError("Gudani said no. Claude Code was not started.");

  const flags = [
    "-p", "Carry out the task given on standard input.",
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", CLAUDE_ALLOWED,
    "--disallowedTools", CLAUDE_DENIED,
    "--append-system-prompt", CLAUDE_RULES,
  ];
  let child;
  if (IS_WIN && /\.(cmd|bat)$/i.test(exe)) {
    // A .cmd launcher has to go through cmd.exe; write the line out exactly.
    const line = [cmdQuote(exe), ...flags.map(cmdQuote)].join(" ");
    child = spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { cwd: folder, windowsHide: true, windowsVerbatimArguments: true });
  } else {
    child = spawn(exe, flags, { cwd: folder, windowsHide: true });
  }

  return await new Promise((resolve) => {
    const files = new Set();
    const commands = []; // { id, command, output, failed }
    const steps = [];
    let result = null;
    let buffer = "";
    let stderr = "";
    let finished = false;
    const done = (value) => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      progress("Stopped: Claude Code took longer than 30 minutes.");
      try { child.kill(); } catch (_) { /* gone */ }
    }, CLAUDE_TIMEOUT_MS);

    const note = (text) => { steps.push(text); if (steps.length > 60) steps.shift(); progress(text); };
    note("Claude Code started");
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (_) { continue; }
        if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content) && !ev.parent_tool_use_id) {
          for (const block of ev.message.content) {
            if (block.type !== "tool_use") continue;
            const i = block.input || {};
            if (["Write", "Edit", "MultiEdit"].includes(block.name) && i.file_path) files.add(i.file_path);
            if (block.name === "Bash" && i.command) commands.push({ id: block.id, command: String(i.command).slice(0, 200), output: "", failed: false });
            note(describeToolUse(block));
          }
        } else if (ev.type === "user" && ev.message && Array.isArray(ev.message.content) && !ev.parent_tool_use_id) {
          // Command output comes back as a tool result; keep the end of it as proof.
          for (const block of ev.message.content) {
            if (block.type !== "tool_result") continue;
            const cmd = commands.find((c) => c.id && c.id === block.tool_use_id);
            if (!cmd) continue;
            const text = Array.isArray(block.content)
              ? block.content.map((c) => (c && c.text) || "").join("\n")
              : String(block.content || "");
            cmd.output = text.trim().slice(-400);
            cmd.failed = !!block.is_error;
          }
        } else if (ev.type === "result") {
          result = ev;
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    child.on("error", (err) => done({ ok: false, message: `Claude Code could not start: ${err.message}` }));
    child.on("close", (code) => {
      const parts = [];
      if (result) {
        parts.push(result.is_error ? "Claude Code finished with an error." : "Claude Code finished.");
        if (result.result) parts.push(`Its summary:\n${String(result.result).slice(0, 8000)}`);
      } else {
        parts.push(`Claude Code stopped without finishing (exit code ${code}).`);
        if (/out of memory/i.test(stderr)) parts.push("It ran out of memory. Closing other programs, such as Ollama, may help.");
        else if (stderr.trim()) parts.push(`Last error output:\n${stderr.trim().slice(-1500)}`);
      }
      if (files.size) parts.push("Files it created or changed:\n" + [...files].map((f) => `- ${f}`).join("\n"));
      if (commands.length) {
        parts.push("Commands it ran, with the end of their output:\n" + commands.slice(0, 30)
          .map((c) => `- ${c.command}${c.failed ? " (failed)" : ""}${c.output ? `\n  Output: ${c.output.replace(/\s+/g, " ").slice(0, 300)}` : ""}`).join("\n"));
      }
      const deniedRaw = result && Array.isArray(result.permission_denials) ? result.permission_denials : [];
      const denied = deniedRaw.slice(0, 10).map((d) => `${d.tool_name || "tool"} ${JSON.stringify(d.tool_input || {}).slice(0, 150)}`);
      if (denied.length) parts.push("Blocked by the safety rules:\n" + denied.map((d) => `- ${d}`).join("\n"));
      const finished = !!(result && !result.is_error);
      note(finished ? "Claude Code finished" : "Claude Code stopped");
      const report = {
        kind: "claude_code",
        status: finished ? "finished" : result ? "error" : "stopped",
        folder,
        summary: result && result.result ? String(result.result).slice(0, 3000) : (stderr.trim().slice(-600) || ""),
        files: [...files].slice(0, 50),
        commands: commands.slice(0, 30).map((c) => ({ command: c.command, output: c.output.slice(-300), failed: c.failed })),
        denied,
        steps: steps.slice(-40),
      };
      done({ ok: finished, message: parts.join("\n\n"), report });
    });
    child.stdin.end(task);
  }).then((r) => {
    if (!r.ok) throw new LaptopError(r.message, r.report);
    return { message: r.message, report: r.report };
  });
}

async function run(action, { folders, confirm, shell, progress = () => {} }) {
  const args = action.arguments || {};
  try {
    let message;
    switch (action.name) {
      case "list_folder": message = await listFolder(args, folders); break;
      case "find_files": message = await findFiles(args, folders); break;
      case "read_file": message = await readFile(args, folders); break;
      case "write_file": message = await writeFile(args, folders, confirm); break;
      case "open_item": {
        const p = await resolveAllowed(args.path, folders);
        const err = await shell.openPath(p);
        if (err) throw new LaptopError(err);
        message = `Opened ${p}.`;
        break;
      }
      case "open_link": {
        const url = String(args.url || "");
        if (!/^https?:\/\//i.test(url)) throw new LaptopError("Only http and https addresses can be opened.");
        await shell.openExternal(url);
        message = `Opened ${url} in the browser.`;
        break;
      }
      case "open_app": message = await openApp(args, folders, confirm, shell); break;
      case "claude_code": message = await claudeCode(args, folders, confirm, progress); break;
      default: throw new LaptopError(`Ocean's Windows app does not know how to do "${action.name}".`);
    }
    if (message && typeof message === "object") {
      return { ok: true, message: String(message.message).slice(0, 19000), report: message.report || null };
    }
    return { ok: true, message: String(message).slice(0, 19000) };
  } catch (err) {
    const msg = err instanceof LaptopError ? err.message : `Something went wrong: ${err && err.message ? err.message : err}`;
    const out = { ok: false, message: msg.slice(0, 6000) };
    if (err instanceof LaptopError && err.report) out.report = err.report;
    return out;
  }
}

module.exports = { run, resolveAllowed, inside, LaptopError };
