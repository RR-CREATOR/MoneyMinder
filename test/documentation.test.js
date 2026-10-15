"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const required = [
  "docs/README.md",
  "docs/PITCH.md",
  "docs/INNOVATION.md",
  "docs/product/PRODUCT-GUIDE.md",
  "docs/product/HOW-IT-WORKS.md",
  "docs/engineering/ARCHITECTURE.md",
  "docs/engineering/CODEBASE-GUIDE.md",
  "docs/engineering/API-REFERENCE.md",
  "docs/engineering/AGENTIC-HANDOFF.md",
  "docs/release/DEPLOYMENT-AND-DISTRIBUTION.md",
  "docs/release/GOOGLE-PLAY-UPLOAD.md",
  "docs/release/CHROME-WEB-STORE-UPLOAD.md",
  "docs/testing/merchant-promotions.tdd.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
];

function markdownFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "outputs", "data", "build", ".gradle"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(file));
    else if (entry.name.endsWith(".md")) files.push(file);
  }
  return files;
}

test("canonical documentation set exists and is substantive", () => {
  for (const relative of required) {
    const file = path.join(root, relative);
    assert.ok(fs.existsSync(file), relative);
    assert.ok(fs.statSync(file).size >= 200, `${relative} is unexpectedly small`);
  }
});

test("release documentation preserves the embedded SQLite pilot boundary", () => {
  const production = fs.readFileSync(path.join(root, "docs", "PRODUCTION-READINESS.md"), "utf8");
  const deployment = fs.readFileSync(
    path.join(root, "docs", "release", "DEPLOYMENT-AND-DISTRIBUTION.md"),
    "utf8",
  );
  const product = fs.readFileSync(path.join(root, "docs", "product", "PRODUCT-GUIDE.md"), "utf8");
  const google = fs.readFileSync(
    path.join(root, "docs", "release", "GOOGLE-PLAY-UPLOAD.md"),
    "utf8",
  );
  const chrome = fs.readFileSync(
    path.join(root, "docs", "release", "CHROME-WEB-STORE-UPLOAD.md"),
    "utf8",
  );
  const combined = [production, deployment, product, google, chrome].join("\n");

  assert.match(production, /Legacy PostgreSQL\/JSON-store variables are rejected/);
  assert.equal(production.match(/PostgreSQL/gi)?.length, 1);
  assert.match(production, /at most 30 active pilot\s+accounts/);
  assert.match(production, /sqlite-maintenance\.js backup <LIVE\.sqlite3> <NEW-BACKUP\.sqlite3>/);
  assert.match(production, /sqlite-maintenance\.js restore <BACKUP\.sqlite3> <NEW-RESTORED\.sqlite3>/);
  assert.match(deployment, /OCR and SQLite do not require a VM/);
  assert.match(product, /Server-side OCR/);
  assert.doesNotMatch(combined, /Node(?:\.js)?\s+22|test:postgres|PostgreSQL-backed|managed PostgreSQL/i);
  assert.doesNotMatch(combined, /NORMALIZED-POSTGRES-MIGRATION/i);
});

test("local Markdown links resolve", () => {
  const missing = [];
  for (const file of markdownFiles(root)) {
    const markdown = fs.readFileSync(file, "utf8");
    for (const match of markdown.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
      let target = match[1].trim().replace(/^<|>$/g, "");
      if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      target = target.split("#", 1)[0].split("?", 1)[0];
      if (!target) continue;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
      if (!fs.existsSync(resolved)) {
        missing.push(`${path.relative(root, file)} -> ${target}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("architecture CodeTour anchors resolve against the working tree", () => {
  const tour = JSON.parse(fs.readFileSync(
    path.join(root, ".tours", "architect-moneyminder-system.tour"),
    "utf8",
  ));
  assert.match(tour.$schema, /codetour-schema/);
  assert.ok(tour.steps.length >= 14 && tour.steps.length <= 18);
  assert.ok(tour.steps[0].file || tour.steps[0].directory);
  for (const step of tour.steps) {
    if (step.directory) {
      assert.ok(fs.statSync(path.join(root, step.directory)).isDirectory(), step.directory);
    }
    if (!step.file) continue;
    const file = path.join(root, step.file);
    assert.ok(fs.statSync(file).isFile(), step.file);
    if (step.pattern) {
      assert.ok(fs.readFileSync(file, "utf8").includes(step.pattern), `${step.file}: ${step.pattern}`);
    }
  }
});
