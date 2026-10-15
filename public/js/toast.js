// Tiny global toasts. window.Toast.show(msg, type) — type: ok | error | info.
// Stacked, auto-dismissing, announced via aria-live regions. ponytail: no libs.
// Errors go to an assertive region; ok/info to a polite one (no role/region
// mismatch). Toasts never steal focus.
(function () {
  // Two regions so politeness matches urgency.
  const regions = {};
  function ensureRegion(assertive) {
    const key = assertive ? "assertive" : "polite";
    if (regions[key]) return regions[key];
    const el = document.createElement("div");
    el.className = "toast-region";
    el.setAttribute("aria-live", assertive ? "assertive" : "polite");
    el.setAttribute("aria-atomic", "false");
    document.body.appendChild(el);
    regions[key] = el;
    return el;
  }

  function show(msg, type) {
    const isError = type === "error";
    const r = ensureRegion(isError);
    const t = document.createElement("div");
    t.className = "toast toast--" + (type || "info");
    t.textContent = String(msg == null ? "" : msg);
    r.appendChild(t);
    // Trigger the enter transition on the next frame.
    requestAnimationFrame(() => t.classList.add("is-in"));
    const ttl = isError ? 5000 : 3200;
    let dismissed = false;
    let timer;
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      document.removeEventListener("keydown", onKey);
      t.classList.remove("is-in");
      t.addEventListener("transitionend", () => t.remove(), { once: true });
      // Fallback if transitions are off (reduced motion).
      setTimeout(() => t.remove(), 400);
    };
    function close() { clearTimeout(timer); dismiss(); }
    timer = setTimeout(dismiss, ttl);
    t.addEventListener("click", close);
    // Keyboard dismiss without stealing focus from the page.
    document.addEventListener("keydown", onKey);
  }

  window.Toast = { show };
})();
