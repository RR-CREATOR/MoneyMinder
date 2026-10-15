// First-run onboarding for the dashboard: a tiny 3-step coachmark sequence,
// shown once (tracked in localStorage), skippable. ponytail: no library.
(function () {
  const KEY = "onboarded";
  const STEPS = [
    { title: "Scan a receipt", body: "Tap Scan to snap a bill — we read the total and sort it into a category for you." },
    { title: "Your true cost of living", body: "This big number is your personal spend plus your share of shared bills — the full picture." },
    { title: "Roommates", body: "Open Roommates to split costs, see who owes who, and settle up in one tap." },
  ];

  function seen() {
    try { return localStorage.getItem(KEY) === "1"; } catch { return true; }
  }
  function markSeen() {
    try { localStorage.setItem(KEY, "1"); } catch { /* ignore */ }
  }

  function start() {
    if (seen()) return;
    let i = 0;

    // Remember what was focused so we can restore it on close.
    const lastFocused = document.activeElement;

    const overlay = document.createElement("div");
    overlay.className = "coach-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "coach-title");

    const card = document.createElement("div");
    card.className = "coach-card";
    overlay.appendChild(card);

    function render() {
      const s = STEPS[i];
      const dots = STEPS.map((_, k) =>
        '<span class="coach-dot' + (k === i ? " is-on" : "") + '"></span>'
      ).join("");
      card.innerHTML =
        '<div class="coach-step">' + (i + 1) + " of " + STEPS.length + "</div>" +
        '<h2 id="coach-title">' + s.title + "</h2>" +
        "<p>" + s.body + "</p>" +
        '<div class="coach-dots" aria-hidden="true">' + dots + "</div>" +
        '<div class="coach-actions">' +
        '<button class="btn btn--ghost btn--auto" id="coach-skip" type="button">Skip</button>' +
        '<button class="btn btn--auto" id="coach-next" type="button">' +
        (i === STEPS.length - 1 ? "Got it" : "Next") + "</button></div>";
      card.querySelector("#coach-skip").addEventListener("click", done);
      card.querySelector("#coach-next").addEventListener("click", () => {
        if (i === STEPS.length - 1) return done();
        i++;
        render();
      });
      card.querySelector("#coach-next").focus();
    }

    function done() {
      markSeen();
      overlay.classList.remove("is-in");
      overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
      setTimeout(() => overlay.remove(), 400);
      // Restore focus to wherever it was before the dialog opened.
      if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
    }

    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(); });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { done(); return; }
      if (e.key !== "Tab") return;
      // Trap Tab/Shift+Tab within the dialog's focusable elements.
      const items = card.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("is-in"));
    render();
  }

  window.Onboard = { start };
})();
