const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("path");
const db = require("./db");

const root = path.resolve(db.dir, "uploads");
const USER_KEY = /^[a-z0-9_.-]{1,32}$/i;
const OUTBOX = "pendingUploadDeletes";
const MIN_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60000;

function userDir(userKey) {
  const segment = String(userKey || "");
  if (!USER_KEY.test(segment) || segment === "." || segment === "..") {
    throw new Error("Invalid user key");
  }
  const dir = path.resolve(root, segment);
  if (path.dirname(dir) !== root) throw new Error("Invalid user key");
  return dir;
}

function imagePath(userKey, name) {
  const filename = path.basename(String(name || ""));
  if (!filename || filename === "." || filename === "..") throw new Error("Invalid image name");
  return path.join(userDir(userKey), filename);
}

function tasks(data) {
  if (!data[OUTBOX] || Array.isArray(data[OUTBOX]) || typeof data[OUTBOX] !== "object") {
    data[OUTBOX] = {};
  }
  return data[OUTBOX];
}

let retryNeeded = true;
let retryQueue = Promise.resolve();
let retryGeneration = 0;
let retryTimer;
let retryDelay = MIN_RETRY_DELAY_MS;
let workerStarted = false;

function queued() {
  retryGeneration++;
  retryNeeded = true;
  scheduleRetry(0);
}

function queueImageDelete(data, userKey, name) {
  const filename = path.basename(String(name || ""));
  imagePath(userKey, filename);
  const pending = tasks(data);
  if (Object.values(pending).some((task) => (
    task && task.userKey === userKey
    && (task.kind === "user" || (task.kind === "image" && task.name === filename))
  ))) return;
  pending[crypto.randomUUID()] = { kind: "image", userKey, name: filename };
  queued();
}

function queueUserDelete(data, userKey) {
  userDir(userKey);
  const pending = tasks(data);
  for (const [id, task] of Object.entries(pending)) {
    if (task && task.userKey === userKey) delete pending[id];
  }
  pending[crypto.randomUUID()] = { kind: "user", userKey };
  queued();
}

function userDeletionPending(data, userKey) {
  const pending = data && data[OUTBOX];
  return !!pending && !Array.isArray(pending) && Object.values(pending)
    .some((task) => task && task.kind === "user" && task.userKey === userKey);
}

function validTask(task) {
  if (!task || typeof task !== "object") return false;
  if (typeof task.userKey !== "string") return false;
  try {
    if (task.kind === "user") return userDir(task.userKey);
    if (task.kind === "image" && typeof task.name === "string"
        && path.basename(task.name) === task.name) {
      return imagePath(task.userKey, task.name);
    }
  } catch {}
  return false;
}

async function drainPendingDeletes() {
  return db.update(async (data) => {
    const pending = data[OUTBOX];
    if (pending === undefined) {
      return { pending: 0 };
    }
    if (!pending || Array.isArray(pending) || typeof pending !== "object") {
      delete data[OUTBOX];
      return { pending: 0 };
    }
    for (const [id, task] of Object.entries(pending)) {
      const target = validTask(task);
      if (!target) {
        delete pending[id];
        continue;
      }
      if (task.kind === "user" && data.users && data.users[task.userKey]) continue;
      if (task.kind === "image" && Object.values(data.receipts || {}).some(
        (receipt) => receipt.userKey === task.userKey && receipt.image === task.name,
      )) {
        delete pending[id];
        continue;
      }
      try {
        await fs.promises.rm(target, task.kind === "user"
          ? { recursive: true, force: true }
          : { force: true });
        delete pending[id];
      } catch {}
    }
    const count = Object.keys(pending).length;
    if (!count) delete data[OUTBOX];
    return { pending: count };
  });
}

function retryPendingDeletes() {
  const run = retryQueue.then(async () => {
    if (!retryNeeded) return { pending: 0 };
    const generation = retryGeneration;
    const result = await drainPendingDeletes();
    retryNeeded = result.pending > 0 || retryGeneration !== generation;
    return result;
  });
  retryQueue = run.catch(() => {});
  return run;
}

function scheduleRetry(delay) {
  if (!workerStarted || retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = undefined;
    let pending = true;
    try {
      const result = await retryPendingDeletes();
      pending = result.pending > 0 || retryNeeded;
    } catch (error) {
      console.error(JSON.stringify({
        type: "upload_cleanup_error",
        code: error && error.code ? String(error.code) : "",
      }));
    }
    if (!workerStarted) return;
    if (!pending) {
      retryDelay = MIN_RETRY_DELAY_MS;
      return;
    }
    const nextDelay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    scheduleRetry(nextDelay);
  }, delay);
  if (retryTimer.unref) retryTimer.unref();
}

function startDeleteRetries() {
  if (workerStarted) return;
  workerStarted = true;
  retryDelay = MIN_RETRY_DELAY_MS;
  scheduleRetry(0);
}

async function stopDeleteRetries() {
  workerStarted = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  await retryQueue;
}

module.exports = {
  root,
  userDir,
  imagePath,
  queueImageDelete,
  queueUserDelete,
  userDeletionPending,
  retryPendingDeletes,
  startDeleteRetries,
  stopDeleteRetries,
};
