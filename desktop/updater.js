"use strict";

/* Automatic updates for Ocean for Windows.

   1. Every few hours (and at start) the app reads latest.json from the
      update site, for example https://updates.digivireo.com/ocean/latest.json.
   2. If it names a newer version, the installer is downloaded in the
      background and checked against the SHA-512 in latest.json.
   3. Gudani is told it is ready. It installs when he chooses "Restart to
      update", or by itself the next time he quits Ocean. The installer runs
      silently and opens Ocean again afterwards. */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function newer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function createUpdater({ app, baseUrl, onReady, onStatus = () => {}, platform = process.platform }) {
  const state = { status: "idle", message: "", version: null, file: null, checkedAt: null };
  let busy = false;

  const set = (status, message, extra = {}) => {
    Object.assign(state, { status, message }, extra);
    onStatus({ ...state });
  };

  async function check({ manual = false } = {}) {
    if (busy) return { ...state };
    if (state.status === "ready") return { ...state };
    if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/.test(baseUrl)) { set("off", "Updates are switched off: the update address must start with https://"); return { ...state }; }
    busy = true;
    try {
      set("checking", "Checking for updates...");
      const r = await fetch(`${baseUrl}/latest.json?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`The update site answered with status ${r.status}.`);
      const info = await r.json();
      state.checkedAt = new Date().toISOString();
      if (!info || typeof info.version !== "string" || typeof info.file !== "string" || !/^[a-f0-9]{128}$/.test(info.sha512 || "")) {
        throw new Error("The update information is not in the expected form.");
      }
      if (!/^[\w.\-]+\.exe$/.test(info.file)) throw new Error("The update file name is not allowed.");
      const parts = Array.isArray(info.parts) && info.parts.length ? info.parts.map((p) => String(p && p.name || "")) : [info.file];
      if (parts.some((n) => !/^[\w.\-]+$/.test(n)) || parts.length > 40) throw new Error("The update part names are not allowed.");
      if (!newer(info.version, app.getVersion())) {
        set("current", `Ocean is up to date (version ${app.getVersion()}).`);
        return { ...state };
      }
      if (platform !== "win32") {
        set("available", `Version ${info.version} is available (installs on Windows only).`, { version: info.version });
        return { ...state };
      }
      set("downloading", `Downloading version ${info.version}...`, { version: info.version });
      const dest = path.join(app.getPath("temp"), `Ocean-Setup-${info.version}.exe`);
      await download(parts.map((n) => `${baseUrl}/${n}`), dest, info.sha512, info.size);
      set("ready", `Version ${info.version} is ready. It installs when you restart Ocean.`, { version: info.version, file: dest });
      onReady({ ...state });
    } catch (err) {
      set("error", `Could not check for updates: ${err.message}`);
      if (!manual) { /* try again at the next scheduled check */ }
    } finally {
      busy = false;
    }
    return { ...state };
  }

  // The installer may be split into parts (the update site takes small
  // uploads); they are joined in order and checked as one file.
  async function download(urls, dest, sha512, size) {
    const hash = crypto.createHash("sha512");
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    let bytes = 0;
    try {
      for (const url of urls) {
        const r = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
        if (!r.ok || !r.body) throw new Error(`The download failed with status ${r.status}.`);
        for await (const chunk of r.body) {
          hash.update(chunk);
          bytes += chunk.length;
          if (!out.write(chunk)) await new Promise((res) => out.once("drain", res));
        }
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    } catch (err) {
      out.destroy();
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    const digest = hash.digest("hex");
    if (digest !== sha512 || (size && bytes !== size)) {
      fs.rmSync(tmp, { force: true });
      throw new Error("The downloaded file did not match its checksum, so it was thrown away.");
    }
    fs.renameSync(tmp, dest);
  }

  // Runs the downloaded installer silently, then Ocean opens again by itself.
  function install({ relaunch = true } = {}) {
    if (state.status !== "ready" || !state.file || !fs.existsSync(state.file)) return false;
    const child = spawn(state.file, relaunch ? ["/S", "--relaunch"] : ["/S"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    state.status = "installing";
    return true;
  }

  function start() {
    setTimeout(() => check(), 15000);
    setInterval(() => check(), CHECK_EVERY_MS);
  }

  return { check, install, start, state: () => ({ ...state }), newer };
}

module.exports = { createUpdater, newer };
