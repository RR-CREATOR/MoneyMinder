import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runtimeFiles, validateServerOrigin } from "./package-chrome.mjs";

function command(commandName, args, { capture = false } = {}) {
  const result = spawnSync(commandName, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  if (result.error) throw new Error(`${commandName} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${commandName} failed with exit code ${result.status}`);
  return capture ? `${result.stdout || ""}${result.stderr || ""}` : "";
}

async function regularFile(value, extension, name) {
  const file = path.resolve(String(value || ""));
  if (path.extname(file).toLowerCase() !== extension) {
    throw new Error(`${name} must be a ${extension} file`);
  }
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw new Error(`${name} does not exist`);
  }
  if (!stat.isFile() || stat.size < 2) throw new Error(`${name} must be a non-empty file`);
  return file;
}

async function requireZipMagic(file, name) {
  const handle = await fsp.open(file, "r");
  try {
    const bytes = Buffer.alloc(2);
    await handle.read(bytes, 0, 2, 0);
    if (!bytes.equals(Buffer.from("PK"))) throw new Error(`${name} is not a ZIP/JAR archive`);
  } finally {
    await handle.close();
  }
}

export async function sha256File(file) {
  const digest = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

function digestHex(value, name) {
  const normalized = String(value || "").replace(/[:\s]/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${name} must contain 64 hexadecimal characters`);
  return normalized;
}

export function normalizeSha256(value) {
  return digestHex(value, "Expected signer SHA-256 fingerprint")
    .toUpperCase()
    .match(/.{2}/g)
    .join(":");
}

function dumpedStringResource(output, name) {
  const lines = String(output).split(/\r?\n/);
  const headers = lines
    .map((line, index) => ({ index, match: line.match(/^\s*0x[0-9a-f]+\s+-\s+(\S+)\s*$/i) }))
    .filter(({ match }) => match);
  if (headers.length !== 1 || headers[0].match[1] !== `string/${name}`) return "";
  const values = lines
    .slice(headers[0].index + 1)
    .map((line) => line.match(/\[string\]\s+(.+?)\s*$/i)?.[1])
    .filter(Boolean);
  if (values.length !== 1) return "";
  const value = values[0];
  if (!value.startsWith("\"")) return value;
  try {
    return JSON.parse(value);
  } catch {
    return "";
  }
}

function defaultZipEntries(zipFile) {
  const output = process.platform === "win32"
    ? command("tar.exe", ["-tf", zipFile], { capture: true })
    : command("unzip", ["-Z1", zipFile], { capture: true });
  return output.split(/\r?\n/).filter(Boolean);
}

function defaultZipEntry(zipFile, entry, archiveEntry = entry) {
  return process.platform === "win32"
    ? command("tar.exe", ["-xOf", zipFile, archiveEntry], { capture: true })
    : command("unzip", ["-p", zipFile, archiveEntry], { capture: true });
}

function archiveIndex(entries) {
  const files = new Map();
  const directories = new Set();
  for (const archiveEntry of entries) {
    if (typeof archiveEntry !== "string" || archiveEntry.includes("\\") || archiveEntry.startsWith("/")) {
      throw new Error("Chrome ZIP contains an unsafe archive path");
    }
    const normalized = archiveEntry.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (!normalized) continue;
    if (normalized.split("/").includes("..")) throw new Error("Chrome ZIP contains an unsafe archive path");
    if (archiveEntry.endsWith("/")) {
      directories.add(`${normalized}/`);
      continue;
    }
    if (files.has(normalized)) throw new Error(`Chrome ZIP contains duplicate entry ${normalized}`);
    files.set(normalized, archiveEntry);
  }
  return { directories, files };
}

function sameFiles(actual, expected) {
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

export async function verifyChromeZip({
  zipFile,
  expectedOrigin,
  expectedSha256 = "",
  listEntries = defaultZipEntries,
  readEntry = defaultZipEntry,
}) {
  const file = await regularFile(zipFile, ".zip", "Chrome artifact");
  await requireZipMagic(file, "Chrome artifact");
  const origin = validateServerOrigin(expectedOrigin);
  const { directories, files } = archiveIndex(await Promise.resolve(listEntries(file)));
  const expectedFiles = [...runtimeFiles].sort();
  const actualFiles = [...files.keys()].sort();
  if (!sameFiles(actualFiles, expectedFiles)) {
    throw new Error("Chrome ZIP runtime file set does not match the release allowlist");
  }
  const expectedDirectories = new Set(runtimeFiles
    .map((entry) => path.posix.dirname(entry))
    .filter((entry) => entry !== ".")
    .map((entry) => `${entry}/`));
  if ([...directories].some((entry) => !expectedDirectories.has(entry))) {
    throw new Error("Chrome ZIP contains an unexpected directory");
  }

  let manifest;
  try {
    manifest = JSON.parse(await Promise.resolve(
      readEntry(file, "manifest.json", files.get("manifest.json")),
    ));
  } catch {
    throw new Error("Chrome ZIP manifest.json is invalid");
  }
  if (manifest.manifest_version !== 3
      || JSON.stringify(manifest.host_permissions) !== JSON.stringify([`${origin}/*`])) {
    throw new Error("Chrome ZIP manifest does not contain the exact packaged API origin");
  }
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(["storage", "scripting"])
      || JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(["https://*/*"])) {
    throw new Error("Chrome ZIP manifest does not contain the exact least-privilege permissions");
  }
  const popup = await Promise.resolve(readEntry(file, "popup.js", files.get("popup.js")));
  const defaultApi = popup.match(/^const DEFAULT_API = (.+);$/m);
  let packagedOrigin;
  try {
    packagedOrigin = defaultApi ? JSON.parse(defaultApi[1]) : "";
  } catch {
    packagedOrigin = "";
  }
  if (packagedOrigin !== origin) {
    throw new Error("Chrome ZIP popup does not contain the exact packaged API origin");
  }

  const sha256 = await sha256File(file);
  if (expectedSha256 && sha256 !== digestHex(expectedSha256, "Expected Chrome SHA-256")) {
    throw new Error("Chrome artifact SHA-256 does not match the expected digest");
  }
  return { files: actualFiles.length, origin, sha256 };
}

export async function verifyAndroidAab({
  aabFile,
  bundletoolJar,
  expectedBundletoolSha256,
  expectedServerOrigin,
  expectedSignerSha256,
  expectedSha256 = "",
  runCommand = command,
}) {
  if (!expectedSignerSha256) throw new Error("Expected signer SHA-256 fingerprint is required");
  if (!expectedBundletoolSha256) throw new Error("Expected bundletool SHA-256 is required");
  if (!expectedServerOrigin) throw new Error("Expected Android server origin is required");
  const expectedSigner = normalizeSha256(expectedSignerSha256);
  const serverOrigin = validateServerOrigin(expectedServerOrigin);
  const file = await regularFile(aabFile, ".aab", "Android artifact");
  const bundletool = await regularFile(bundletoolJar, ".jar", "BUNDLETOOL_JAR");
  await requireZipMagic(file, "Android artifact");
  const bundletoolSha256 = await sha256File(bundletool);
  if (bundletoolSha256 !== digestHex(expectedBundletoolSha256, "Expected bundletool SHA-256")) {
    throw new Error("BUNDLETOOL_JAR SHA-256 does not match the expected digest");
  }
  const sha256 = await sha256File(file);
  if (expectedSha256 && sha256 !== digestHex(expectedSha256, "Expected AAB SHA-256")) {
    throw new Error("Android artifact SHA-256 does not match the expected digest");
  }

  const certificate = runCommand("keytool", [
    "-J-Duser.language=en",
    "-printcert",
    "-jarfile",
    file,
  ], { capture: true });
  const signers = new Set(
    [...String(certificate).matchAll(/SHA256:\s*([0-9A-Fa-f:]{64,95})/g)]
      .map((match) => normalizeSha256(match[1])),
  );
  if (signers.size !== 1 || !signers.has(expectedSigner)) {
    throw new Error("AAB signer SHA-256 fingerprint does not match the expected upload certificate");
  }
  const certificateRfc = runCommand("keytool", [
    "-J-Duser.language=en",
    "-printcert",
    "-rfc",
    "-jarfile",
    file,
  ], { capture: true });
  const certificateBlocks = String(certificateRfc)
    .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (certificateBlocks.length !== 1) {
    throw new Error("AAB must contain exactly one signer certificate");
  }
  const trustDir = await fsp.mkdtemp(path.join(os.tmpdir(), "moneyminder-aab-trust-"));
  try {
    const certificateFile = path.join(trustDir, "signer.pem");
    const trustStore = path.join(trustDir, "truststore.p12");
    const trustPassword = crypto.randomBytes(24).toString("hex");
    await fsp.writeFile(certificateFile, `${certificateBlocks[0]}\n`, { mode: 0o600 });
    runCommand("keytool", [
      "-importcert",
      "-noprompt",
      "-alias",
      "moneyminder-artifact-signer",
      "-file",
      certificateFile,
      "-keystore",
      trustStore,
      "-storetype",
      "PKCS12",
      "-storepass",
      trustPassword,
    ]);
    runCommand("jarsigner", [
      "-J-Duser.language=en",
      "-verify",
      "-strict",
      "-verbose",
      "-certs",
      "-keystore",
      trustStore,
      "-storepass",
      trustPassword,
      file,
    ]);
  } finally {
    await fsp.rm(trustDir, { recursive: true, force: true });
  }
  runCommand("java", [
    "-jar",
    bundletool,
    "validate",
    `--bundle=${file}`,
  ]);
  const resources = runCommand("java", [
    "-jar",
    bundletool,
    "dump",
    "resources",
    `--bundle=${file}`,
    "--resource=string/server_url",
    "--values",
  ], { capture: true });
  if (dumpedStringResource(resources, "server_url") !== serverOrigin) {
    throw new Error("AAB embedded server_url does not match the expected production origin");
  }

  return {
    bundletoolSha256,
    serverOrigin,
    sha256,
    signerSha256: expectedSigner,
  };
}

async function main([kind, artifact]) {
  if (kind === "chrome") {
    return verifyChromeZip({
      zipFile: artifact,
      expectedOrigin: process.env.MONEYMINDER_SERVER_URL,
      expectedSha256: process.env.MONEYMINDER_EXPECTED_CHROME_SHA256,
    });
  }
  if (kind === "android") {
    return verifyAndroidAab({
      aabFile: artifact,
      bundletoolJar: process.env.BUNDLETOOL_JAR,
      expectedBundletoolSha256: process.env.MONEYMINDER_EXPECTED_BUNDLETOOL_SHA256,
      expectedServerOrigin: process.env.MONEYMINDER_SERVER_URL,
      expectedSignerSha256: process.env.MONEYMINDER_EXPECTED_SIGNER_SHA256,
      expectedSha256: process.env.MONEYMINDER_EXPECTED_AAB_SHA256,
    });
  }
  throw new Error("Usage: node scripts/verify-release-artifact.mjs <chrome|android> <artifact>");
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
