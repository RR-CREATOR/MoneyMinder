// Tiny same-origin fetch helper. Exposed as window.API.
(function () {
  const onAuthPage = /\/(login|register)\.html$/.test(location.pathname);

  function toLogin() {
    if (!onAuthPage) location.href = "login.html";
  }

  // Parse JSON if there is any; tolerate empty bodies.
  async function readBody(res) {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  async function handle(res) {
    const body = await readBody(res);
    if (res.status === 401) {
      toLogin();
      throw new Error(body.error || "Not authenticated");
    }
    if (!res.ok) {
      throw new Error(body.error || "Something went wrong");
    }
    return body;
  }

  async function get(path) {
    return handle(await fetch(path, { credentials: "same-origin" }));
  }

  async function post(path, bodyObj, idempotencyKey, options = {}) {
    const headers = { "Content-Type": "application/json" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    return handle(
      await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify(bodyObj || {}),
        keepalive: options.keepalive === true,
      })
    );
  }

  function operationKey(element, bodyObj) {
    const signature = JSON.stringify(bodyObj || {});
    if (element.dataset.idempotencyBody !== signature) {
      element.dataset.idempotencyBody = signature;
      element.dataset.idempotencyKey = crypto.randomUUID();
    }
    return element.dataset.idempotencyKey;
  }

  function clearOperation(element) {
    delete element.dataset.idempotencyBody;
    delete element.dataset.idempotencyKey;
  }

  async function patch(path, bodyObj) {
    return handle(
      await fetch(path, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj || {}),
      })
    );
  }

  async function del(path, bodyObj) {
    return handle(
      await fetch(path, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj || {}),
      })
    );
  }

  // Multipart: let the browser set Content-Type (with the boundary).
  async function postForm(path, formData) {
    return handle(
      await fetch(path, { method: "POST", credentials: "same-origin", body: formData })
    );
  }

  async function requireUser() {
    const { user } = await get("/api/me");
    return user;
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function formatMoney(value, absolute = false) {
    let amount = Number(value);
    if (!Number.isFinite(amount)) amount = 0;
    if (absolute) amount = Math.abs(amount);
    if (Object.is(amount, -0)) amount = 0;
    return "₹" + amount.toLocaleString("en-IN", {
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    });
  }

  window.API = {
    get,
    post,
    patch,
    del,
    postForm,
    requireUser,
    escapeHtml,
    formatMoney,
    operationKey,
    clearOperation,
  };
})();
