"use strict";

// Clicking the Ocean icon (or Alt+O) opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.create({
    id: "ocean-ask-selection",
    title: "Ask Ocean about \"%s\"",
    contexts: ["selection"],
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Right-click on selected text: open the panel with that text ready to ask about.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "ocean-ask-selection" || !tab) return;
  await chrome.storage.session.set({ pendingSelection: (info.selectionText || "").slice(0, 4000) });
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (_) { /* the panel may already be open */ }
  chrome.runtime.sendMessage({ type: "selection-ready" }).catch(() => {});
});
