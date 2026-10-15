"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function imageSize(file) {
  const bytes = fs.readFileSync(path.join(root, file));
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      type: "png",
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          width: bytes.readUInt16BE(offset + 7),
          height: bytes.readUInt16BE(offset + 5),
          type: "jpeg",
        };
      }
      offset += 2 + length;
    }
  }
  throw new Error(`${file} is not a supported PNG or JPEG`);
}

test("Chrome page access is HTTPS-only and has prominent pre-consent disclosure", () => {
  const manifest = JSON.parse(read("extension/manifest.json"));
  const popup = read("extension/popup.html");

  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.match(popup, /reads order and receipt page text locally/i);
  assert.match(popup, /only saved[\s\S]*Track/i);
});

test("Android CI validates signing and builds the Play App Bundle", () => {
  const workflow = read(".github/workflows/verify.yml");
  const build = read("android/app/build.gradle.kts");

  assert.match(workflow, /:app:testReleaseSigningValidation/);
  assert.match(workflow, /:app:bundleRelease/);
  assert.match(build, /fun validateReleaseSigning/);
  assert.match(build, /storeFile.*storePassword.*keyAlias.*keyPassword/s);
});

test("public privacy surfaces include web account deletion and extension limited use", () => {
  const privacy = read("public/privacy.html");
  const deletion = read("public/delete-account.html");
  const support = read("public/support.html");
  const chromeListing = read("store-listing/chrome-web-store/listing.md");

  assert.match(privacy, /delete-account\.html/);
  assert.match(privacy, /Chrome Web Store User Data Policy.*Limited Use/i);
  assert.match(privacy, /IP addresses[\s\S]*rate limiting/i);
  assert.match(deletion, /Profile/i);
  assert.match(deletion, /Delete account/i);
  assert.match(support, /coordinator named in your pilot invitation/i);
  assert.match(support, /Never send your password/i);
  assert.match(chromeListing, /Support: `https:\/\/<production-host>\/support\.html`/);
});

test("store listing kit contains policy-sized mandatory graphics", () => {
  const expected = new Map([
    ["store-listing/google-play/icon-512.png", [512, 512, "png"]],
    ["store-listing/google-play/feature-graphic-1024x500.jpg", [1024, 500, "jpeg"]],
    ["store-listing/google-play/screenshots/phone-dashboard-1080x1920.jpg", [1080, 1920, "jpeg"]],
    ["store-listing/google-play/screenshots/phone-scan-1080x1920.jpg", [1080, 1920, "jpeg"]],
    ["store-listing/chrome-web-store/icon-128.png", [128, 128, "png"]],
    ["store-listing/chrome-web-store/small-promo-440x280.jpg", [440, 280, "jpeg"]],
    ["store-listing/chrome-web-store/screenshots/budget-glance-1280x800.jpg", [1280, 800, "jpeg"]],
    ["store-listing/chrome-web-store/screenshots/purchase-detection-1280x800.jpg", [1280, 800, "jpeg"]],
  ]);

  for (const [file, [width, height, type]] of expected) {
    assert.deepEqual(imageSize(file), { width, height, type }, file);
  }
});

test("store copy and console worksheets are present", () => {
  for (const file of [
    "store-listing/README.md",
    "store-listing/google-play/listing.md",
    "store-listing/google-play/data-safety.md",
    "store-listing/google-play/financial-features.md",
    "store-listing/google-play/app-access.md",
    "store-listing/chrome-web-store/listing.md",
    "store-listing/chrome-web-store/privacy-practices.md",
  ]) {
    assert.ok(fs.statSync(path.join(root, file)).size > 100, file);
  }
});

test("release hygiene ignores local secrets and agent state", () => {
  const ignored = new Set(read(".gitignore").split(/\r?\n/));

  for (const entry of [".env", "data/", "node_modules/", "outputs/", ".codex/"]) {
    assert.ok(ignored.has(entry), entry);
  }
});

test("Google Play receipt asset copy is picker-neutral", () => {
  const renderSource = read("store-listing/render-assets.html");
  assert.match(renderSource, /Choose one image\. Split each item\./);
  assert.doesNotMatch(renderSource, /Scan once|take a photo/i);
});

test("Google Play data safety matches the bounded paired-backup contract", () => {
  const dataSafety = read("store-listing/google-play/data-safety.md");
  const listing = read("store-listing/google-play/listing.md");

  assert.match(dataSafety, /SQLite[\s\S]*stored and staged receipt images/i);
  assert.match(dataSafety, /versioning-disabled[\s\S]*Delete objects[\s\S]*30 days/i);
  assert.match(dataSafety, /operator-held copies[\s\S]*expire within 30 days/i);
  assert.match(dataSafety, /deletion register[\s\S]*before restored data can replace production/i);
  assert.doesNotMatch(dataSafety, /PostgreSQL/i);
  assert.match(listing, /server-side OCR/i);
});

test("store metadata stays within Play and Chrome text limits", () => {
  const manifest = JSON.parse(read("extension/manifest.json"));
  const play = read("store-listing/google-play/listing.md");
  const chrome = read("store-listing/chrome-web-store/listing.md");
  const appName = play.match(/^- App name: `([^`]+)`/m)?.[1];
  const shortDescription = play.match(/Short description \([^)]+\):\s*>\s*([^\r\n]+)/)?.[1];
  const fullDescription = play.match(/Full description:\s*([\s\S]*?)\r?\n## URLs/)?.[1]
    .replace(/^>\s?/gm, "")
    .replace(/\r?\n/g, " ")
    .trim();

  assert.ok(appName && appName.length <= 30);
  assert.ok(shortDescription && shortDescription.length <= 80);
  assert.ok(fullDescription && fullDescription.length <= 4000);
  assert.ok(manifest.name.length <= 75);
  assert.ok(manifest.description.length <= 132);
  assert.equal(chrome.match(/Summary:\s*>\s*([^\r\n]+)/)?.[1], manifest.description);
});
