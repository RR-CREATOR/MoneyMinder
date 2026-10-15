const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PUBLIC = __dirname;

test("dashboard promotions stay hidden unless a safe sponsored offer is available", async () => {
  const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  assert.match(html, /<aside[^>]+id="promotion-card"[^>]+hidden/);
  assert.match(html, />Sponsored</);
  assert.match(html, /id="promotion-dismiss"[^>]+aria-label="Dismiss sponsored offer"/);
  assert.match(html, /API\.get\("\/api\/promotions\/current"\)/);
  assert.match(html, /\.textContent\s*=\s*safe\.(?:title|description|ctaLabel)/);
  assert.match(
    html,
    /getElementById\("promotion-dismiss"\)\.addEventListener\("click"[\s\S]*?getElementById\("promotion-card"\)\.hidden = true/,
  );
  assert.match(
    html,
    /API\.post\(\s*"\/api\/promotions\/" \+ encodeURIComponent\(promotionId\) \+ "\/events",\s*\{ eventType \},\s*crypto\.randomUUID\(\),\s*\{ keepalive: true \}/,
  );
  assert.match(
    html,
    /new IntersectionObserver\([\s\S]*?entry\.isIntersecting[\s\S]*?entry\.intersectionRatio\s*<\s*0\.5/,
  );
  assert.match(
    html,
    /getElementById\("promotion-link"\)\.addEventListener\("click",\s*\(event\)[\s\S]*?event\.isTrusted[\s\S]*?reportPromotionEvent\([^,]+,\s*"click"\)/,
  );
  const renderSource = html.slice(
    html.indexOf("function renderPromotion"),
    html.indexOf("async function loadPromotion"),
  );
  assert.doesNotMatch(renderSource, /\.innerHTML/);

  const source = html.match(/function normalizePromotion\(promotion\) \{[\s\S]*?^\s{4}\}/m);
  assert.ok(source, "promotion validator is present");
  const normalizePromotion = vm.runInNewContext("(" + source[0] + ")", { URL });
  assert.strictEqual(
    JSON.stringify(normalizePromotion({
      id: "7de4b976-ef12-4d87-ac63-2519bd70ba18",
      title: "Local laundry offer",
      description: "Save on this week's wash.",
      ctaLabel: "View offer",
      url: "https://merchant.co.in/offer",
    })),
    JSON.stringify({
      id: "7de4b976-ef12-4d87-ac63-2519bd70ba18",
      title: "Local laundry offer",
      description: "Save on this week's wash.",
      ctaLabel: "View offer",
      url: "https://merchant.co.in/offer",
    }),
  );
  assert.strictEqual(normalizePromotion({
    id: "../events",
    title: "Invalid campaign",
    description: "Not shown.",
    ctaLabel: "Open",
    url: "https://merchant.co.in/offer",
  }), null);
  assert.strictEqual(normalizePromotion({
    id: "7de4b976-ef12-4d87-ac63-2519bd70ba18",
    title: "Unsafe",
    description: "Not shown.",
    ctaLabel: "Open",
    url: "javascript:alert(1)",
  }), null);
  assert.strictEqual(normalizePromotion({
    id: "7de4b976-ef12-4d87-ac63-2519bd70ba18",
    title: "Insecure",
    description: "Not shown.",
    ctaLabel: "Open",
    url: "http://merchant.example/offer",
  }), null);
  for (const url of [
    "https://localhost/offer",
    "https://127.0.0.1/offer",
    "https://[::1]/offer",
    "https://merchant.local/offer",
    "https://merchant.example/offer",
    "https://merchant.co.in:8443/offer",
  ]) {
    assert.strictEqual(normalizePromotion({
      id: "7de4b976-ef12-4d87-ac63-2519bd70ba18",
      title: "Unsafe destination",
      description: "Not shown.",
      ctaLabel: "Open",
      url,
    }), null);
  }

  let requestOptions;
  const context = {
    location: { pathname: "/index.html", href: "" },
    window: {},
    fetch: async (_path, options) => {
      requestOptions = options;
      return { status: 204, ok: true, text: async () => "" };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, "js", "api.js"), "utf8"), context);
  await context.window.API.post("/api/promotions/id/events", { eventType: "click" }, "key", {
    keepalive: true,
  });
  assert.strictEqual(requestOptions.keepalive, true);
});

test("receipt line-item categories preserve canonical dashboard buckets", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "scan.html"), "utf8");
  const source = html.match(/function toBucket\(c\) \{[\s\S]*?^\s{4}\}/m);
  assert.ok(source, "toBucket function is present");
  const toBucket = vm.runInNewContext("(" + source[0] + ")");
  assert.strictEqual(toBucket("food"), "food");
  assert.strictEqual(toBucket("travel"), "travel");
  assert.strictEqual(toBucket("housing"), "housing");
  assert.strictEqual(toBucket("misc"), "misc");
});

test("scan rejects zero totals and contains the auth redirect rejection", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "scan.html"), "utf8");
  assert.match(html, /id="amount"[^>]*min="0\.01"/);
  assert.match(html, /Number\(amount\)\s*<=\s*0/);
  assert.match(html, /API\.requireUser\(\)\.catch\(/);
});

test("receipt chooser copy stays picker-neutral while retaining the web capture hint", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "scan.html"), "utf8");
  assert.match(html, /Choose a JPEG or PNG receipt image/);
  assert.match(html, /Tap to choose a receipt image/);
  assert.doesNotMatch(html, /snap or pick|take a photo/i);
  assert.match(html, /capture="environment"/);
});

test("receipt line-item saves preserve supported OCR provenance", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "scan.html"), "utf8");
  const personalStart = html.indexOf('if (mode === "mine")');
  const sharedStart = html.indexOf("} else {", personalStart);
  const personal = html.slice(
    personalStart,
    sharedStart,
  );
  const shared = html.slice(
    sharedStart,
    html.indexOf("entry.row.dataset.saved"),
  );
  assert.match(personal, /date:\s*parsed\.date/);
  assert.match(personal, /supplier:\s*parsed\.supplier/);
  assert.match(personal, /image:\s*imageName/);
  assert.match(shared, /date:\s*parsed\.date/);
});

test("money creation retries reuse a payload-scoped idempotency key", () => {
  const api = fs.readFileSync(path.join(PUBLIC, "js", "api.js"), "utf8");
  const scan = fs.readFileSync(path.join(PUBLIC, "scan.html"), "utf8");
  const household = fs.readFileSync(path.join(PUBLIC, "household.html"), "utf8");
  assert.match(api, /Idempotency-Key/);
  assert.match(api, /function operationKey\(/);
  assert.match(api, /function clearOperation\(/);
  assert.match(scan, /API\.operationKey\(entry\.row,\s*body\)/);
  assert.match(scan, /API\.operationKey\(details,\s*body\)/);
  assert.match(scan, /API\.clearOperation\(entry\.row\)/);
  assert.match(scan, /API\.clearOperation\(details\)/);
  assert.match(
    household,
    /API\.post\(\s*"\/api\/households",\s*body,\s*API\.operationKey\(form,\s*body\)/,
  );
  assert.strictEqual((household.match(/const form = e\.currentTarget;/g) || []).length, 4);
  assert.doesNotMatch(household, /API\.(?:operationKey|clearOperation)\(e\.currentTarget/);
  assert.match(household, /API\.operationKey\(form,\s*body\)/);
  assert.match(household, /API\.clearOperation\(form\)/);
  assert.strictEqual(
    (household.match(/API\.post\(path \+ "\/settle", body, API\.operationKey\(/g) || []).length,
    2,
  );
  assert.match(
    household,
    /API\.post\(path \+ "\/recurring", body, API\.operationKey\(form,\s*body\)\)/,
  );
  assert.match(household, /API\.clearOperation\(btn\)/);
});

test("money displays preserve paise instead of rounding to whole rupees", () => {
  const apiContext = { window: {}, location: { pathname: "/index.html" } };
  vm.runInNewContext(
    fs.readFileSync(path.join(PUBLIC, "js", "api.js"), "utf8"),
    apiContext,
  );
  assert.strictEqual(apiContext.window.API.formatMoney(123.45), "₹123.45");
  assert.strictEqual(apiContext.window.API.formatMoney(123), "₹123");
  assert.strictEqual(apiContext.window.API.formatMoney(-12.5, true), "₹12.50");

  const chartContext = { window: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(PUBLIC, "js", "charts.js"), "utf8"),
    chartContext,
  );
  assert.match(chartContext.window.Charts.donut({ food: 123.45 }).svg, /₹123\.45/);
  assert.match(
    chartContext.window.Charts.trend([{ date: "2026-07-26", amount: 123.45 }]),
    /₹123\.45/,
  );

  for (const file of ["index.html", "receipt.html", "receipts.html", "household.html"]) {
    assert.match(fs.readFileSync(path.join(PUBLIC, file), "utf8"), /API\.formatMoney/);
  }
  assert.match(
    fs.readFileSync(path.join(PUBLIC, "scan.html"), "utf8"),
    /API\.formatMoney\(it\.amount\)/,
  );
});

test("offline detail navigation ignores the query string when matching the app shell", async () => {
  const listeners = {};
  const context = {
    URL,
    Response,
    location: { origin: "https://money.test" },
    fetch: async () => { throw new Error("offline"); },
    caches: {
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      keys: async () => [],
      delete: async () => true,
      match: async (key) => {
        if (key === "/receipt.html") return "receipt-shell";
        if (key === "/index.html") return "dashboard-shell";
        return null;
      },
    },
    self: {
      addEventListener(name, handler) { listeners[name] = handler; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, "sw.js"), "utf8"), context);
  let response;
  listeners.fetch({
    request: {
      method: "GET",
      mode: "navigate",
      url: "https://money.test/receipt.html?id=abc",
    },
    respondWith(value) { response = value; },
  });
  assert.strictEqual(await response, "receipt-shell");
});

test("service worker install does not require the production-closed registration page", async () => {
  const listeners = {};
  let shell;
  const context = {
    URL,
    Response,
    location: { origin: "https://money.test" },
    fetch: async () => new Response(),
    caches: {
      open: async () => ({
        addAll: async (entries) => {
          shell = [...entries];
          if (entries.includes("/register.html")) throw new Error("registration closed");
        },
        put: async () => {},
      }),
      keys: async () => [],
      delete: async () => true,
      match: async () => null,
    },
    self: {
      addEventListener(name, handler) { listeners[name] = handler; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, "sw.js"), "utf8"), context);
  let install;
  listeners.install({ waitUntil(value) { install = value; } });
  await install;
  assert.ok(!shell.includes("/register.html"));
});

test("registration uses the same contact and password limits as the API", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "register.html"), "utf8");
  assert.match(html, /id="email"[^>]*maxlength="254"/);
  assert.match(html, /id="mobile"[^>]*maxlength="20"[^>]*pattern=/);
  assert.match(html, /id="password"[^>]*minlength="15"[^>]*maxlength="72"/);
  assert.match(html, /form\.email\.checkValidity\(\)/);
  assert.match(html, /form\.mobile\.checkValidity\(\)/);
  assert.match(html, /Array\.from\(password\)\.length\s*<\s*15/);
  assert.match(html, /password\.length\s*>\s*72/);
  assert.match(html, /new TextEncoder\(\)\.encode\(password\)\.length\s*>\s*72/);
});

test("profile reauthenticates VPA changes, exports, and account deletion", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "profile.html"), "utf8");
  const api = fs.readFileSync(path.join(PUBLIC, "js", "api.js"), "utf8");
  assert.match(html, /id="current-password"/);
  assert.match(html, /id="account-password"/);
  assert.match(html, /vpa\s*!==\s*loadedVpa/);
  assert.match(html, /body\.currentPassword\s*=\s*currentPassword/);
  assert.match(html, /API\.post\("\/api\/me\/export",\s*\{\s*currentPassword:\s*currentPassword\s*\}\)/);
  assert.match(html, /API\.del\("\/api\/me",\s*\{\s*currentPassword:\s*currentPassword\s*\}\)/);
  assert.match(api, /async function del\(path,\s*bodyObj\)/);
  assert.match(api, /method:\s*"DELETE"[\s\S]*body:\s*JSON\.stringify\(bodyObj\s*\|\|\s*\{\}\)/);
});

test("toast timeout removes its global Escape listener", () => {
  const timers = [];
  const listeners = new Map();
  const element = () => ({
    className: "",
    textContent: "",
    classList: { add() {}, remove() {} },
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
    remove() {},
  });
  const context = {
    window: {},
    document: {
      body: { appendChild() {} },
      createElement: element,
      addEventListener(name, handler) { listeners.set(name, handler); },
      removeEventListener(name, handler) {
        if (listeners.get(name) === handler) listeners.delete(name);
      },
    },
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length; },
    clearTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, "js", "toast.js"), "utf8"), context);
  context.window.Toast.show("Saved", "ok");
  assert.ok(listeners.has("keydown"));
  timers.find((timer) => timer.ms === 3200).callback();
  assert.strictEqual(listeners.has("keydown"), false);
});

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

test("status colors meet WCAG AA contrast for normal text", () => {
  const css = fs.readFileSync(path.join(PUBLIC, "css", "app.css"), "utf8");
  const token = (name) => css.match(new RegExp("--" + name + ":\\s*(#[0-9a-f]{6})", "i"))[1];
  assert.ok(contrast(token("success"), token("success-soft")) >= 4.5);
  assert.ok(contrast(token("danger"), token("danger-soft")) >= 4.5);
  assert.ok(contrast(token("success"), "#ffffff") >= 4.5);
  assert.ok(contrast(token("danger"), "#ffffff") >= 4.5);
});
