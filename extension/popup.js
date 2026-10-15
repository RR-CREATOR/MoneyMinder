"use strict";

// MoneyMinder browser extension popup. Talks to the MoneyMinder server with a
// bearer token (no cookies cross over to a chrome-extension:// origin), stored
// in chrome.storage.local and restricted to trusted extension contexts. No
// external network calls are made beyond the API origin packaged at build time.

const DEFAULT_API = "http://localhost:3000";
const ACCOUNT_DISCLOSURE_VERSION = 2;
const DETECTION_ORIGINS = Object.freeze(["https://*/*"]);
const DETECTION_SCRIPT_ID = "purchase-detection";
const DETECTION_FILES = Object.freeze(["detect.js", "content.js"]);

let token = null;
let detectToggleInitialized = false;

// ---- storage helpers (promisified chrome.storage.local) -------------------

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}
function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function legacyHttpsPermissionOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin === DEFAULT_API
    ) {
      return null;
    }
    return url.origin + "/*";
  } catch {
    return null;
  }
}

async function purgeLegacyAccountState() {
  const legacy = await storageGet(["apiBase"]);
  await storageRemove(["token", "apiBase", "accountDisclosureVersion"]);
  const origin = legacyHttpsPermissionOrigin(legacy.apiBase);
  if (origin) {
    await chrome.permissions.remove({ origins: [origin] });
  }
}

async function ensureDetectionRegistered() {
  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [DETECTION_SCRIPT_ID],
  });
  if (registered.length) return false;
  await chrome.scripting.registerContentScripts([{
    id: DETECTION_SCRIPT_ID,
    matches: DETECTION_ORIGINS,
    excludeMatches: [DEFAULT_API + "/*"],
    js: DETECTION_FILES,
    runAt: "document_idle",
    persistAcrossSessions: true,
  }]);
  return true;
}

async function injectDetectionIntoActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const page = new URL((tab && tab.url) || "");
    if (!tab || !Number.isInteger(tab.id) || page.protocol !== "https:") return false;
    if (page.origin === DEFAULT_API) return false;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: DETECTION_FILES,
    });
    return true;
  } catch {
    return false;
  }
}

async function setDetectionEnabled(enabled) {
  if (!enabled) {
    const registered = await chrome.scripting.getRegisteredContentScripts({
      ids: [DETECTION_SCRIPT_ID],
    });
    if (registered.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [DETECTION_SCRIPT_ID] });
    }
    await storageSet({ detectEnabled: false });
    await chrome.permissions.remove({ origins: DETECTION_ORIGINS });
    return true;
  }

  if (!await chrome.permissions.request({ origins: DETECTION_ORIGINS })) {
    await storageSet({ detectEnabled: false });
    return false;
  }
  try {
    await ensureDetectionRegistered();
    await storageSet({ detectEnabled: true });
    await injectDetectionIntoActiveTab();
    return true;
  } catch {
    await storageSet({ detectEnabled: false });
    await chrome.permissions.remove({ origins: DETECTION_ORIGINS });
    return false;
  }
}

// ---- utilities ------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function operationFor(previous, body) {
  const signature = JSON.stringify(body || {});
  return previous && previous.signature === signature
    ? previous
    : Object.freeze({ signature, key: crypto.randomUUID() });
}

async function storedOperation(name, body) {
  const saved = await chrome.storage.session.get(name);
  const next = operationFor(saved[name], body);
  if (next !== saved[name]) await chrome.storage.session.set({ [name]: next });
  return next;
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rupee(n) {
  let v = Number(n);
  if (!Number.isFinite(v) || Object.is(v, -0)) v = 0;
  return "₹" + v.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function $(id) {
  return document.getElementById(id);
}

function showView(name) {
  $("login-view").hidden = name !== "login";
  $("dashboard-view").hidden = name !== "dashboard";
  $("loading").hidden = name !== "loading";
}

// ---- API helper -----------------------------------------------------------

class AuthError extends Error {}

async function api(path, {
  method = "GET",
  body,
  auth = true,
  idempotencyKey = "",
} = {}) {
  const headers = { "X-Client": "extension" };
  if (auth && token) headers["Authorization"] = "Bearer " + token;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const opts = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(DEFAULT_API + path, opts);
  if (res.status === 401) {
    // Token rejected/expired — drop it and bounce to login.
    token = null;
    await storageRemove("token");
    showView("login");
    throw new AuthError("Not authenticated");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && data.error) || "Something went wrong";
    throw new Error(msg);
  }
  return data;
}

// ---- login ----------------------------------------------------------------

function setError(el, msg) {
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
  } else {
    el.textContent = msg;
    el.hidden = false;
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const errEl = $("login-error");
  setError(errEl, "");
  const consent = $("login-consent");
  if (!consent.checked) {
    setError(errEl, "Review the data disclosure and check the consent box before logging in.");
    return;
  }
  const username = $("login-username").value.trim();
  const password = $("login-password").value;
  if (!username || !password) {
    setError(errEl, "Enter your username and password.");
    return;
  }
  const btn = $("login-submit");
  btn.disabled = true;
  try {
    const data = await api("/api/login", {
      method: "POST",
      auth: false,
      body: { username, password },
    });
    if (!data || !data.token) {
      setError(errEl, "Login failed — no token returned.");
      return;
    }
    token = data.token;
    await storageSet({
      token,
      accountDisclosureVersion: ACCOUNT_DISCLOSURE_VERSION,
    });
    consent.checked = false;
    await initDetectToggle();
    await openDashboard();
  } catch (err) {
    if (err instanceof AuthError) {
      setError(errEl, "Invalid username or password.");
    } else {
      setError(errEl, err.message || "Could not log in.");
    }
  } finally {
    btn.disabled = false;
  }
}

// ---- dashboard ------------------------------------------------------------

function renderSummary(s) {
  $("spent-amount").textContent = rupee(s.spent);
  $("daily-amount").textContent = rupee(s.dailyBudget);

  const pill = $("track-pill");
  pill.classList.remove("ok", "over");
  if (s.onTrack) {
    pill.textContent = "On track";
    pill.classList.add("ok");
  } else {
    pill.textContent = "Over pace";
    pill.classList.add("over");
  }

  const cats = s.categories || {};
  const order = ["food", "travel", "housing", "misc"];
  const html = order
    .map(
      (k) =>
        '<div class="cat"><span class="cat-name">' +
        escapeHtml(k) +
        '</span><span class="cat-val">' +
        rupee(cats[k]) +
        "</span></div>"
    )
    .join("");
  $("categories").innerHTML = html;
}

function balanceMarkup(balance) {
  const v = Number(balance) || 0;
  if (Math.abs(v) < 0.005) {
    return '<span class="hh-bal settled">settled</span>';
  }
  if (v > 0) {
    return '<span class="hh-bal owed">owed ' + rupee(v) + "</span>";
  }
  return '<span class="hh-bal owe">owe ' + rupee(-v) + "</span>";
}

function renderHouseholds(households) {
  const listEl = $("households-list");
  if (!households.length) {
    listEl.innerHTML = '<div class="muted small">No households yet.</div>';
  } else {
    listEl.innerHTML = households
      .map(
        (h) =>
          '<div class="hh"><span class="hh-name">' +
          escapeHtml(h.name) +
          "</span>" +
          balanceMarkup(h.balance) +
          "</div>"
      )
      .join("");
  }

  // Populate the quick-expense dropdown.
  const sel = $("expense-household");
  if (!households.length) {
    sel.innerHTML = '<option value="">No households</option>';
    sel.disabled = true;
    $("expense-submit").disabled = true;
  } else {
    sel.disabled = false;
    $("expense-submit").disabled = false;
    sel.innerHTML = households
      .map(
        (h) =>
          '<option value="' +
          escapeHtml(h.id) +
          '">' +
          escapeHtml(h.name) +
          "</option>"
      )
      .join("");
  }
}

async function loadDashboardData() {
  const [summary, hh] = await Promise.all([
    api("/api/summary"),
    api("/api/households"),
  ]);
  renderSummary(summary);
  renderHouseholds((hh && hh.households) || []);
}

async function openDashboard() {
  showView("loading");
  try {
    await loadDashboardData();
    showView("dashboard");
    await maybeShowDetected();
  } catch (err) {
    // AuthError already redirected to login inside api().
    if (!(err instanceof AuthError)) {
      // Surface other failures on the dashboard but still show it.
      showView("dashboard");
      setError($("expense-error"), err.message || "Could not load data.");
    }
  }
}

// ---- detected purchase (from the content script) --------------------------

let detected = null;
let detectedTabId = null;

// If the page in the active tab looked like a purchase, show a one-tap card to
// track it. The candidate was put in session storage by the service worker.
async function maybeShowDetected() {
  const card = $("detected-card");
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== "number") return;
    detectedTabId = tab.id;

    const storeKey = "spend_" + tab.id;
    const got = await chrome.storage.session.get(storeKey);
    const cand = got[storeKey];
    if (!cand || !(Number(cand.amount) > 0)) {
      card.hidden = true;
      return;
    }

    detected = cand;
    $("detected-amount").textContent = rupee(cand.amount);
    $("detected-merchant").textContent = cand.merchant || "this site";
    const cats = ["food", "travel", "housing", "misc", "other"];
    $("detected-category").value = cats.includes(cand.category) ? cand.category : "other";
    setError($("detected-error"), "");
    card.hidden = false;
  } catch (e) {
    card.hidden = true;
  }
}

async function clearDetected() {
  $("detected-card").hidden = true;
  detected = null;
  if (typeof detectedTabId !== "number") return;
  try {
    chrome.runtime.sendMessage({ type: "spend-clear", tabId: detectedTabId }, () => void chrome.runtime.lastError);
  } catch (e) {
    // Worker asleep; the storage removal below still clears the candidate.
  }
  try {
    await chrome.storage.session.remove("spend_" + detectedTabId);
    await chrome.storage.session.remove("operation_spend_" + detectedTabId);
  } catch (e) {
    /* ignore */
  }
}

async function handleTrackDetected() {
  if (!detected) return;
  const errEl = $("detected-error");
  setError(errEl, "");
  const btn = $("detected-track");
  btn.disabled = true;
  try {
    const body = {
      category: $("detected-category").value,
      amount: detected.amount,
      supplier: String(detected.merchant || "Web purchase").slice(0, 120),
      document: "Web",
      date: localDate(),
    };
    const operation = await storedOperation("operation_spend_" + detectedTabId, body);
    await api("/api/receipts", {
      method: "POST",
      body,
      idempotencyKey: operation.key,
    });
    await clearDetected();
    await loadDashboardData(); // reflect the new spend in the summary
  } catch (err) {
    if (!(err instanceof AuthError)) setError(errEl, err.message || "Could not track this.");
  } finally {
    btn.disabled = false;
  }
}

// On/off switch for page detection, read by the content script before it scans.
async function initDetectToggle() {
  if (detectToggleInitialized) return;
  const box = $("detect-toggle");
  const cfg = await storageGet({ detectEnabled: false });
  const persisted = cfg.detectEnabled === true;
  if (persisted && await chrome.permissions.contains({ origins: DETECTION_ORIGINS })) {
    try {
      if (await ensureDetectionRegistered()) await injectDetectionIntoActiveTab();
      box.checked = true;
    } catch {
      await setDetectionEnabled(false);
      box.checked = false;
    }
  } else {
    if (persisted) await setDetectionEnabled(false);
    box.checked = false;
  }
  box.addEventListener("change", async () => {
    const requested = box.checked;
    box.disabled = true;
    box.checked = requested && await setDetectionEnabled(requested);
    box.disabled = false;
  });
  detectToggleInitialized = true;
}

async function handleAddExpense(e) {
  e.preventDefault();
  const errEl = $("expense-error");
  setError(errEl, "");
  const id = $("expense-household").value;
  const description = $("expense-desc").value.trim();
  const amount = $("expense-amount").value;
  if (!id) {
    setError(errEl, "Pick a household first.");
    return;
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    setError(errEl, "Enter an amount greater than 0.");
    return;
  }
  const btn = $("expense-submit");
  btn.disabled = true;
  try {
    const body = { description: description || "Expense", amount: amt };
    const operation = await storedOperation("operation_expense", body);
    await api("/api/households/" + encodeURIComponent(id) + "/expenses", {
      method: "POST",
      body,
      idempotencyKey: operation.key,
    });
    await chrome.storage.session.remove("operation_expense");
    // Clear inputs and refresh balances.
    $("expense-desc").value = "";
    $("expense-amount").value = "";
    await loadDashboardData();
  } catch (err) {
    if (!(err instanceof AuthError)) {
      setError(errEl, err.message || "Could not add expense.");
    }
  } finally {
    btn.disabled = false;
  }
}

async function handleLogout() {
  const btn = $("logout");
  const errEl = $("expense-error");
  btn.disabled = true;
  setError(errEl, "");
  try {
    await api("/api/logout", { method: "POST" });
    token = null;
    await storageRemove("token");
    showView("login");
  } catch (err) {
    if (!(err instanceof AuthError)) {
      setError(errEl, "Could not log out. Check your connection and try again.");
    }
  } finally {
    btn.disabled = false;
  }
}

function handleOpenApp() {
  window.open(DEFAULT_API, "_blank");
}

// ---- boot -----------------------------------------------------------------

async function init() {
  const disclosure = await storageGet({ accountDisclosureVersion: 0 });
  const disclosureAccepted =
    disclosure.accountDisclosureVersion === ACCOUNT_DISCLOSURE_VERSION;
  if (!disclosureAccepted) {
    await purgeLegacyAccountState();
  }
  const stored = disclosureAccepted ? await storageGet(["token"]) : {};
  token = stored.token || null;

  // Wire up events (no inline handlers — MV3 CSP forbids them).
  $("login-form").addEventListener("submit", handleLogin);
  $("expense-form").addEventListener("submit", handleAddExpense);
  $("open-app").addEventListener("click", handleOpenApp);
  $("logout").addEventListener("click", handleLogout);
  $("detected-track").addEventListener("click", handleTrackDetected);
  $("detected-dismiss").addEventListener("click", clearDetected);

  if (!disclosureAccepted) {
    showView("login");
  } else if (token) {
    await initDetectToggle();
    await openDashboard();
  } else {
    await initDetectToggle();
    showView("login");
  }
}

document.addEventListener("DOMContentLoaded", init);
