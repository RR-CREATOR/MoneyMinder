"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");

async function packager() {
  return import(pathToFileURL(path.join(root, "scripts", "package-chrome.mjs")));
}

async function attemptPackagedLogin(popupSource) {
  const requests = [];
  const permissionRequests = [];
  const elements = new Map([
    ["login-consent", { checked: true }],
    ["login-username", { value: "reviewer" }],
    ["login-password", { value: "reviewer-password" }],
    ["server-url", { value: "https://attacker.example" }],
  ]);
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        disabled: false,
        hidden: false,
        textContent: "",
        addEventListener() {},
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    URL,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        status: 400,
        ok: false,
        async json() {
          return { error: "stop after target capture" };
        },
      };
    },
    chrome: {
      storage: {
        local: {
          set(_value, callback) {
            callback();
          },
          remove(_keys, callback) {
            callback();
          },
        },
      },
      permissions: {
        async contains() {
          return false;
        },
        async request(value) {
          permissionRequests.push(value);
          return true;
        },
      },
    },
    document: {
      getElementById: element,
      addEventListener() {},
    },
  });
  vm.runInContext(popupSource, context, { filename: "packaged/popup.js" });
  await vm.runInContext("handleLogin({ preventDefault() {} })", context);
  return { permissionRequests, requests };
}

async function registerPackagedDetection(popupSource) {
  const registeredScripts = [];
  const context = vm.createContext({
    chrome: {
      scripting: {
        async getRegisteredContentScripts() {
          return [];
        },
        async registerContentScripts(scripts) {
          registeredScripts.push(...scripts);
        },
      },
    },
    document: {
      addEventListener() {},
      getElementById() {
        return {};
      },
    },
  });
  vm.runInContext(popupSource, context, { filename: "packaged/popup.js" });
  await vm.runInContext("ensureDetectionRegistered()", context);
  return JSON.parse(JSON.stringify(registeredScripts));
}

async function migratePackagedLegacyState(popupSource, apiBase) {
  const removed = [];
  const permissionRemovals = [];
  let storedValues = {
    accountDisclosureVersion: 1,
    apiBase,
    detectEnabled: true,
    token: "legacy-token",
  };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        addEventListener() {},
        classList: { add() {}, remove() {} },
        hidden: false,
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    URL,
    fetch: async () => {
      throw new Error("legacy cleanup must not make a network request");
    },
    chrome: {
      permissions: {
        async remove(value) {
          permissionRemovals.push(value);
          return true;
        },
      },
      storage: {
        local: {
          get(keys, callback) {
            const defaults = Array.isArray(keys) ? {} : keys;
            callback({ ...defaults, ...storedValues });
          },
          remove(keys, callback) {
            const removedKeys = Array.isArray(keys) ? keys : [keys];
            removed.push(removedKeys);
            storedValues = Object.fromEntries(
              Object.entries(storedValues)
                .filter(([key]) => !removedKeys.includes(key)),
            );
            callback();
          },
        },
      },
    },
    document: {
      addEventListener() {},
      getElementById: element,
    },
  });
  vm.runInContext(popupSource, context, { filename: "packaged/popup.js" });
  await vm.runInContext("init()", context);
  return {
    permissionRemovals: JSON.parse(JSON.stringify(permissionRemovals)),
    removed: JSON.parse(JSON.stringify(removed)),
  };
}

test("Chrome release origin must be a public HTTPS origin", async () => {
  const { validateServerOrigin } = await packager();

  assert.equal(
    validateServerOrigin("https://github.com"),
    "https://github.com",
  );
  for (const invalid of [
    "http://money.example.org",
    "https://localhost:3000",
    "https://foo.localhost",
    "https://money.internal",
    "https://money.home.arpa",
    "https://money.onion",
    "https://10.0.0.1",
    "https://money.example.org/api",
    "https://your-domain.example",
    "https://money.your-host.com",
    "https://money.your-real-domain.com",
  ]) {
    assert.throws(() => validateServerOrigin(invalid));
  }
});

test("Chrome release staging rewrites the API origin and excludes reviewer noise", async () => {
  const { prepareChromeStage, runtimeFiles } = await packager();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-chrome-"));
  const stage = path.join(temp, "stage");
  try {
    await prepareChromeStage({
      extensionDir: path.join(root, "extension"),
      stageDir: stage,
      serverUrl: "https://github.com",
    });

    assert.deepEqual(
      fs.readdirSync(stage, { recursive: true })
        .filter((entry) => fs.statSync(path.join(stage, entry)).isFile())
        .map((entry) => String(entry).replaceAll("\\", "/"))
        .sort(),
      [...runtimeFiles].sort(),
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.host_permissions, ["https://github.com/*"]);
    const popup = fs.readFileSync(path.join(stage, "popup.js"), "utf8");
    assert.match(popup, /const DEFAULT_API = "https:\/\/github\.com";/);
    const login = await attemptPackagedLogin(popup);
    assert.equal(login.requests[0].url, "https://github.com/api/login");
    assert.deepEqual(JSON.parse(login.requests[0].options.body), {
      username: "reviewer",
      password: "reviewer-password",
    });
    assert.deepEqual(login.permissionRequests, []);
    const detectionScripts = await registerPackagedDetection(popup);
    assert.deepEqual(detectionScripts[0].excludeMatches, ["https://github.com/*"]);
    const packagedLegacy = await migratePackagedLegacyState(
      popup,
      "https://github.com/",
    );
    assert.deepEqual(packagedLegacy.removed, [
      ["token", "apiBase", "accountDisclosureVersion"],
    ]);
    assert.deepEqual(packagedLegacy.permissionRemovals, []);
    const popupHtml = fs.readFileSync(path.join(stage, "popup.html"), "utf8");
    assert.doesNotMatch(popupHtml, /id="server-url"|class="server-details"/i);
    assert.doesNotMatch(popupHtml, /id="signup-link"|open sign-up/i);
    assert.doesNotMatch(popup, /handleSignup|register\.html/i);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("Chrome packager creates a non-empty ZIP and removes staging files", async () => {
  const { createChromePackage } = await packager();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-chrome-zip-"));
  try {
    const zipFile = await createChromePackage({
      projectRoot: root,
      outputRoot: temp,
      serverUrl: "https://github.com",
    });
    assert.ok(fs.statSync(zipFile).size > 1000);
    assert.deepEqual(fs.readFileSync(zipFile).subarray(0, 2), Buffer.from("PK"));
    assert.equal(fs.existsSync(zipFile.replace(/\.zip$/, "")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("Chrome release ZIP is byte-reproducible for identical source and origin", async () => {
  const { createChromePackage } = await packager();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-chrome-repro-"));
  try {
    const first = await createChromePackage({
      projectRoot: root,
      outputRoot: path.join(temp, "first"),
      serverUrl: "https://github.com",
    });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const second = await createChromePackage({
      projectRoot: root,
      outputRoot: path.join(temp, "second"),
      serverUrl: "https://github.com",
    });
    const digest = (file) => crypto.createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
    assert.strictEqual(digest(first), digest(second));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
