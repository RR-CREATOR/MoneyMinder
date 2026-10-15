"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");

const load = (file) => import(pathToFileURL(path.join(root, "scripts", file)));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function response(status, body = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

test("closed production enrollment keeps registration hidden and rejects both routes", async () => {
  const { verifyClosedEnrollment } = await load("verify-production-enrollment.mjs");
  const login = fs.readFileSync(path.join(root, "public", "login.html"), "utf8");
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const pathname = new URL(url).pathname;
    if (pathname === "/login.html") return response(200, login);
    if (pathname === "/register.html") return response(404);
    if (pathname === "/api/register") return response(403);
    return response(500);
  };

  const result = await verifyClosedEnrollment({
    baseUrl: "http://127.0.0.1:3000",
    appOrigin: "https://budget-host.in",
    fetchImpl,
  });

  assert.deepEqual(result, {
    apiRegistrationStatus: 403,
    loginStatus: 200,
    registrationPageStatus: 404,
  });
  assert.equal(requests[2].options.method, "POST");
  assert.equal(requests[2].options.headers.Origin, "https://budget-host.in");
});

test("closed enrollment probe rejects a visible registration CTA", async () => {
  const { verifyClosedEnrollment } = await load("verify-production-enrollment.mjs");
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/login.html") {
      return response(200, '<p id="registration-cta"><a href="register.html">Create account</a></p>');
    }
    return response(pathname === "/register.html" ? 404 : 403);
  };

  await assert.rejects(
    verifyClosedEnrollment({
      baseUrl: "http://127.0.0.1:3000",
      appOrigin: "https://budget-host.in",
      fetchImpl,
    }),
    /registration CTA must be hidden/i,
  );
});

test("closed enrollment probe does not confuse aria-hidden with the hidden attribute", async () => {
  const { verifyClosedEnrollment } = await load("verify-production-enrollment.mjs");
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/login.html") {
      return response(
        200,
        '<p id="registration-cta" aria-hidden="false"><a href="register.html">Create account</a></p><p>Invited pilot participants</p>',
      );
    }
    return response(pathname === "/register.html" ? 404 : 403);
  };

  await assert.rejects(
    verifyClosedEnrollment({
      baseUrl: "http://127.0.0.1:3000",
      appOrigin: "https://budget-host.in",
      fetchImpl,
    }),
    /registration CTA must be hidden/i,
  );
});

test("production demo has no dead registration links and routes pilot CTAs to login", () => {
  const demo = read("public/demo.html");

  assert.doesNotMatch(demo, /href=["']register\.html["']|create an account/i);
  assert.match(demo, /invite-only pilot/i);
  assert.match(demo, /href=["']login\.html["'][^>]*>Participant login</i);
  assert.match(demo, /renderNav\(["']index\.html["']\)/);
});

test("Chrome verifier checks exact runtime files, packaged origin, and SHA-256", async () => {
  const { runtimeFiles } = await load("package-chrome.mjs");
  const { verifyChromeZip } = await load("verify-release-artifact.mjs");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-release-gate-"));
  const zipFile = path.join(temp, "moneyminder.zip");
  const bytes = Buffer.from("PK-test-archive");
  fs.writeFileSync(zipFile, bytes);
  const origin = "https://budget-host.in";

  try {
    const result = await verifyChromeZip({
      zipFile,
      expectedOrigin: origin,
      listEntries: () => ["./", "icons/", ...runtimeFiles.map((file) => `./${file}`)],
      readEntry: (_file, entry) => {
        if (entry === "manifest.json") {
          return JSON.stringify({
            manifest_version: 3,
            permissions: ["storage", "scripting"],
            host_permissions: [`${origin}/*`],
            optional_host_permissions: ["https://*/*"],
          });
        }
        if (entry === "popup.js") return `const DEFAULT_API = ${JSON.stringify(origin)};\n`;
        throw new Error(`Unexpected entry read: ${entry}`);
      },
    });

    assert.equal(result.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.origin, origin);
    assert.equal(result.files, runtimeFiles.length);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("Chrome verifier rejects extra files, broadened permissions, and a changed expected hash", async () => {
  const { runtimeFiles } = await load("package-chrome.mjs");
  const { verifyChromeZip } = await load("verify-release-artifact.mjs");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-release-gate-"));
  const zipFile = path.join(temp, "moneyminder.zip");
  fs.writeFileSync(zipFile, "PK-test-archive");
  const origin = "https://budget-host.in";
  const manifest = {
    manifest_version: 3,
    permissions: ["storage", "scripting"],
    host_permissions: [`${origin}/*`],
    optional_host_permissions: ["https://*/*"],
  };
  const readEntry = (_file, entry) => entry === "manifest.json"
    ? JSON.stringify(manifest)
    : `const DEFAULT_API = ${JSON.stringify(origin)};\n`;

  try {
    await assert.rejects(
      verifyChromeZip({
        zipFile,
        expectedOrigin: origin,
        listEntries: () => [...runtimeFiles, "debug.log"],
        readEntry,
      }),
      /runtime file set/i,
    );
    for (const changedManifest of [
      { ...manifest, permissions: [...manifest.permissions, "tabs"] },
      { ...manifest, optional_host_permissions: ["https://*/*", "http://*/*"] },
    ]) {
      await assert.rejects(
        verifyChromeZip({
          zipFile,
          expectedOrigin: origin,
          listEntries: () => runtimeFiles,
          readEntry: (_file, entry) => entry === "manifest.json"
            ? JSON.stringify(changedManifest)
            : `const DEFAULT_API = ${JSON.stringify(origin)};\n`,
        }),
        /least-privilege permissions/i,
      );
    }
    await assert.rejects(
      verifyChromeZip({
        zipFile,
        expectedOrigin: origin,
        expectedSha256: "00".repeat(32),
        listEntries: () => runtimeFiles,
        readEntry,
      }),
      /SHA-256/i,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("AAB verifier requires the expected upload fingerprint and runs strict tools", async () => {
  const {
    normalizeSha256,
    verifyAndroidAab,
  } = await load("verify-release-artifact.mjs");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-aab-gate-"));
  const aabFile = path.join(temp, "app-release.aab");
  const bundletoolJar = path.join(temp, "bundletool.jar");
  const bytes = Buffer.from("PK-signed-aab-placeholder");
  const bundletoolBytes = Buffer.from("bundletool-placeholder");
  fs.writeFileSync(aabFile, bytes);
  fs.writeFileSync(bundletoolJar, bundletoolBytes);
  const expectedSignerSha256 = "AB".repeat(32);
  const expectedBundletoolSha256 = crypto.createHash("sha256").update(bundletoolBytes).digest("hex");
  const expectedServerOrigin = "https://budget-host.in";
  const formattedFingerprint = normalizeSha256(expectedSignerSha256);
  const calls = [];
  const runCommand = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "keytool" && args.includes("-rfc")) {
      return "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n";
    }
    if (command === "keytool" && args.includes("-printcert")) {
      return `SHA256: ${formattedFingerprint}\n`;
    }
    if (command === "java" && args[2] === "dump") {
      return [
        "Package 'com.moneyminder.app':",
        "0x7f100001 - string/server_url",
        `\t(default) - [string] \"${expectedServerOrigin}\"`,
        "",
      ].join("\n");
    }
    return "";
  };

  try {
    const result = await verifyAndroidAab({
      aabFile,
      bundletoolJar,
      expectedBundletoolSha256,
      expectedServerOrigin,
      expectedSignerSha256,
      runCommand,
    });

    assert.equal(result.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.signerSha256, formattedFingerprint);
    assert.equal(result.bundletoolSha256, expectedBundletoolSha256);
    assert.equal(result.serverOrigin, expectedServerOrigin);
    assert.deepEqual(
      calls.map(({ command }) => command),
      ["keytool", "keytool", "keytool", "jarsigner", "java", "java"],
    );
    assert.deepEqual(
      calls[0].args,
      ["-J-Duser.language=en", "-printcert", "-jarfile", path.resolve(aabFile)],
    );
    assert.deepEqual(
      calls[1].args,
      ["-J-Duser.language=en", "-printcert", "-rfc", "-jarfile", path.resolve(aabFile)],
    );
    assert.ok(calls[2].args.includes("-importcert"));
    assert.ok(calls[2].args.includes("moneyminder-artifact-signer"));
    assert.ok(calls[3].args.includes("-strict"));
    assert.ok(calls[3].args.includes("-keystore"));
    assert.deepEqual(
      calls[4].args,
      ["-jar", path.resolve(bundletoolJar), "validate", `--bundle=${path.resolve(aabFile)}`],
    );
    assert.deepEqual(calls[5].args, [
      "-jar",
      path.resolve(bundletoolJar),
      "dump",
      "resources",
      `--bundle=${path.resolve(aabFile)}`,
      "--resource=string/server_url",
      "--values",
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("AAB verifier fails closed without or with the wrong expected signer fingerprint", async () => {
  const { verifyAndroidAab } = await load("verify-release-artifact.mjs");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-aab-gate-"));
  const aabFile = path.join(temp, "app-release.aab");
  const bundletoolJar = path.join(temp, "bundletool.jar");
  fs.writeFileSync(aabFile, "PK-signed-aab-placeholder");
  const bundletoolBytes = Buffer.from("bundletool-placeholder");
  fs.writeFileSync(bundletoolJar, bundletoolBytes);
  const expectedBundletoolSha256 = crypto.createHash("sha256").update(bundletoolBytes).digest("hex");
  const expectedServerOrigin = "https://budget-host.in";
  const runCommand = (command, args) => {
    if (command === "keytool" && args.includes("-rfc")) {
      return "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n";
    }
    if (command === "keytool" && args.includes("-printcert")) {
      return `SHA256: ${"AB:".repeat(31)}AB\n`;
    }
    if (command === "java" && args[2] === "dump") {
      return `0x7f100001 - string/server_url\n\t(default) - [string] \"https://wrong-host.in\"\n`;
    }
    return "";
  };

  try {
    await assert.rejects(
      verifyAndroidAab({ aabFile, bundletoolJar, expectedSignerSha256: "", runCommand }),
      /expected signer SHA-256 fingerprint is required/i,
    );
    await assert.rejects(
      verifyAndroidAab({
        aabFile,
        bundletoolJar,
        expectedSignerSha256: "AB".repeat(32),
        expectedServerOrigin,
        runCommand,
      }),
      /expected bundletool SHA-256 is required/i,
    );
    await assert.rejects(
      verifyAndroidAab({
        aabFile,
        bundletoolJar,
        expectedBundletoolSha256,
        expectedSignerSha256: "AB".repeat(32),
        runCommand,
      }),
      /expected Android server origin is required/i,
    );
    await assert.rejects(
      verifyAndroidAab({
        aabFile,
        bundletoolJar,
        expectedBundletoolSha256: "00".repeat(32),
        expectedServerOrigin,
        expectedSignerSha256: "AB".repeat(32),
        runCommand,
      }),
      /BUNDLETOOL_JAR SHA-256 does not match/i,
    );
    await assert.rejects(
      verifyAndroidAab({
        aabFile,
        bundletoolJar,
        expectedBundletoolSha256,
        expectedServerOrigin,
        expectedSignerSha256: "CD".repeat(32),
        runCommand,
      }),
      /signer SHA-256 fingerprint does not match/i,
    );
    await assert.rejects(
      verifyAndroidAab({
        aabFile,
        bundletoolJar,
        expectedBundletoolSha256,
        expectedServerOrigin,
        expectedSignerSha256: "AB".repeat(32),
        runCommand,
      }),
      /embedded server_url does not match/i,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("release workflow and guides require closed-enrollment and exact-artifact gates", () => {
  const workflow = read(".github/workflows/verify.yml");
  const playGuide = read("docs/release/GOOGLE-PLAY-UPLOAD.md");
  const androidGuide = read("android/RELEASE.md");
  const chromeGuide = read("docs/release/CHROME-WEB-STORE-UPLOAD.md");
  const extensionGuide = read("extension/README.md");
  const playListing = read("store-listing/google-play/listing.md");
  const chromeListing = read("store-listing/chrome-web-store/listing.md");
  const productionReadiness = read("docs/PRODUCTION-READINESS.md");
  const deploymentGuide = read("docs/release/DEPLOYMENT-AND-DISTRIBUTION.md");
  const handoff = read("docs/engineering/AGENTIC-HANDOFF.md");

  assert.match(
    workflow,
    /verify-production-enrollment\.mjs[\s\\]+http:\/\/127\.0\.0\.1:3000 https:\/\/moneyminder\.test/,
  );
  assert.match(workflow, /verify-release-artifact\.mjs chrome/);
  assert.match(workflow, /:app:testAndroidPlatformContracts/);
  assert.match(
    workflow,
    /verify-release-artifact\.mjs android[\s\\]+android\/app\/build\/outputs\/bundle\/release\/app-release\.aab/,
  );
  assert.match(
    workflow,
    /MONEYMINDER_EXPECTED_BUNDLETOOL_SHA256:\s+a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29/,
  );
  assert.match(
    workflow,
    /--env TRUST_PROXY=loopback/,
    "production container smoke must declare the only supported production proxy trust",
  );
  assert.match(workflow, /Verify SQLite restart and concurrency/);
  assert.match(workflow, /npm run test:sqlite/);
  assert.doesNotMatch(workflow, /postgres:16-bookworm@sha256/);

  for (const guide of [playGuide, androidGuide]) {
    assert.match(guide, /MONEYMINDER_EXPECTED_SIGNER_SHA256/);
    assert.match(guide, /MONEYMINDER_EXPECTED_BUNDLETOOL_SHA256/);
    assert.match(guide, /MONEYMINDER_SERVER_URL/);
    assert.match(guide, /jarsigner[^\r\n]*-verify[^\r\n]*-strict[^\r\n]*-verbose[^\r\n]*-certs/);
    assert.match(guide, /jarsigner[^\r\n]*-keystore[^\r\n]*<EPHEMERAL_PKCS12_TRUSTSTORE>/);
    assert.match(guide, /keytool[^\r\n]*-printcert[^\r\n]*-jarfile/);
    assert.match(guide, /only after\s+that exact\s+signer match[\s\S]{0,300}ephemeral PKCS12 truststore/i);
    assert.match(guide, /public\s+certificate only; it never\s+contains the upload private key/i);
    assert.match(guide, /bundletool[\s\S]*\bvalidate\b/);
    assert.match(guide, /dump resources[^\r\n]*--resource=string\/server_url[^\r\n]*--values/);
  }

  assert.match(chromeGuide, /verify-release-artifact\.mjs chrome/);
  assert.doesNotMatch(extensionGuide, /server field|Changing the API base URL/i);
  assert.match(extensionGuide, /packaged production API origin/i);
  for (const guide of [productionReadiness, playGuide, chromeGuide, deploymentGuide, handoff]) {
    assert.match(guide, /TRUST_PROXY=loopback/);
    assert.doesNotMatch(guide, /TRUST_PROXY=0/);
  }
  assert.match(playListing, /invited adult pilot participants[\s\S]*registration is not open/i);
  assert.match(chromeListing, /invited adult pilot participants[\s\S]*registration is closed/i);
});
