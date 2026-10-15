const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ocr = require("./ocr");

function jpeg(width, height) {
  const buffer = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    0x00, 0x00, 0x00, 0x00,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

function png(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

// Realistic multi-line receipt text — exercises the pure parsers without ever
// running OCR or touching the network.
const SAMPLE = [
  "FRESH MART SUPERMARKET",
  "12 MG Road, Bengaluru",
  "GSTIN: 29ABCDE1234F1Z5",
  "Date: 14/10/2023",
  "",
  "Milk 1L          45.00",
  "Bread            30.50",
  "Eggs (dozen)     80.00",
  "Subtotal        155.50",
  "CGST              3.89",
  "SGST              3.89",
  "TOTAL           163.28",
  "Paid by UPI",
].join("\n");

test("parseAmount picks the total via keyword (not subtotal)", () => {
  assert.strictEqual(ocr.parseAmount(SAMPLE), 163.28);
});

test("parseAmount falls back to the largest money number when no total keyword", () => {
  const t = "Item A 12.00\nItem B 99.99\nItem C 5.00";
  assert.strictEqual(ocr.parseAmount(t), 99.99);
});

test("parseAmount handles ₹/Rs/commas", () => {
  assert.strictEqual(ocr.parseAmount("Grand Total Rs. 1,234.50"), 1234.5);
  assert.strictEqual(ocr.parseAmount("Amount Due ₹2,000"), 2000);
});

test("parseAmount returns '' when there is no number", () => {
  assert.strictEqual(ocr.parseAmount("no digits here"), "");
});

test("parseAmount ignores a zero total and falls through to the items", () => {
  // "Total 0" must not win; the largest plausible item is the answer.
  assert.strictEqual(ocr.parseAmount("Total 0\nMilk 45\nBread 30"), 45);
});

test("parseAmount fallback excludes phone numbers / bare big integers", () => {
  // 9876543210 is a phone (bare integer >= 1000, no decimal) — not a price.
  assert.strictEqual(ocr.parseAmount("Store Name\n9876543210\nItem 45.00"), 45);
});

test("parseAmount reads a two-line total layout (keyword then value below)", () => {
  assert.strictEqual(ocr.parseAmount("Amount Due\n163.28"), 163.28);
});

test("parseAmount chooses the amount nearest the total label, not dates or rewards", () => {
  assert.strictEqual(ocr.parseAmount("TOTAL 29.01 DATE 14/10/2023"), 29.01);
  assert.strictEqual(ocr.parseAmount("TOTAL 100.00 REWARDS 500"), 100);
});

test("parseDate normalizes dd/mm/yyyy (Indian ordering)", () => {
  assert.strictEqual(ocr.parseDate("Date: 14/10/2023"), "2023-10-14");
});

test("parseDate normalizes yyyy-mm-dd", () => {
  assert.strictEqual(ocr.parseDate("Invoice 2024-03-09 paid"), "2024-03-09");
});

test("parseDate normalizes 'dd Mon yyyy' and 'Mon dd, yyyy'", () => {
  assert.strictEqual(ocr.parseDate("14 Oct 2023"), "2023-10-14");
  assert.strictEqual(ocr.parseDate("Oct 14, 2023"), "2023-10-14");
});

test("parseDate handles 2-digit years (dd.mm.yy)", () => {
  assert.strictEqual(ocr.parseDate("05.06.23"), "2023-06-05");
});

test("parseDate returns '' when no date is present", () => {
  assert.strictEqual(ocr.parseDate("just some text"), "");
});

test("parseDate rejects impossible calendar dates", () => {
  assert.strictEqual(ocr.parseDate("30/02/2024"), ""); // Feb has no 30th
  assert.strictEqual(ocr.parseDate("31/04/2024"), ""); // April has no 31st
});

test("parseSupplier reads the merchant from the top line", () => {
  assert.strictEqual(ocr.parseSupplier(SAMPLE), "FRESH MART SUPERMARKET");
});

test("parseSupplier skips date/amount/noise lines", () => {
  const t = "14/10/2023\n9876543210\nGREEN GROCER\nTotal 50.00";
  assert.strictEqual(ocr.parseSupplier(t), "GREEN GROCER");
});

test("parseCategory maps keywords to app buckets", () => {
  assert.strictEqual(ocr.parseCategory(SAMPLE), "food"); // supermarket
  assert.strictEqual(ocr.parseCategory("INDIAN OIL petrol pump"), "travel");
  assert.strictEqual(ocr.parseCategory("Monthly rent receipt"), "housing");
  assert.strictEqual(ocr.parseCategory("Random hardware store"), "misc");
});

test("parseLineItems extracts description+amount, skipping totals/tax", () => {
  const items = ocr.parseLineItems(SAMPLE);
  const descs = items.map((i) => i.description);
  assert.ok(items.length >= 3, "should find at least the three products");
  assert.ok(descs.some((d) => /Milk/.test(d)));
  assert.ok(descs.some((d) => /Bread/.test(d)));
  // none of the skipped lines should appear
  assert.ok(!descs.some((d) => /Subtotal|TOTAL|CGST|SGST/i.test(d)));
  // amounts are numbers
  for (const it of items) assert.strictEqual(typeof it.amount, "number");
});

test("parse() combines into the response shape, with payment word + bucket", () => {
  const out = ocr.parse(SAMPLE);
  assert.strictEqual(out.amount, 163.28);
  assert.strictEqual(out.date, "2023-10-14");
  assert.strictEqual(out.supplier, "FRESH MART SUPERMARKET");
  assert.strictEqual(out.category, "food");
  assert.strictEqual(out.document, "upi");
  assert.ok(Array.isArray(out.lineItems) && out.lineItems.length >= 3);
  assert.strictEqual(
    Math.round(out.lineItems.reduce((sum, item) => sum + item.amount, 0) * 100) / 100,
    out.amount,
  );
});

test("parse() reconciles filtered line items to the receipt total", () => {
  const out = ocr.parse("CLOTHING STORE\nShirt 1200\nSocks 200\nTOTAL 1400");
  assert.strictEqual(out.amount, 1400);
  assert.strictEqual(
    out.lineItems.reduce((sum, item) => sum + item.amount, 0),
    1400,
  );
  assert.ok(out.lineItems.some((item) => item.description === "Unitemized remainder" && item.amount === 1200));
});

test("imageExtension validates actual image signatures instead of client MIME", () => {
  assert.strictEqual(ocr.imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0x00])), ".jpg");
  assert.strictEqual(ocr.imageExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), ".png");
  assert.strictEqual(ocr.imageExtension(Buffer.from("GIF89a")), "");
  assert.strictEqual(ocr.imageExtension(Buffer.from("not an image")), "");
});

test("imageExtension accepts only bounded receipt formats and rejects non-buffers", () => {
  assert.strictEqual(ocr.imageExtension(Buffer.from("GIF87a")), "");
  assert.strictEqual(ocr.imageExtension(Buffer.from("RIFFxxxxWEBP")), "");
  assert.strictEqual(ocr.imageExtension("GIF89a"), "");
  assert.strictEqual(ocr.imageExtension(Buffer.alloc(0)), "");
});

test("imageDimensions reads JPEG/PNG headers and rejects malformed images", () => {
  assert.deepStrictEqual(ocr.imageDimensions(jpeg(4032, 3024)), { width: 4032, height: 3024 });
  assert.deepStrictEqual(ocr.imageDimensions(png(1200, 2400)), { width: 1200, height: 2400 });
  assert.strictEqual(ocr.imageDimensions(Buffer.from([0xff, 0xd8, 0xff])), null);
  assert.strictEqual(ocr.imageDimensions(Buffer.from("GIF89a")), null);
});

test("uploadUsageExceeds enforces process-wide byte and file ceilings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-upload-usage-"));
  try {
    fs.mkdirSync(path.join(root, "alice"));
    fs.mkdirSync(path.join(root, "bob"));
    fs.writeFileSync(path.join(root, "alice", "one.jpg"), Buffer.alloc(4));
    fs.writeFileSync(path.join(root, "bob", "two.png"), Buffer.alloc(5));
    assert.strictEqual(await ocr.uploadUsageExceeds(root, 1, 10, 3), false);
    assert.strictEqual(await ocr.uploadUsageExceeds(root, 2, 10, 3), true);
    assert.strictEqual(await ocr.uploadUsageExceeds(root, 1, 10, 2), true);
    assert.strictEqual(
      await ocr.uploadUsageExceeds(path.join(root, "missing"), 1, 10, 3),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parse handles overcounted items and parser noise branches", () => {
  const over = ocr.parse("CAFE\nMeal 60.00\nDrink 50.00\nTOTAL 100.00\ncredit card");
  assert.deepStrictEqual(over.lineItems, [{ description: "Receipt total", amount: 100 }]);
  assert.strictEqual(over.document, "credit card");

  assert.strictEqual(ocr.parseSupplier("Invoice 123\nGSTIN ABC123\n9876543210"), "");
  assert.deepStrictEqual(ocr.parseLineItems("A 10\nLabel: 20\nItem -1\nPhone 1234567890"), []);
  assert.strictEqual(ocr.parseDate("32/13/2024"), "");
});

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function withStubbedOcr(recognitions, fn, options = {}) {
  const ocrPath = require.resolve("./ocr");
  const dbPath = require.resolve("./db");
  const uploadsPath = require.resolve("./uploads");
  const tessPath = require.resolve("tesseract.js");
  const real = {
    ocr: require.cache[ocrPath],
    db: require.cache[dbPath],
    uploads: require.cache[uploadsPath],
    tess: require.cache[tessPath],
  };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moneyminder-ocr-"));
  const beforeTerm = new Set(process.listeners("SIGTERM"));
  const beforeInt = new Set(process.listeners("SIGINT"));
  let index = 0;
  let dbUpdates = 0;
  const dbData = { receipts: {} };
  const workerState = { terminations: 0 };
  const createWorkerCalls = [];
  const worker = {
    recognize: async () => {
      const next = recognitions[index++];
      if (next instanceof Error) throw next;
      return { data: { text: next } };
    },
    terminate: async () => { workerState.terminations++; },
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      dir: temp,
      load: async () => dbData,
      update: async (handler) => {
        dbUpdates++;
        if (options.beforeDbUpdate) await options.beforeDbUpdate(dbData, dbUpdates);
        return handler(dbData);
      },
    },
  };
  delete require.cache[uploadsPath];
  require.cache[tessPath] = {
    id: tessPath,
    filename: tessPath,
    loaded: true,
    exports: {
      createWorker: (...args) => {
        createWorkerCalls.push(args);
        return options.createWorker ? options.createWorker(...args) : Promise.resolve(worker);
      },
    },
  };
  delete require.cache[ocrPath];
  try {
    return await fn(require("./ocr"), temp, {
      beforeTerm,
      beforeInt,
      workerState,
      createWorkerCalls,
      dbData,
      get dbUpdates() { return dbUpdates; },
    });
  } finally {
    for (const listener of process.listeners("SIGTERM")) if (!beforeTerm.has(listener)) process.removeListener("SIGTERM", listener);
    for (const listener of process.listeners("SIGINT")) if (!beforeInt.has(listener)) process.removeListener("SIGINT", listener);
    for (const [modulePath, cached] of [
      [ocrPath, real.ocr],
      [dbPath, real.db],
      [uploadsPath, real.uploads],
      [tessPath, real.tess],
    ]) {
      if (cached) require.cache[modulePath] = cached;
      else delete require.cache[modulePath];
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test("OCR verifies a pinned local model and disables cache/network fallback", async () => {
  await assert.rejects(ocr.verifyLanguageData(__filename), /checksum mismatch/);
  await assert.rejects(
    ocr.verifyLanguageData(path.join(__dirname, "ocr-data", "missing.traineddata.gz")),
    /model unavailable: ENOENT/,
  );
  await withStubbedOcr(["TOTAL 12.50"], async (isolated, _temp, lifecycle) => {
    await isolated.recognize(Buffer.from("image"));
    assert.deepStrictEqual(lifecycle.createWorkerCalls, [[
      "eng",
      1,
      {
        langPath: path.join(__dirname, "ocr-data"),
        cacheMethod: "none",
        gzip: true,
      },
    ]]);
  });
});

test("OCR worker and model initialization are bounded by a timeout", async () => {
  let resolveWorker;
  let resolveTerminated;
  let lateTerminations = 0;
  const initializing = new Promise((resolve) => { resolveWorker = resolve; });
  const terminated = new Promise((resolve) => { resolveTerminated = resolve; });
  await withStubbedOcr([], async (isolated) => {
    const nativeSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => nativeSetTimeout(fn, 1);
    try {
      await assert.rejects(isolated.recognize(Buffer.from("image")), /initialization timed out/);
    } finally {
      global.setTimeout = nativeSetTimeout;
    }
    resolveWorker({ terminate: async () => { lateTerminations++; resolveTerminated(); } });
    let failTimer;
    try {
      await Promise.race([
        terminated,
        new Promise((_, reject) => {
          failTimer = nativeSetTimeout(
            () => reject(new Error("late worker was not terminated")),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(failTimer);
    }
    assert.strictEqual(lateTerminations, 1);
  }, { createWorker: () => initializing });
});

test("OCR busy errors escape the parse route for a 503 response", async () => {
  await withStubbedOcr(new Array(5).fill("TOTAL 1.00"), async (isolated) => {
    const inFlight = new Array(5).fill(null)
      .map(() => isolated.recognize(Buffer.from("image")));
    const res = fakeRes();
    await assert.rejects(
      isolated.parseReceipt({
        userKey: "a",
        file: { mimetype: "image/jpeg", buffer: jpeg(20, 20) },
      }, res),
      (error) => error.code === "OCR_BUSY",
    );
    await Promise.all(inFlight);
  });
});

test("OCR shutdown is awaited by the app lifecycle and installs no signal handlers", async () => {
  await withStubbedOcr(["TOTAL 12.50"], async (ocr, _temp, lifecycle) => {
    assert.deepStrictEqual(new Set(process.listeners("SIGTERM")), lifecycle.beforeTerm);
    assert.deepStrictEqual(new Set(process.listeners("SIGINT")), lifecycle.beforeInt);
    await ocr.recognize(Buffer.from("image"));
    await ocr.shutdown();
    assert.strictEqual(lifecycle.workerState.terminations, 1);
  });
});

test("scheduled OCR cleanup removes expired unclaimed images without another upload", async () => {
  await withStubbedOcr([], async (isolated, temp) => {
    const userDir = path.join(temp, "uploads", "a");
    const orphan = path.join(userDir, "00000000-0000-4000-8000-000000000000.jpg");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(orphan, jpeg(20, 20));
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(orphan, expired, expired);

    await isolated.startOrphanSweeps();

    assert.strictEqual(fs.existsSync(orphan), false);
    await isolated.shutdown();
  });
});

test("parseReceipt validates uploads, expires abandoned scans, and does not persist failed OCR", async () => {
  const claim = { image: "" };
  await withStubbedOcr([
    "CAFE\nMeal 12.50\nTOTAL 12.50",
    "",
    new Error("recognition failed"),
  ], async ({ parseReceipt }, temp, lifecycle) => {
    const jpegFile = jpeg(1200, 1600);
    for (const [req, expected] of [
      [{ userKey: "a" }, /No file/],
      [{ userKey: "a", file: { mimetype: "text/plain", buffer: jpegFile } }, /image file/],
      [{ userKey: "a", file: { mimetype: "image/jpeg", buffer: Buffer.from("fake") } }, /valid JPEG or PNG/],
      [{ userKey: "a", file: { mimetype: "image/png", buffer: png(8192, 8192) } }, /dimensions are too large/],
    ]) {
      const res = fakeRes();
      await parseReceipt(req, res);
      assert.strictEqual(res.statusCode, 400);
      assert.match(res.body.error, expected);
    }

    const success = fakeRes();
    await parseReceipt({ userKey: "a", file: { mimetype: "image/jpeg", buffer: jpegFile } }, success);
    assert.strictEqual(success.body.configured, true);
    assert.strictEqual(success.body.amount, 12.5);
    assert.match(success.body.image, /^[0-9a-f-]+\.jpg$/);

    const userDir = path.join(temp, "uploads", "a");
    const referenced = path.join(userDir, success.body.image);
    const abandoned = path.join(userDir, "00000000-0000-4000-8000-000000000000.jpg");
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    claim.image = success.body.image;
    lifecycle.dbData.receipts.saved = { userKey: "a", image: claim.image };
    fs.utimesSync(referenced, expired, expired);
    fs.writeFileSync(abandoned, jpegFile);
    fs.utimesSync(abandoned, expired, expired);

    const blank = fakeRes();
    await parseReceipt({ userKey: "a", file: { mimetype: "image/jpeg", buffer: jpegFile } }, blank);
    assert.strictEqual(blank.body.configured, false);
    assert.match(blank.body.image, /^[0-9a-f-]+\.jpg$/);
    assert.strictEqual(fs.existsSync(referenced), true);
    assert.strictEqual(fs.existsSync(abandoned), false);
    assert.strictEqual(lifecycle.dbData.pendingUploadDeletes, undefined);
    assert.strictEqual(lifecycle.dbUpdates, 4);

    const beforeFailure = fs.readdirSync(userDir).length;
    const oldError = console.error;
    console.error = () => {};
    try {
      const failed = fakeRes();
      await parseReceipt({ userKey: "a", file: { mimetype: "image/jpeg", buffer: jpegFile } }, failed);
      assert.deepStrictEqual(failed.body, {
        configured: false,
        image: "",
        category: "",
        date: "",
        amount: "",
        supplier: "",
        document: "",
        lineItems: [],
      });
    } finally {
      console.error = oldError;
    }
    assert.strictEqual(fs.readdirSync(userDir).length, beforeFailure);
  });
});

test("parseReceipt cannot save after account deletion or username reuse", async () => {
  await withStubbedOcr(["TOTAL 12.50"], async ({ parseReceipt }, temp, lifecycle) => {
    lifecycle.dbData.users = { a: { authVersion: "new-version" } };
    await assert.rejects(
      parseReceipt({
        userKey: "a",
        authVersion: "old-version",
        file: { mimetype: "image/jpeg", buffer: jpeg(1200, 1600) },
      }, fakeRes()),
      (error) => error.code === "AUTH_STALE",
    );
    assert.strictEqual(fs.existsSync(path.join(temp, "uploads", "a")), false);
  });
});
