// Shared PWA glue. MoneyMinder intentionally ships one accessible light theme.
(function () {
  document.documentElement.removeAttribute("data-theme");
  try { localStorage.removeItem("theme"); } catch { /* storage may be blocked */ }
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* progressive enhancement */
      });
    });
  }
})();
