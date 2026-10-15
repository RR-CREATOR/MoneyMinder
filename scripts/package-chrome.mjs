import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const runtimeFiles = Object.freeze([
  "background.js",
  "content.js",
  "detect.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "manifest.json",
  "popup.css",
  "popup.html",
  "popup.js",
]);

const ZIP_EPOCH_SECONDS = 946684800;

function normalizeExtendedTimestamp(extra, start, length) {
  const end = start + length;
  for (let offset = start; offset + 4 <= end;) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const value = offset + 4;
    const next = value + size;
    if (next > end) throw new Error("Malformed Chrome ZIP extra field");
    if (id === 0x5455 && size > 0) {
      const flags = extra[value];
      let timestamp = value + 1;
      for (const flag of [1, 2, 4]) {
        if ((flags & flag) !== 0) {
          if (timestamp + 4 > next) throw new Error("Malformed Chrome ZIP timestamp");
          extra.writeUInt32LE(ZIP_EPOCH_SECONDS, timestamp);
          timestamp += 4;
        }
      }
    }
    offset = next;
  }
}

export function normalizeZipTimestamps(archive) {
  let endRecord = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endRecord = offset;
      break;
    }
  }
  if (endRecord < 0) throw new Error("Malformed Chrome ZIP end record");

  const entries = archive.readUInt16LE(endRecord + 10);
  let central = archive.readUInt32LE(endRecord + 16);
  for (let index = 0; index < entries; index += 1) {
    if (archive.readUInt32LE(central) !== 0x02014b50) {
      throw new Error("Malformed Chrome ZIP directory");
    }
    const nameLength = archive.readUInt16LE(central + 28);
    const extraLength = archive.readUInt16LE(central + 30);
    const commentLength = archive.readUInt16LE(central + 32);
    normalizeExtendedTimestamp(archive, central + 46 + nameLength, extraLength);

    const local = archive.readUInt32LE(central + 42);
    if (archive.readUInt32LE(local) !== 0x04034b50) {
      throw new Error("Malformed Chrome ZIP entry");
    }
    const localNameLength = archive.readUInt16LE(local + 26);
    const localExtraLength = archive.readUInt16LE(local + 28);
    normalizeExtendedTimestamp(archive, local + 30 + localNameLength, localExtraLength);
    central += 46 + nameLength + extraLength + commentLength;
  }
  return archive;
}

export function validateServerOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error("MONEYMINDER_SERVER_URL must be a public HTTPS origin");
  }
  const host = parsed.hostname.toLowerCase();
  const reserved = [
    "localhost",
    ".localhost",
    ".local",
    ".internal",
    ".test",
    ".invalid",
    ".example",
    ".home.arpa",
    ".onion",
    ".alt",
  ];
  const placeholder = reserved.some((name) => host === name || host.endsWith(name))
    || ["example.com", "example.org", "example.net"].some(
      (name) => host === name || host.endsWith(`.${name}`),
    )
    || host.split(".").some((label) => [
      "example",
      "placeholder",
      "your-domain",
      "your-host",
      "your-real-domain",
    ].includes(label));
  const domain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);
  if (parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || !domain
    || placeholder
    || !["", "/"].includes(parsed.pathname)
    || parsed.search
    || parsed.hash
    || parsed.port
  ) {
    throw new Error("MONEYMINDER_SERVER_URL must be a public HTTPS origin");
  }
  return parsed.origin;
}

export async function prepareChromeStage({ extensionDir, stageDir, serverUrl }) {
  const source = path.resolve(extensionDir);
  const target = path.resolve(stageDir);
  if (source === target || target === path.parse(target).root) {
    throw new Error("Unsafe Chrome staging directory");
  }
  const origin = validateServerOrigin(serverUrl);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  for (const file of runtimeFiles) {
    const destination = path.join(target, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(source, file), destination);
  }

  const manifestFile = path.join(target, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  await fs.writeFile(
    manifestFile,
    `${JSON.stringify({ ...manifest, host_permissions: [`${origin}/*`] }, null, 2)}\n`,
  );

  const popupFile = path.join(target, "popup.js");
  const popup = await fs.readFile(popupFile, "utf8");
  const rewritten = popup.replace(
    /^const DEFAULT_API = .*;$/m,
    `const DEFAULT_API = ${JSON.stringify(origin)};`,
  );
  if (rewritten === popup) throw new Error("Could not set the extension release API origin");
  await fs.writeFile(popupFile, rewritten);

  const releaseTime = new Date("2000-01-01T00:00:00.000Z");
  for (const file of runtimeFiles) {
    await fs.utimes(path.join(target, file), releaseTime, releaseTime);
  }
  await fs.utimes(path.join(target, "icons"), releaseTime, releaseTime);
  await fs.utimes(target, releaseTime, releaseTime);
}

export async function createChromePackage({
  projectRoot,
  serverUrl,
  outputRoot = path.join(projectRoot, "outputs", "chrome-web-store"),
}) {
  const extensionDir = path.join(projectRoot, "extension");
  const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, "manifest.json"), "utf8"));
  const stageDir = path.join(outputRoot, `moneyminder-${manifest.version}`);
  const zipFile = `${stageDir}.zip`;
  await fs.mkdir(outputRoot, { recursive: true });
  await prepareChromeStage({ extensionDir, stageDir, serverUrl });
  await fs.rm(zipFile, { force: true });
  try {
    if (process.platform === "win32") {
      const compress = [
        "& {",
        "param([string]$Source,[string]$Destination)",
        "Compress-Archive -Path (Join-Path $Source '*')",
        "-DestinationPath $Destination -CompressionLevel Optimal -Force",
        "}",
      ].join(" ");
      execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        compress,
        stageDir,
        zipFile,
      ]);
    } else {
      execFileSync("zip", ["-q", "-X", zipFile, ...runtimeFiles], { cwd: stageDir });
    }
    const archive = await fs.readFile(zipFile);
    await fs.writeFile(zipFile, normalizeZipTimestamps(archive));
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
  }
  if ((await fs.stat(zipFile)).size === 0) throw new Error("Chrome package is empty");
  return zipFile;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const projectRoot = path.resolve(path.dirname(currentFile), "..");
  const zipFile = await createChromePackage({
    projectRoot,
    serverUrl: process.env.MONEYMINDER_SERVER_URL,
  });
  process.stdout.write(`${zipFile}\n`);
}
