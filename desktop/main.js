"use strict";

/* Ocean for Windows: Ocean in its own window, in the system tray, and on
   Ctrl+Shift+O, with access to the laptop through the laptop tools. */

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, shell, nativeImage, Notification } = require("electron");
const fs = require("fs");
const path = require("path");
const laptop = require("./laptop");
const { createUpdater } = require("./updater");

const DEFAULT_UPDATE_URL = "https://updates.digivireo.com/ocean";

const DEFAULT_SERVER = process.env.OCEAN_SERVER || "https://ocean.digivireo.com";
const OLLAMA = "http://127.0.0.1:11434";
const ICON = path.join(__dirname, "icons", "icon.png");

let win = null;
let settingsWin = null;
let tray = null;
let quitting = false;
let updater = null;

/* --- Settings saved on the laptop ---------------------------------------- */

const configFile = () => path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch (_) { /* first run */ }
  return {
    server: saved.server || DEFAULT_SERVER,
    folders: Array.isArray(saved.folders) ? saved.folders.filter((f) => typeof f === "string") : [],
    ollamaModel: saved.ollamaModel || "llama3.2:3b",
    openAtLogin: saved.openAtLogin === true,
    updateUrl: saved.updateUrl || DEFAULT_UPDATE_URL,
  };
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), "utf8");
}

let config = null;

function serverOrigin() {
  try { return new URL(config.server).origin; } catch (_) { return ""; }
}

/* --- Windows ---------------------------------------------------------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 380,
    minHeight: 500,
    title: "Ocean",
    icon: ICON,
    backgroundColor: "#FFFFFF",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.once("ready-to-show", () => { if (!process.argv.includes("--hidden")) win.show(); });
  win.loadURL(config.server);

  // Ocean's own pages stay in the app; every other link opens in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== serverOrigin()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    // The microphone is needed for speaking to Ocean; nothing else is granted.
    const fromOcean = new URL(wc.getURL()).origin === serverOrigin();
    callback(fromOcean && (permission === "media" || permission === "clipboard-sanitized-write"));
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) {
      win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offlinePage(desc))}`);
    }
  });
  win.on("close", (event) => {
    if (!quitting) { event.preventDefault(); win.hide(); }
  });
}

function offlinePage(reason) {
  return `<!doctype html><meta charset="utf-8"><title>Ocean</title>
  <body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#0B1A33">
  <div style="text-align:center;max-width:420px"><h2>Ocean could not be reached</h2>
  <p style="color:#5B6B86">Check your internet connection. (${String(reason).replace(/[<>&]/g, "")})</p>
  <p style="color:#5B6B86">Then right-click the Ocean icon in the tray and choose Reload.</p></div></body>`;
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win && win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 640,
    title: "Ocean settings",
    icon: ICON,
    parent: win || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  settingsWin.on("closed", () => { settingsWin = null; });
}

function buildTrayMenu() {
  const u = updater ? updater.state() : { status: "idle" };
  const items = [
    { label: "Open Ocean", click: showWindow },
    { label: "Settings", click: openSettings },
    { label: "Reload", click: () => { showWindow(); win.loadURL(config.server); } },
  ];
  if (u.status === "ready") items.push({ label: `Restart to update to ${u.version}`, click: restartToUpdate });
  items.push({ type: "separator" }, { label: "Quit Ocean", click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("Ocean (Ctrl+Shift+O)");
  buildTrayMenu();
  tray.on("click", toggleWindow);
}

function restartToUpdate() {
  if (updater && updater.install({ relaunch: true })) {
    quitting = true;
    app.quit();
  }
}

function startUpdater() {
  updater = createUpdater({
    app,
    baseUrl: process.env.OCEAN_UPDATE_URL || config.updateUrl,
    onStatus: (st) => {
      if (tray) buildTrayMenu();
      if (settingsWin) settingsWin.webContents.send("settings:update-status", st);
    },
    onReady: (st) => {
      if (Notification.isSupported()) {
        const n = new Notification({ title: "Ocean update ready", body: `Version ${st.version} is downloaded. Click to restart Ocean and install it now, or it installs next time you quit Ocean.`, icon: ICON });
        n.on("click", restartToUpdate);
        n.show();
      }
    },
  });
  updater.start();
}

/* --- Approval dialogs -------------------------------------------------------- */

async function confirm({ title, message, detail }) {
  // Automated tests set OCEAN_TEST_APPROVE to answer without a person.
  if (process.env.OCEAN_TEST_APPROVE === "yes") return true;
  if (process.env.OCEAN_TEST_APPROVE === "no") return false;
  showWindow();
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    title,
    message,
    detail: detail || "",
    buttons: ["Allow", "Don't allow"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

/* --- Bridge for Ocean's web page ------------------------------------------------ */

function fromOcean(event) {
  const url = event.senderFrame && event.senderFrame.url;
  try { return new URL(url).origin === serverOrigin() && event.sender === win.webContents; } catch (_) { return false; }
}

function fromSettings(event) {
  return settingsWin && event.sender === settingsWin.webContents;
}

async function ollamaStatus() {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { running: false, models: [] };
    const data = await r.json();
    return { running: true, models: (data.models || []).map((m) => m.name) };
  } catch (_) {
    return { running: false, models: [] };
  }
}

function registerBridge() {
  ipcMain.handle("ocean:info", async (event) => {
    if (!fromOcean(event) && !fromSettings(event)) throw new Error("Not allowed.");
    const ollama = await ollamaStatus();
    return {
      version: app.getVersion(),
      platform: process.platform,
      folders: config.folders,
      ollama: { ...ollama, model: config.ollamaModel },
    };
  });

  ipcMain.handle("ocean:action", async (event, action) => {
    if (!fromOcean(event)) throw new Error("Not allowed.");
    if (!action || typeof action.name !== "string") return { ok: false, message: "No action." };
    const progress = (text) => {
      try { event.sender.send("ocean:progress", String(text).slice(0, 300)); } catch (_) { /* window closed */ }
    };
    return laptop.run(action, { folders: config.folders, confirm, shell, progress });
  });

  ipcMain.handle("ocean:ollama-chat", async (event, messages) => {
    if (!fromOcean(event)) throw new Error("Not allowed.");
    const status = await ollamaStatus();
    if (!status.running) return { ok: false, message: "Ollama is not running on this laptop. Install it from https://ollama.com and open it." };
    if (!status.models.some((m) => m === config.ollamaModel || m.split(":")[0] === config.ollamaModel)) {
      return { ok: false, message: `The model ${config.ollamaModel} is not downloaded. In a terminal run: ollama pull ${config.ollamaModel}` };
    }
    const clean = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string")
      .slice(-30)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }));
    try {
      const r = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.ollamaModel, messages: clean, stream: false }),
        signal: AbortSignal.timeout(180000),
      });
      const data = await r.json();
      if (!r.ok) return { ok: false, message: data.error || `Ollama answered with status ${r.status}.` };
      return { ok: true, content: (data.message && data.message.content) || "", model: config.ollamaModel };
    } catch (err) {
      return { ok: false, message: `Ollama did not answer: ${err.message}` };
    }
  });

  ipcMain.handle("ocean:open-settings", (event) => {
    if (!fromOcean(event)) throw new Error("Not allowed.");
    openSettings();
    return true;
  });

  // Settings window only.
  ipcMain.handle("settings:get", async (event) => {
    if (!fromSettings(event)) throw new Error("Not allowed.");
    return { ...config, version: app.getVersion(), ollama: await ollamaStatus() };
  });
  ipcMain.handle("settings:add-folder", async (event) => {
    if (!fromSettings(event)) throw new Error("Not allowed.");
    const r = await dialog.showOpenDialog(settingsWin, { title: "Choose a folder Ocean may use", properties: ["openDirectory"] });
    if (r.canceled || !r.filePaths[0]) return config.folders;
    const chosen = r.filePaths[0];
    const root = path.parse(chosen).root;
    if (path.resolve(chosen) === path.resolve(root) || path.resolve(chosen) === path.resolve(require("os").homedir())) {
      await dialog.showMessageBox(settingsWin, { type: "warning", message: "Choose a more specific folder, such as Documents\\Clients, not a whole drive or your whole user folder." });
      return config.folders;
    }
    if (!config.folders.includes(chosen)) config.folders.push(chosen);
    saveConfig(config);
    return config.folders;
  });
  ipcMain.handle("settings:remove-folder", (event, folder) => {
    if (!fromSettings(event)) throw new Error("Not allowed.");
    config.folders = config.folders.filter((f) => f !== folder);
    saveConfig(config);
    return config.folders;
  });
  ipcMain.handle("settings:set", (event, changes) => {
    if (!fromSettings(event)) throw new Error("Not allowed.");
    if (changes && typeof changes.openAtLogin === "boolean") {
      config.openAtLogin = changes.openAtLogin;
      applyLoginItem();
    }
    if (changes && typeof changes.ollamaModel === "string" && /^[\w.:\-/]{1,80}$/.test(changes.ollamaModel)) config.ollamaModel = changes.ollamaModel;
    if (changes && typeof changes.server === "string" && /^https:\/\/[\w.-]+(:\d+)?$/.test(changes.server.replace(/\/+$/, ""))) {
      config.server = changes.server.replace(/\/+$/, "");
      if (win) win.loadURL(config.server);
    }
    saveConfig(config);
    return config;
  });
  ipcMain.handle("settings:update-check", async (event) => {
    if (!fromSettings(event)) throw new Error("Not allowed.");
    return updater ? updater.check({ manual: true }) : { status: "off", message: "Updates are not running." };
  });
  ipcMain.handle("settings:update-state", (event) => {
    if (!fromSettings(event)) throw new Error("Not allowed.");
    return updater ? updater.state() : { status: "off", message: "" };
  });
  ipcMain.handle("settings:update-install", (event) => {
    if (!fromSettings(event)) throw new Error("Not allowed.");
    restartToUpdate();
    return true;
  });
  ipcMain.handle("settings:open-link", (event, url) => {
    if (!fromSettings(event)) throw new Error("Not allowed.");
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
}

function applyLoginItem() {
  // Start Ocean hidden in the tray when Windows starts, if Gudani turned it on.
  try {
    app.setLoginItemSettings({ openAtLogin: !!config.openAtLogin, args: ["--hidden"] });
  } catch (_) { /* not supported here */ }
}

/* --- Start ---------------------------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(() => {
    config = loadConfig();
    if (process.env.OCEAN_SERVER) config.server = process.env.OCEAN_SERVER;
    if (process.env.OCEAN_TEST_FOLDERS) config.folders = process.env.OCEAN_TEST_FOLDERS.split(path.delimiter);
    Menu.setApplicationMenu(null);
    registerBridge();
    createWindow();
    createTray();
    startUpdater();
    globalShortcut.register("CommandOrControl+Shift+O", toggleWindow);
    app.setAppUserModelId("com.digivireo.ocean");
    applyLoginItem();
  });
  app.on("before-quit", () => {
    quitting = true;
    // A downloaded update installs quietly when Ocean is closed.
    if (updater && updater.state().status === "ready") updater.install({ relaunch: false });
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", () => { /* stay in the tray */ });
}
