"use strict";

// Service worker: keeps the latest detected purchase per tab and reflects it on
// the toolbar badge. Candidates live in session storage (cleared when the browser
// closes) and are keyed by tab id, so each tab shows only its own detection.

const BADGE_TEXT = "₹";
const BADGE_COLOR = "#4f46e5";

// Keep persisted bearer tokens inaccessible to content scripts.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(() => {});

function key(tabId) {
  return "spend_" + tabId;
}

async function setDetected(tabId, candidate) {
  await chrome.storage.session.set({ [key(tabId)]: candidate });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
  await chrome.action.setBadgeText({ tabId, text: BADGE_TEXT });
}

async function clearDetected(tabId) {
  await chrome.storage.session.remove(key(tabId));
  await chrome.action.setBadgeText({ tabId, text: "" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // From the content script: tab id comes from the trusted sender, never the page.
  const senderTab = sender.tab && sender.tab.id;
  if (msg.type === "detect-enabled" && typeof senderTab === "number") {
    chrome.storage.local
      .get({ detectEnabled: false })
      .then((cfg) => sendResponse(cfg.detectEnabled === true))
      .catch(() => sendResponse(false));
    return true;
  }
  if (msg.type === "spend-detected" && typeof senderTab === "number" && msg.candidate) {
    setDetected(senderTab, msg.candidate).catch(() => {});
    return;
  }
  if (msg.type === "spend-none" && typeof senderTab === "number") {
    clearDetected(senderTab).catch(() => {});
    return;
  }

  // spend-clear comes only from our popup. An extension page has no sender.tab,
  // so a content script (which always has one) can never clear another tab.
  if (msg.type === "spend-clear" && !sender.tab && typeof msg.tabId === "number") {
    clearDetected(msg.tabId).catch(() => {});
  }
});

// Tidy up when a tab goes away.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(key(tabId)).catch(() => {});
});
