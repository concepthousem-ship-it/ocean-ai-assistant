"use strict";

/* The only things Ocean's web page and the settings window can ask the
   Windows app to do. The main process checks who is asking every time. */

const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("oceanSettings", {
    get: () => ipcRenderer.invoke("settings:get"),
    addFolder: () => ipcRenderer.invoke("settings:add-folder"),
    removeFolder: (folder) => ipcRenderer.invoke("settings:remove-folder", String(folder)),
    set: (changes) => ipcRenderer.invoke("settings:set", changes),
    openLink: (url) => ipcRenderer.invoke("settings:open-link", String(url)),
    checkUpdate: () => ipcRenderer.invoke("settings:update-check"),
    updateState: () => ipcRenderer.invoke("settings:update-state"),
    installUpdate: () => ipcRenderer.invoke("settings:update-install"),
    onUpdateStatus: (cb) => ipcRenderer.on("settings:update-status", (_e, st) => cb(st)),
  });
} else {
  contextBridge.exposeInMainWorld("oceanDesktop", {
    info: () => ipcRenderer.invoke("ocean:info"),
    run: (action) => ipcRenderer.invoke("ocean:action", {
      name: String(action && action.name || ""),
      arguments: action && typeof action.arguments === "object" ? JSON.parse(JSON.stringify(action.arguments)) : {},
    }),
    ollamaChat: (messages) => ipcRenderer.invoke("ocean:ollama-chat", JSON.parse(JSON.stringify(messages || []))),
    openSettings: () => ipcRenderer.invoke("ocean:open-settings"),
    // Live progress lines from long laptop tasks such as Claude Code.
    onProgress: (callback) => {
      const listener = (_event, text) => callback(String(text));
      ipcRenderer.on("ocean:progress", listener);
      return () => ipcRenderer.removeListener("ocean:progress", listener);
    },
  });
}
