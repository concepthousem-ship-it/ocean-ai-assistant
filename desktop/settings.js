"use strict";

const $ = (id) => document.getElementById(id);

function renderFolders(folders) {
  const list = $("folders");
  list.replaceChildren();
  if (!folders.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No folders yet. Add one, for example Documents\\Clients.";
    list.appendChild(li);
    return;
  }
  for (const f of folders) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = f;
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => renderFolders(await window.oceanSettings.removeFolder(f)));
    li.append(span, remove);
    list.appendChild(li);
  }
}

function renderOllama(cfg) {
  const s = cfg.ollama;
  const status = $("ollama-status");
  const has = s.models.some((m) => m === cfg.ollamaModel || m.split(":")[0] === cfg.ollamaModel);
  if (!s.running) {
    status.textContent = "Ollama is not running on this laptop.";
  } else if (!has) {
    status.textContent = `Ollama is running, but ${cfg.ollamaModel} is not downloaded yet.` + (s.models.length ? ` Downloaded: ${s.models.join(", ")}.` : "");
  } else {
    status.textContent = `Ready: Ollama is running with ${cfg.ollamaModel}.`;
    status.className = "ok";
  }
  $("ollama-help").hidden = s.running && has;
  $("pull-cmd").textContent = `ollama pull ${cfg.ollamaModel}`;
}

async function start() {
  const cfg = await window.oceanSettings.get();
  renderFolders(cfg.folders);
  $("model").value = cfg.ollamaModel;
  $("open-at-login").checked = !!cfg.openAtLogin;
  $("open-at-login").addEventListener("change", (e) => window.oceanSettings.set({ openAtLogin: e.target.checked }));
  $("version").textContent = `Ocean for Windows, version ${cfg.version}`;
  renderOllama(cfg);
  const showUpdate = (st) => {
    $("update-status").textContent = st.message || "Ocean checks for updates by itself.";
    $("install-update").hidden = st.status !== "ready";
    if (st.status === "ready") $("install-update").textContent = `Restart to update to ${st.version}`;
  };
  showUpdate(await window.oceanSettings.updateState());
  window.oceanSettings.onUpdateStatus(showUpdate);
  $("check-update").addEventListener("click", async () => showUpdate(await window.oceanSettings.checkUpdate()));
  $("install-update").addEventListener("click", () => window.oceanSettings.installUpdate());
  $("add-folder").addEventListener("click", async () => renderFolders(await window.oceanSettings.addFolder()));
  $("save-model").addEventListener("click", async () => {
    await window.oceanSettings.set({ ollamaModel: $("model").value.trim() });
    renderOllama(await window.oceanSettings.get());
  });
  $("ollama-link").addEventListener("click", (e) => { e.preventDefault(); window.oceanSettings.openLink("https://ollama.com/download"); });
}

start();
