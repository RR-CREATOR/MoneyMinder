const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

test("userDir permits one safe child and rejects dot-segment identities", () => {
  const dbPath = require.resolve("./db");
  const uploadsPath = path.join(__dirname, "uploads.js");
  const real = require.cache[dbPath];
  const root = path.resolve("isolated-data");
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { dir: root },
  };
  delete require.cache[uploadsPath];
  try {
    const uploads = require("./uploads");
    assert.strictEqual(uploads.userDir("alice"), path.join(root, "uploads", "alice"));
    for (const key of [".", "..", "../alice", "alice/bob", ""]) {
      assert.throws(() => uploads.userDir(key), /Invalid user key/);
    }
    assert.strictEqual(
      uploads.imagePath("alice", "../receipt.jpg"),
      path.join(root, "uploads", "alice", "receipt.jpg"),
    );
  } finally {
    require.cache[dbPath] = real;
    delete require.cache[uploadsPath];
  }
});

test("failed image removal remains queued and succeeds after a module restart", async () => {
  const dbPath = require.resolve("./db");
  const uploadsPath = path.join(__dirname, "uploads.js");
  const realDb = require.cache[dbPath];
  const realRm = fs.promises.rm;
  const store = { users: {}, receipts: {} };
  const root = path.resolve("isolated-data");
  const fakeDb = {
    dir: root,
    load: async () => store,
    update: async (handler) => handler(store),
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
  delete require.cache[uploadsPath];
  let attempts = 0;
  fs.promises.rm = async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
  };
  try {
    let uploads = require("./uploads");
    uploads.queueImageDelete(store, "alice", "receipt.jpg");

    assert.deepStrictEqual(await uploads.retryPendingDeletes(), { pending: 1 });
    assert.strictEqual(Object.keys(store.pendingUploadDeletes).length, 1);

    delete require.cache[uploadsPath];
    uploads = require("./uploads");
    assert.deepStrictEqual(await uploads.retryPendingDeletes(), { pending: 0 });
    assert.strictEqual(store.pendingUploadDeletes, undefined);
    assert.strictEqual(attempts, 2);
  } finally {
    fs.promises.rm = realRm;
    require.cache[dbPath] = realDb;
    delete require.cache[uploadsPath];
  }
});

test("retry never removes a queued image that became referenced again", async () => {
  const dbPath = require.resolve("./db");
  const uploadsPath = path.join(__dirname, "uploads.js");
  const realDb = require.cache[dbPath];
  const realRm = fs.promises.rm;
  const store = { users: {}, receipts: {} };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      dir: path.resolve("isolated-data"),
      load: async () => store,
      update: async (handler) => handler(store),
    },
  };
  delete require.cache[uploadsPath];
  let attempts = 0;
  fs.promises.rm = async () => { attempts++; };
  try {
    const uploads = require("./uploads");
    uploads.queueImageDelete(store, "alice", "receipt.jpg");
    store.receipts.reused = { userKey: "alice", image: "receipt.jpg" };

    assert.deepStrictEqual(await uploads.retryPendingDeletes(), { pending: 0 });
    assert.strictEqual(attempts, 0);
    assert.strictEqual(store.pendingUploadDeletes, undefined);
  } finally {
    fs.promises.rm = realRm;
    require.cache[dbPath] = realDb;
    delete require.cache[uploadsPath];
  }
});

test("background retries persistent rm failures with exponential backoff", async () => {
  const dbPath = require.resolve("./db");
  const uploadsPath = path.join(__dirname, "uploads.js");
  const realDb = require.cache[dbPath];
  const realRm = fs.promises.rm;
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const store = { users: {}, receipts: {} };
  const timers = [];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      dir: path.resolve("isolated-data"),
      update: async (handler) => handler(store),
    },
  };
  delete require.cache[uploadsPath];
  fs.promises.rm = async () => {
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  };
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = () => {};
  try {
    const uploads = require("./uploads");
    uploads.queueImageDelete(store, "alice", "receipt.jpg");
    uploads.startDeleteRetries();

    let timer = timers.shift();
    assert.strictEqual(timer.delay, 0);
    await timer.callback();
    timer = timers.shift();
    assert.strictEqual(timer.delay, 1000);
    await timer.callback();
    timer = timers.shift();
    assert.strictEqual(timer.delay, 2000);
    assert.strictEqual(Object.keys(store.pendingUploadDeletes).length, 1);
    await uploads.stopDeleteRetries();
  } finally {
    fs.promises.rm = realRm;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    require.cache[dbPath] = realDb;
    delete require.cache[uploadsPath];
  }
});

test("enqueue during a completed drain is not lost by the in-memory retry flag", async () => {
  const dbPath = require.resolve("./db");
  const uploadsPath = path.join(__dirname, "uploads.js");
  const realDb = require.cache[dbPath];
  const realRm = fs.promises.rm;
  const store = { users: {}, receipts: {} };
  let uploads;
  let updates = 0;
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      dir: path.resolve("isolated-data"),
      async update(handler) {
        updates++;
        const result = await handler(store);
        if (updates === 1) uploads.queueImageDelete(store, "alice", "late.jpg");
        return result;
      },
    },
  };
  delete require.cache[uploadsPath];
  const removed = [];
  fs.promises.rm = async (target) => { removed.push(path.basename(target)); };
  try {
    uploads = require("./uploads");
    uploads.queueImageDelete(store, "alice", "first.jpg");

    await uploads.retryPendingDeletes();
    await uploads.retryPendingDeletes();

    assert.deepStrictEqual(removed, ["first.jpg", "late.jpg"]);
    assert.strictEqual(store.pendingUploadDeletes, undefined);
  } finally {
    fs.promises.rm = realRm;
    require.cache[dbPath] = realDb;
    delete require.cache[uploadsPath];
  }
});

test("retry drops invalid outbox tasks without touching the filesystem", async () => {
  const dbPath = require.resolve("./db");
  const uploadsPath = path.join(__dirname, "uploads.js");
  const realDb = require.cache[dbPath];
  const realRm = fs.promises.rm;
  const store = {
    users: {},
    receipts: {},
    pendingUploadDeletes: {
      malformed: { kind: "image", userKey: "../escape", name: "../receipt.jpg" },
      missing: null,
    },
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      dir: path.resolve("isolated-data"),
      update: async (handler) => handler(store),
    },
  };
  delete require.cache[uploadsPath];
  let attempts = 0;
  fs.promises.rm = async () => { attempts++; };
  try {
    const uploads = require("./uploads");
    assert.deepStrictEqual(await uploads.retryPendingDeletes(), { pending: 0 });
    assert.strictEqual(store.pendingUploadDeletes, undefined);
    assert.strictEqual(attempts, 0);
  } finally {
    fs.promises.rm = realRm;
    require.cache[dbPath] = realDb;
    delete require.cache[uploadsPath];
  }
});
