"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionDir = __dirname;

function read(name) {
  return fs.readFileSync(path.join(extensionDir, name), "utf8");
}

function popupHarness(fetchImpl, { stored = {}, hostPermission = false } = {}) {
  const elements = new Map();
  const gets = [];
  const removed = [];
  const sets = [];
  const permissionRequests = [];
  const permissionRemovals = [];
  const registeredScripts = [];
  const scriptExecutions = [];
  let storedValues = { ...stored };
  let permissionGranted = hostPermission;
  let uuid = 0;
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        checked: false,
        disabled: false,
        hidden: false,
        textContent: "",
        addEventListener() {},
        classList: { add() {}, remove() {} },
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    URL,
    Date,
    crypto: {
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    },
    fetch: fetchImpl,
    chrome: {
      storage: {
        local: {
          get(keys, callback) {
            gets.push(keys);
            callback({ ...(Array.isArray(keys) ? {} : keys), ...storedValues });
          },
          set(value, callback) {
            sets.push(value);
            storedValues = { ...storedValues, ...value };
            callback();
          },
          remove(keys, callback) {
            removed.push(keys);
            callback();
          },
        },
      },
      permissions: {
        async contains() {
          return permissionGranted;
        },
        async request(value) {
          permissionRequests.push(value);
          permissionGranted = true;
          return true;
        },
        async remove(value) {
          permissionRemovals.push(value);
          permissionGranted = false;
          return true;
        },
      },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://shop.example/order/1" }];
        },
      },
      scripting: {
        async getRegisteredContentScripts() {
          return [...registeredScripts];
        },
        async registerContentScripts(scripts) {
          registeredScripts.push(...scripts);
        },
        async unregisterContentScripts({ ids }) {
          for (let index = registeredScripts.length - 1; index >= 0; index--) {
            if (ids.includes(registeredScripts[index].id)) registeredScripts.splice(index, 1);
          }
        },
        async executeScript(details) {
          scriptExecutions.push(details);
        },
      },
    },
    document: {
      addEventListener() {},
      getElementById: element,
    },
  });
  vm.runInContext(read("popup.js"), context, { filename: "extension/popup.js" });
  return {
    context,
    elements,
    gets,
    removed,
    sets,
    permissionRequests,
    permissionRemovals,
    registeredScripts,
    scriptExecutions,
  };
}

function evaluate(context, source) {
  return vm.runInContext(source, context);
}

test("runtime API target is the packaged build-time origin", () => {
  const { context } = popupHarness(async () => {
    throw new Error("unused");
  });

  assert.equal(evaluate(context, "DEFAULT_API"), "http://localhost:3000");
  assert.equal(evaluate(context, "typeof apiBase"), "undefined");
  assert.equal(evaluate(context, "typeof applyServer"), "undefined");
  assert.equal(evaluate(context, "typeof ensureHostPermission"), "undefined");
  assert.doesNotMatch(read("popup.html"), /id="signup-link"|open sign-up/i);
  assert.doesNotMatch(read("popup.js"), /handleSignup|register\.html/i);
});

test("login stays local until consent and then uses only the packaged API origin", async () => {
  const requests = [];
  const {
    context,
    elements,
    permissionRequests,
    removed,
    sets,
  } = popupHarness(async (url, options) => {
    requests.push({ url, options });
    const payload = url.endsWith("/api/login")
      ? { token: "issued-token" }
      : url.endsWith("/api/households")
        ? { households: [] }
        : { spent: 0, dailyBudget: 0, onTrack: true, categories: {} };
    return { status: 200, ok: true, async json() { return payload; } };
  });
  evaluate(context, "$('login-username').value = 'alice'");
  evaluate(context, "$('login-password').value = 'alice-password'");
  evaluate(context, "$('server-url').value = 'https://money.example'");
  const fieldReads = [];
  for (const id of ["login-username", "login-password", "server-url"]) {
    const element = elements.get(id);
    const value = element.value;
    Object.defineProperty(element, "value", {
      configurable: true,
      get() {
        fieldReads.push(id);
        return value;
      },
    });
  }

  await evaluate(context, "handleLogin({ preventDefault() {} })");

  assert.deepEqual(fieldReads, []);
  assert.equal(requests.length, 0);
  assert.deepEqual(permissionRequests, []);
  assert.deepEqual(removed, []);
  assert.deepEqual(sets, []);
  assert.match(elements.get("login-error").textContent, /disclosure|consent/i);

  const html = read("popup.html");
  assert.match(html, /username and password/i);
  assert.match(html, /authentication token/i);
  assert.match(html, /packaged.*server/i);
  assert.match(html, /budget.*household/i);
  assert.match(html, /optional page processing/i);
  assert.match(html, /continues until you disable it.*logged out/i);
  assert.match(html, /id="login-consent"[^>]*type="checkbox"[^>]*required/i);
  assert.doesNotMatch(html, /id="login-consent"[^>]*\schecked(?:\s|>)/i);
  assert.ok(html.indexOf('id="login-disclosure"') < html.indexOf('id="login-username"'));
  assert.doesNotMatch(html, /id="server-url"|class="server-details"/i);

  evaluate(context, "$('login-consent').checked = true");
  await evaluate(context, "handleLogin({ preventDefault() {} })");

  assert.deepEqual(permissionRequests, []);
  assert.equal(requests[0].url, "http://localhost:3000/api/login");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    username: "alice",
    password: "alice-password",
  });
  assert.ok(!sets.some((value) => Object.hasOwn(value, "apiBase")));
  assert.ok(sets.some((value) =>
    value.token === "issued-token" && value.accountDisclosureVersion === 2
  ));
  assert.deepEqual(fieldReads, ["login-username", "login-password"]);
  assert.equal(elements.get("login-consent").checked, false);
});

test("store listing reserves optional HTTPS permission for purchase detection", () => {
  const listing = fs.readFileSync(
    path.join(extensionDir, "..", "store-listing", "chrome-web-store", "listing.md"),
    "utf8",
  );
  const privacyPractices = fs.readFileSync(
    path.join(
      extensionDir,
      "..",
      "store-listing",
      "chrome-web-store",
      "privacy-practices.md",
    ),
    "utf8",
  );

  assert.match(listing, /packaged.*HTTPS.*server/i);
  assert.match(listing, /purchase detection/i);
  assert.match(listing, /optional HTTPS permission.*only.*purchase detection/i);
  assert.doesNotMatch(listing, /user-selected|non-default.*server|two user-controlled uses/i);
  assert.match(privacyPractices, /packaged.*HTTPS.*server/i);
  assert.doesNotMatch(privacyPractices, /configured server origin|user's configured/i);
});

test("a legacy custom-origin session is purged and its exact grant is revoked", async () => {
  const requests = [];
  const {
    context,
    elements,
    gets,
    removed,
    permissionRemovals,
    registeredScripts,
  } = popupHarness(
    async (url) => {
      requests.push(url);
      return { status: 200, ok: true, async json() { return {}; } };
    },
    {
      stored: {
        accountDisclosureVersion: 1,
        apiBase: "https://legacy.money.example",
        token: "legacy-token",
        detectEnabled: true,
      },
      hostPermission: true,
    },
  );

  await evaluate(context, "init()");

  assert.deepEqual(requests, []);
  assert.equal(evaluate(context, "token"), null);
  assert.equal(elements.get("login-view").hidden, false);
  assert.equal(elements.get("dashboard-view").hidden, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(gets)),
    [
      { accountDisclosureVersion: 0 },
      ["apiBase"],
    ],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(removed)), [
    ["token", "apiBase", "accountDisclosureVersion"],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(permissionRemovals)), [{
    origins: ["https://legacy.money.example/*"],
  }]);
  assert.ok(!permissionRemovals.some(({ origins }) =>
    origins.includes("https://*/*")
  ));
  assert.equal(registeredScripts.length, 0);
});

test("legacy cleanup never broadens revocation from an invalid stored origin", async () => {
  const {
    context,
    removed,
    permissionRemovals,
  } = popupHarness(
    async () => {
      throw new Error("unused");
    },
    {
      stored: {
        accountDisclosureVersion: 1,
        apiBase: "https://legacy.money.example/path?redirect=https://attacker.example",
        token: "legacy-token",
        detectEnabled: true,
      },
      hostPermission: true,
    },
  );

  await evaluate(context, "init()");

  assert.deepEqual(JSON.parse(JSON.stringify(removed)), [
    ["token", "apiBase", "accountDisclosureVersion"],
  ]);
  assert.deepEqual(permissionRemovals, []);
});

test("a session accepted under the current disclosure version can reconnect", async () => {
  const requests = [];
  const {
    context,
    elements,
    gets,
  } = popupHarness(
    async (url, options) => {
      requests.push({ url, options });
      const payload = url.endsWith("/api/households")
        ? { households: [] }
        : { spent: 0, dailyBudget: 0, onTrack: true, categories: {} };
      return { status: 200, ok: true, async json() { return payload; } };
    },
    {
      stored: {
        accountDisclosureVersion: 2,
        apiBase: "https://attacker.example",
        token: "accepted-token",
        detectEnabled: false,
      },
    },
  );

  await evaluate(context, "init()");

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "http://localhost:3000/api/summary",
      "http://localhost:3000/api/households",
    ],
  );
  assert.ok(requests.every(({ options }) =>
    options.headers.Authorization === "Bearer accepted-token"
  ));
  assert.equal(elements.get("dashboard-view").hidden, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(gets)),
    [
      { accountDisclosureVersion: 0 },
      ["token"],
      { detectEnabled: false },
    ],
  );
});

test("purchase detection is opt-in and registers scripts only after host permission", async () => {
  const manifest = require("./manifest.json");
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.permissions.includes("scripting"));
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);

  const {
    context,
    permissionRequests,
    permissionRemovals,
    registeredScripts,
    scriptExecutions,
    sets,
  } = popupHarness(async () => {
    throw new Error("unused");
  });
  const plain = (value) => JSON.parse(JSON.stringify(value));

  assert.equal(await evaluate(context, "setDetectionEnabled(true)"), true);
  assert.deepEqual(plain(permissionRequests), [{ origins: ["https://*/*"] }]);
  assert.equal(registeredScripts.length, 1);
  assert.equal(registeredScripts[0].id, "purchase-detection");
  assert.deepEqual(plain(registeredScripts[0].excludeMatches), [
    "http://localhost:3000/*",
  ]);
  assert.deepEqual(plain(scriptExecutions), [{
    target: { tabId: 7 },
    files: ["detect.js", "content.js"],
  }]);
  assert.deepEqual(plain(sets.at(-1)), { detectEnabled: true });

  assert.equal(await evaluate(context, "setDetectionEnabled(false)"), true);
  assert.equal(registeredScripts.length, 0);
  assert.deepEqual(plain(permissionRemovals), [{ origins: ["https://*/*"] }]);
  assert.deepEqual(plain(sets.at(-1)), { detectEnabled: false });
});

test("disabling detection removes only page access and keeps packaged API routing", async () => {
  const manifest = require("./manifest.json");
  const requests = [];
  const {
    context,
    permissionRequests,
    permissionRemovals,
  } = popupHarness(async (url) => {
    requests.push(url);
    const payload = url.endsWith("/api/login")
      ? { token: "issued-token" }
      : url.endsWith("/api/households")
        ? { households: [] }
        : { spent: 0, dailyBudget: 0, onTrack: true, categories: {} };
    return { status: 200, ok: true, async json() { return payload; } };
  });
  evaluate(context, "$('login-consent').checked = true");
  evaluate(context, "$('login-username').value = 'alice'");
  evaluate(context, "$('login-password').value = 'alice-password'");
  evaluate(context, "$('server-url').value = 'https://attacker.example'");

  await evaluate(context, "handleLogin({ preventDefault() {} })");
  assert.equal(await evaluate(context, "setDetectionEnabled(true)"), true);
  assert.equal(await evaluate(context, "setDetectionEnabled(false)"), true);
  await evaluate(context, "api('/api/summary', { auth: false })");

  assert.deepEqual(manifest.host_permissions, ["http://localhost:3000/*"]);
  assert.ok(requests.every((url) => url.startsWith("http://localhost:3000/")));
  assert.deepEqual(
    JSON.parse(JSON.stringify(permissionRequests)),
    [{ origins: ["https://*/*"] }],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(permissionRemovals)),
    [{ origins: ["https://*/*"] }],
  );
});

test("persisted detection registration is restored without a permission prompt", async () => {
  const {
    context,
    elements,
    permissionRequests,
    registeredScripts,
    scriptExecutions,
  } = popupHarness(
    async () => {
      throw new Error("unused");
    },
    { stored: { detectEnabled: true }, hostPermission: true },
  );

  await evaluate(context, "initDetectToggle()");

  assert.equal(elements.get("detect-toggle").checked, true);
  assert.equal(permissionRequests.length, 0);
  assert.equal(registeredScripts.length, 1);
  assert.equal(registeredScripts[0].id, "purchase-detection");
  assert.equal(scriptExecutions.length, 1);
});

test("receipt date uses the user's local calendar day", () => {
  const { context } = popupHarness(async () => {
    throw new Error("unused");
  });

  assert.equal(evaluate(context, "localDate(new Date(2026, 6, 26, 0, 30))"), "2026-07-26");
  assert.equal(evaluate(context, "rupee(123.45)"), "₹123.45");
});

test("logout clears the local token only after server revocation succeeds", async () => {
  let resolveFetch;
  const response = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const { context, removed } = popupHarness(() => response);
  evaluate(context, "token = 'secret-token'");

  const logout = evaluate(context, "handleLogout()");
  await Promise.resolve();
  assert.equal(evaluate(context, "token"), "secret-token");
  assert.deepEqual(removed, []);

  resolveFetch({
    status: 200,
    ok: true,
    async json() {
      return { ok: true };
    },
  });
  await logout;

  assert.equal(evaluate(context, "token"), null);
  assert.deepEqual(removed, ["token"]);
});

test("logout failure preserves the token so revocation can be retried", async () => {
  const { context, removed } = popupHarness(async () => {
    throw new Error("offline");
  });
  evaluate(context, "token = 'secret-token'");

  await evaluate(context, "handleLogout()");

  assert.equal(evaluate(context, "token"), "secret-token");
  assert.deepEqual(removed, []);
});

test("extension retries preserve an idempotency key only for the same payload", async () => {
  const requests = [];
  const { context } = popupHarness(async (_url, options) => {
    requests.push(options);
    return { status: 200, ok: true, async json() { return { ok: true }; } };
  });
  const same = evaluate(context, `
    (() => {
      const first = operationFor(null, { amount: 10 });
      const replay = operationFor(first, { amount: 10 });
      const changed = operationFor(first, { amount: 11 });
      return [first.key, replay.key, changed.key];
    })()
  `);
  assert.equal(same[0], same[1]);
  assert.notEqual(same[0], same[2]);

  await evaluate(context, `api('/api/receipts', {
    method: 'POST',
    body: { amount: 10 },
    auth: false,
    idempotencyKey: '${same[0]}'
  })`);
  assert.equal(requests[0].headers["Idempotency-Key"], same[0]);
});

test("background restricts local storage and answers detection setting requests", async () => {
  let onMessage;
  let accessLevel;
  const chrome = {
    storage: {
      local: {
        async setAccessLevel(value) {
          accessLevel = value;
        },
        async get() {
          return { detectEnabled: true };
        },
      },
      session: {
        async set() {},
        async remove() {},
      },
    },
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText() {},
    },
    runtime: {
      onMessage: {
        addListener(listener) {
          onMessage = listener;
        },
      },
    },
    tabs: {
      onRemoved: { addListener() {} },
    },
  };
  vm.runInNewContext(read("background.js"), { chrome }, { filename: "extension/background.js" });
  await Promise.resolve();

  assert.equal(accessLevel.accessLevel, "TRUSTED_CONTEXTS");
  const enabled = await new Promise((resolve) => {
    assert.equal(onMessage({ type: "detect-enabled" }, { tab: { id: 7 } }, resolve), true);
  });
  assert.equal(enabled, true);
});

test("content script obtains its toggle through trusted background messaging", () => {
  const messages = [];
  const context = {
    document: {
      querySelectorAll() {
        return [{
          textContent: JSON.stringify({
            "@type": "Order",
            orderTotal: { price: "25", priceCurrency: "INR" },
            seller: { name: "Cafe" },
          }),
        }];
      },
      body: { innerText: "Order placed" },
    },
    location: {
      href: "https://shop.example/order/1",
      hostname: "shop.example",
    },
    chrome: {
      runtime: {
        id: "extension-id",
        sendMessage(message, callback) {
          messages.push(message);
          callback(message.type === "detect-enabled" ? true : undefined);
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(read("detect.js"), context, { filename: "extension/detect.js" });
  vm.runInContext(read("content.js"), context, { filename: "extension/content.js" });

  assert.equal(messages[0].type, "detect-enabled");
  assert.equal(messages[1].type, "spend-detected");
  assert.equal(messages[1].candidate.amount, 25);
});

test("manifest icon files contain their declared pixel dimensions", () => {
  const manifest = require("./manifest.json");
  for (const [declared, relativePath] of Object.entries(manifest.icons)) {
    const png = fs.readFileSync(path.join(extensionDir, relativePath));
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    assert.equal(png.readUInt32BE(16), Number(declared));
    assert.equal(png.readUInt32BE(20), Number(declared));
  }
});
