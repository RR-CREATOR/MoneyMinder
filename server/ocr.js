// Local, free receipt OCR. Runs Tesseract.js in-process — no API key, nothing
// leaves the server. The pure parser helpers below are exported so they can be
// unit-tested without ever running OCR.
//
// Ceiling: one CPU-bound worker, and Tesseract can't recognize() concurrently,
// so requests are serialized through a promise-queue (same shape as db.update).
const { createWorker } = require("tesseract.js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const config = require("./config");
const uploads = require("./uploads");
const { isCurrentUser } = require("./http");

const LANG_DIR = path.join(__dirname, "ocr-data");
const LANG_FILE = path.join(LANG_DIR, "eng.traineddata.gz");
// @tesseract.js-data/eng@1.0.0, 4.0.0_best_int.
const LANG_SHA256 = "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91";
const OCR_TIMEOUT_MS = 30000;
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_UPLOAD_FILES = 200;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 16 * 1000 * 1000;
const JPEG_SIZE_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);
const RECEIPT_IMAGE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png)$/i;

async function verifyLanguageData(file = LANG_FILE) {
  let data;
  try {
    data = await fs.promises.readFile(file);
  } catch (error) {
    throw new Error(`OCR language model unavailable: ${error.code || error.message}`);
  }
  const digest = crypto.createHash("sha256").update(data).digest("hex");
  if (digest !== LANG_SHA256) throw new Error("OCR language model checksum mismatch");
}

async function bounded(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), OCR_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// One worker, created lazily on first use and reused for every scan. The pinned
// model is read locally with caching disabled, so Tesseract has no CDN fallback.
let workerP = null;
let orphanSweepTimer;
let orphanSweepQueue = Promise.resolve();
function worker() {
  if (!workerP) {
    const initializing = verifyLanguageData().then(() => createWorker("eng", 1, {
      langPath: LANG_DIR,
      cacheMethod: "none",
      gzip: true,
    }));
    workerP = bounded(initializing, "OCR initialization timed out").catch((e) => {
      if (e.message === "OCR initialization timed out") {
        initializing.then((w) => w && w.terminate()).catch(() => {});
      }
      workerP = null;
      throw e;
    });
  }
  return workerP;
}

// Serialize recognitions: a single worker processes one image at a time, so
// chain calls through a queue the way db.update chains writes. Pending depth is
// bounded so a stuck worker can't pile up unbounded work.
let queue = Promise.resolve();
let pending = 0;
function recognize(buffer) {
  // Bound the queue: reject fast rather than enqueue when too much is in
  // flight. The route propagates OCR_BUSY so the app can return Retry-After.
  if (pending > 4) {
    const error = new Error("OCR busy");
    error.code = "OCR_BUSY";
    return Promise.reject(error);
  }
  pending++;
  const run = queue.then(async () => {
    const w = await worker();
    try {
      const { data } = await bounded(w.recognize(buffer), "OCR timed out");
      return data.text || "";
    } catch (e) {
      // Only a timeout means the worker is likely wedged — terminate it and
      // reset so the next request gets a fresh one. A normal recognize error
      // (bad image) leaves the worker healthy, so don't kill it.
      if (e.message === "OCR timed out") {
        try { const ww = await workerP; if (ww) await ww.terminate(); } catch {}
        workerP = null;
      }
      throw e;
    }
  });
  queue = run.catch(() => {}); // keep ordering even if one call throws
  return run.finally(() => { pending--; });
}

// The app owns process signals; this awaits termination after HTTP intake stops.
async function shutdown() {
  if (orphanSweepTimer) clearInterval(orphanSweepTimer);
  orphanSweepTimer = undefined;
  await orphanSweepQueue;
  const current = workerP;
  workerP = null;
  if (!current) return;
  try {
    const activeWorker = await current;
    if (activeWorker) await activeWorker.terminate();
  } catch {
    /* worker creation/termination already failed; nothing remains to await */
  }
}

// Save the uploaded image under the user's own folder and return just the
// filename. Same behavior as before — images are served back through an
// authenticated route only.
async function uploadUsageExceeds(root, addedBytes, maxBytes, maxFiles) {
  if (addedBytes > maxBytes) return true;
  let userDirs;
  try {
    userDirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  let bytes = 0;
  let files = 0;
  // ponytail: scan at most the configured file ceiling on each upload; keep
  // indexed counters when this single-volume pilot outgrows 10k files.
  for (const userDir of userDirs) {
    if (!userDir.isDirectory()) continue;
    const dir = path.join(root, userDir.name);
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      files++;
      if (files >= maxFiles) return true;
      try {
        bytes += (await fs.promises.stat(path.join(dir, entry.name))).size;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (bytes + addedBytes > maxBytes) return true;
    }
  }
  return false;
}

async function sweepExpiredUploads(root, now = Date.now()) {
  let userDirs;
  try {
    userDirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const expired = [];
  const cutoff = now - ORPHAN_TTL_MS;
  // ponytail: scan the bounded pilot volume hourly; add an indexed pending-image
  // table if the supported 10k-file ceiling becomes too expensive to walk.
  for (const userDir of userDirs) {
    if (!userDir.isDirectory()) continue;
    const dir = path.join(root, userDir.name);
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !RECEIPT_IMAGE.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      try {
        if ((await fs.promises.stat(file)).mtimeMs <= cutoff) {
          expired.push({ userKey: userDir.name, name: entry.name });
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  if (!expired.length) return;
  await db.update((data) => {
    const referenced = new Set(Object.values(data.receipts || {})
      .filter((receipt) => receipt && receipt.userKey && receipt.image)
      .map((receipt) => `${receipt.userKey}\0${path.basename(receipt.image)}`));
    for (const image of expired) {
      if (!referenced.has(`${image.userKey}\0${image.name}`)) {
        uploads.queueImageDelete(data, image.userKey, image.name);
      }
    }
  });
  await uploads.retryPendingDeletes();
}

async function startOrphanSweeps(intervalMs = ORPHAN_SWEEP_INTERVAL_MS) {
  if (orphanSweepTimer) return orphanSweepQueue;
  await sweepExpiredUploads(uploads.root);
  orphanSweepTimer = setInterval(() => {
    const run = orphanSweepQueue.then(() => sweepExpiredUploads(uploads.root));
    orphanSweepQueue = run.catch((error) => {
      console.error(JSON.stringify({
        type: "orphan_upload_cleanup_error",
        code: error && error.code ? String(error.code) : "",
      }));
    });
  }, intervalMs);
  if (orphanSweepTimer.unref) orphanSweepTimer.unref();
}

async function saveImageNow(req) {
  if (!req.file) return "";
  const ext = imageExtension(req.file.buffer);
  if (!ext) throw new Error("Invalid image data");
  // basename the userKey too — belt-and-suspenders against path traversal in
  // the folder segment (the username charset check in auth.js is the real fix).
  const dir = uploads.userDir(req.userKey);
  await sweepExpiredUploads(uploads.root);
  const result = await db.update(async (data) => {
    if (!isCurrentUser(data, req)) return { stale: true };
    await fs.promises.mkdir(dir, { recursive: true });
    const files = (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile());
    let bytes = 0;
    for (const entry of files) bytes += (await fs.promises.stat(path.join(dir, entry.name))).size;
    // The DB transaction and save queue make quota checks atomic for the
    // supported single-container deployment.
    if (files.length >= MAX_UPLOAD_FILES || bytes + req.file.buffer.length > MAX_UPLOAD_BYTES
        || await uploadUsageExceeds(
          uploads.root,
          req.file.buffer.length,
          config.uploadTotalMaxBytes,
          config.uploadTotalMaxFiles,
        )) {
      return { quota: true };
    }
    const name = crypto.randomUUID() + ext;
    await fs.promises.writeFile(path.join(dir, name), req.file.buffer);
    return { name };
  });
  if (result.stale) {
    const error = new Error("Authenticated account changed");
    error.code = "AUTH_STALE";
    throw error;
  }
  if (result.quota) {
    const error = new Error("Receipt image storage limit reached");
    error.code = "UPLOAD_QUOTA";
    throw error;
  }
  return result.name;
}

let saveQueue = Promise.resolve();
function saveImage(req) {
  const run = saveQueue.then(() => saveImageNow(req));
  saveQueue = run.catch(() => {});
  return run;
}

function imageExtension(buffer) {
  if (!Buffer.isBuffer(buffer)) return "";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  return "";
}

function imageDimensions(buffer) {
  const extension = imageExtension(buffer);
  if (extension === ".png") {
    if (buffer.length < 24 || buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width && height ? { width, height } : null;
  }
  if (extension !== ".jpg") return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if (JPEG_SIZE_MARKERS.has(marker) && length >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return width && height ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

// ---- Pure parser helpers (no OCR, no I/O — unit-testable) ----

// Currency number like 1,234.50 / ₹99 / Rs. 1200. Source string only — built
// into a fresh regex per scan so a shared lastIndex can never desync.
const MONEY_SRC = "(?:₹|rs\\.?|inr|\\$)?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)";
const TOTAL_KEYS = /\b(grand\s*total|amount\s*due|balance\s*due|total|amount|net\s*payable)\b/i;
// Lines we never treat as a line item or supplier.
const SKIP_LINE = /\b(sub\s*total|subtotal|total|tax|gst|cgst|sgst|vat|discount|change|cash|card|tender|round|balance|amount\s*due)\b/i;

// Pull every money-looking number out of a string as Numbers. Uses matchAll
// with a fresh regex so there's no module-level lastIndex to reset.
function moneyIn(s) {
  const out = [];
  for (const m of String(s).matchAll(new RegExp(MONEY_SRC, "gi"))) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isNaN(n)) out.push(n);
  }
  return out;
}

// A money match is a real price unless it's a bare integer (no decimal point)
// that's >= 1000 — those are phones/GSTINs/barcodes/ZIPs/IDs. Anything above
// 999999 is excluded outright. Same rule parseLineItems uses.
function moneyMatches(s) {
  const out = [];
  for (const m of String(s).matchAll(new RegExp(MONEY_SRC, "gi"))) {
    const raw = m[1];
    const n = Number(raw.replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    if (n > 999999) continue;
    if (n >= 1000 && !/\./.test(raw)) continue; // bare big int = not a price
    out.push(n);
  }
  return out;
}

// Find the receipt total. Prefer the largest amount on a total-ish line; if a
// total keyword has no amount on its own line, look at the next line (thermal
// printers wrap "Amount Due\n163.28"). Fall back to the largest plausible money
// number anywhere.
function parseAmount(text) {
  text = String(text || "").slice(0, 50000); // bound parser cost on garbage
  const lines = text.split(/\r?\n/);
  let best = null;
  for (const line of lines) {
    const label = line.match(TOTAL_KEYS);
    if (label) {
      // skip subtotal lines — they're usually smaller than the real total
      if (/\bsub\s*total\b/i.test(line) && !/\bgrand\b/i.test(line)) continue;
      const after = moneyIn(line.slice(label.index + label[0].length));
      const before = moneyIn(line.slice(0, label.index));
      const nearest = after.find((amount) => amount > 0) || [...before].reverse().find((amount) => amount > 0);
      if (nearest !== undefined) best = nearest;
    }
  }
  // Ignore a zero/negative total ("Total 0") — fall through to the next pass.
  if (best != null && best > 0) return best;
  // Two-line layout: a total keyword line with no same-line amount, value on
  // the line below.
  for (let i = 0; i < lines.length - 1; i++) {
    if (TOTAL_KEYS.test(lines[i]) && !moneyIn(lines[i]).length) {
      const next = moneyIn(lines[i + 1]);
      if (next.length) return Math.max(...next);
    }
  }
  // fallback: largest plausible money number in the whole receipt (excludes
  // phones/IDs/ZIPs — bare big integers — and anything > 999999).
  const all = moneyMatches(text);
  if (!all.length) return "";
  return Math.max(...all);
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function pad(n) {
  return String(n).padStart(2, "0");
}

// Expand a 2-digit year the way receipts mean it (00–69 -> 2000s).
function fullYear(y) {
  y = Number(y);
  if (y >= 100) return y;
  return y <= 69 ? 2000 + y : 1900 + y;
}

function iso(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  const Y = fullYear(y);
  // Reject impossible calendar dates (e.g. 30 Feb, 31 Apr): round-trip through
  // a real UTC Date and require every field to survive unchanged.
  const dt = new Date(Date.UTC(Y, mo - 1, d));
  if (dt.getUTCFullYear() !== Y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "";
  return `${Y}-${pad(mo)}-${pad(d)}`;
}

// Match common date formats and normalize to YYYY-MM-DD. Numeric dd/mm/yyyy is
// assumed dd-then-mm (users are in India). Returns "" if nothing matches.
function parseDate(text) {
  const t = String(text || "");
  let m;
  // yyyy-mm-dd or yyyy/mm/dd
  if ((m = t.match(/\b(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/))) {
    return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // dd/mm/yyyy, dd-mm-yyyy, dd.mm.yy (assume dd first)
  if ((m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/))) {
    return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  }
  // dd Mon yyyy  (e.g. 14 Oct 2023)
  if ((m = t.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\,?\s+(\d{2,4})\b/))) {
    const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return iso(Number(m[3]), mo, Number(m[1]));
  }
  // Mon dd, yyyy  (e.g. Oct 14, 2023)
  if ((m = t.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\,?\s+(\d{2,4})\b/))) {
    const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return iso(Number(m[3]), mo, Number(m[2]));
  }
  return "";
}

// Merchant name: first couple of non-empty top lines that read like a name
// (have letters) and aren't a date/amount/skip line.
function parseSupplier(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 10)) {
    if (!/[A-Za-z]{3,}/.test(line)) continue; // needs real words
    if (SKIP_LINE.test(line)) continue;
    if (parseDate(line)) continue; // it's a date line
    // address/phone noise — skip lines that are mostly digits/punctuation
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    const digits = (line.match(/[0-9]/g) || []).length;
    if (digits > letters) continue;
    if (/\b(invoice|receipt|bill|gstin|tax\s*invoice|phone|tel|ph)\b/i.test(line)) continue;
    return line.replace(/\s{2,}/g, " ").slice(0, 60);
  }
  return "";
}

// Keyword heuristic → one of the app's buckets.
const CAT = [
  ["food", /\b(grocery|groceries|supermarket|super\s*market|mart|kirana|restaurant|cafe|caf[eé]|food|dine|diner|bakery|swiggy|zomato|pizza|burger|kitchen|hotel\s*food|bar\b)\b/i],
  ["travel", /\b(fuel|petrol|diesel|gas\s*station|uber|ola|cab|taxi|metro|bus|train|railway|irctc|travel|parking|toll|flight|airlines?)\b/i],
  ["housing", /\b(rent|hotel|lodge|lodging|stay|electricity|power\s*bill|internet|broadband|wifi|maintenance|water\s*bill|gas\s*bill)\b/i],
];
function parseCategory(text) {
  const t = String(text || "");
  for (const [bucket, re] of CAT) if (re.test(t)) return bucket;
  return "misc";
}

// Header/metadata noise that looks like "<label> <number>" but isn't a priced
// item — addresses, IDs, phone numbers, card/approval codes, transaction refs.
const NOISE_LINE = /\b(suite|ste|apt|unit|floor|street|st\b|road|rd\b|drive|dr\b|ave|avenue|lane|block|sector|pin|zip|merchant|terminal|transaction|trans|ref|invoice|bill\s*no|order\s*no|approval|auth|code|id\b|number|no\.?|phone|tel|ph\b|mobile|gstin|account|acct)\b/i;

// Best-effort line items: "<description> .... <amount>" — description text then
// a trailing money number. Conservative on purpose: receipts pack the header
// with addresses/IDs/codes that also read as "<text> <number>", so we skip
// total/subtotal/tax lines, header noise, and bare integers that look like a
// ZIP/ID rather than a price. Capped at 30. (ponytail: heuristic, not perfect —
// the split UI lets the user drop any stray row.)
function parseLineItems(text) {
  const lines = String(text || "").split(/\r?\n/);
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || SKIP_LINE.test(line) || NOISE_LINE.test(line)) continue;
    // trailing money at end of line
    const m = line.match(/^(.*?\S)\s+(?:₹|rs\.?|inr|\$)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*$/i);
    if (!m) continue;
    const desc = m[1].replace(/[.\s]{2,}/g, " ").trim();
    if (!/[A-Za-z]{2,}/.test(desc)) continue; // need a real description
    if (desc.length < 3 || /[:#]\s*$/.test(desc)) continue; // label fragments like "Approval Code:"
    const amount = Number(m[2].replace(/,/g, ""));
    if (Number.isNaN(amount) || amount <= 0) continue;
    // A bare integer >= 1000 with no decimals is almost always a ZIP/phone/ID,
    // not a line-item price. Keep prices (with decimals) and small integers.
    if (amount >= 1000 && !/\./.test(m[2])) continue;
    items.push({ description: desc.slice(0, 80), amount });
    if (items.length >= 30) break;
  }
  return items;
}

// Detect a payment word for the `document` field; otherwise "".
function parseDocument(text) {
  const m = String(text || "").match(/\b(cash|credit\s*card|debit\s*card|card|upi|paytm|gpay|google\s*pay|netbanking)\b/i);
  return m ? m[1].replace(/\s+/g, " ").toLowerCase() : "";
}

// Combine the helpers into the response shape the frontend expects.
function parse(text) {
  text = String(text || "").slice(0, 50000); // bound parser cost on garbage input
  const amount = parseAmount(text);
  let lineItems = parseLineItems(text);
  if (amount !== "" && lineItems.length) {
    const totalPaise = Math.round(amount * 100);
    const itemsPaise = lineItems.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
    if (itemsPaise < totalPaise) {
      lineItems = [...lineItems, { description: "Unitemized remainder", amount: (totalPaise - itemsPaise) / 100 }];
    } else if (itemsPaise > totalPaise) {
      lineItems = [{ description: "Receipt total", amount }];
    }
  }
  return {
    category: parseCategory(text),
    date: parseDate(text),
    amount,
    supplier: parseSupplier(text),
    document: parseDocument(text),
    lineItems,
  };
}

// ---- Route handler ----
async function parseReceipt(req, res) {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!req.file.mimetype || !req.file.mimetype.startsWith("image/")) {
    return res.status(400).json({ error: "Please upload an image file" });
  }
  const dimensions = imageDimensions(req.file.buffer);
  if (!dimensions) {
    return res.status(400).json({ error: "Please upload a valid JPEG or PNG image" });
  }
  if (dimensions.width > MAX_IMAGE_DIMENSION
      || dimensions.height > MAX_IMAGE_DIMENSION
      || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    return res.status(400).json({ error: "Image dimensions are too large" });
  }
  let recognized = false;
  try {
    const text = await recognize(req.file.buffer);
    recognized = true;
    const fields = parse(text);
    const image = await saveImage(req);
    // Nothing usable read back — let the user fill it in by hand.
    if (fields.amount === "" && !fields.supplier && !fields.date && !fields.lineItems.length) {
      return res.json({ configured: false, image, category: "", date: "", amount: "", supplier: "", document: "", lineItems: [] });
    }
    res.json({ configured: true, image, ...fields });
  } catch (e) {
    if (recognized || e.code === "OCR_BUSY") throw e;
    console.error("Receipt scan failed:", e.message);
    res.json({ configured: false, image: "", category: "", date: "", amount: "", supplier: "", document: "", lineItems: [] });
  }
}

module.exports = {
  parseReceipt,
  recognize,
  parseAmount,
  parseDate,
  parseSupplier,
  parseCategory,
  parseLineItems,
  parse,
  imageExtension,
  imageDimensions,
  uploadUsageExceeds,
  verifyLanguageData,
  startOrphanSweeps,
  shutdown,
};
