"use strict";

// Runs at document_idle only after the user opts into page detection. Reads the
// page locally, asks whether it looks like a completed purchase, and tells the worker.
// Nothing is sent anywhere off-device — the only consumer is our own service
// worker, which lights the toolbar badge. The actual spend is saved only when the
// user taps "Track" in the popup.

(function () {
  if (typeof document === "undefined" || !chrome.runtime || !chrome.runtime.id) return;

  // The worker owns local storage so bearer tokens are never exposed here.
  chrome.runtime.sendMessage({ type: "detect-enabled" }, (enabled) => {
    if (chrome.runtime.lastError || enabled !== true) return;
    try {
      report(detect());
    } catch (e) {
      // Detection must never break the page it runs on.
    }
  });

  function detect() {
    const detector = globalThis.MMDetect;
    if (!detector) return null;

    const jsonLd = [];
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        jsonLd.push(JSON.parse(el.textContent));
      } catch (e) {
        // Skip malformed JSON-LD.
      }
    }

    // Read the page's visible text only on URLs that already look like an order /
    // receipt page. JSON-LD detection above needs no page text, so the great
    // majority of pages are never bulk-read.
    const looksLikePurchase = detector.classifyPurchasePage(location.href, "");
    const text =
      looksLikePurchase && document.body && document.body.innerText ? document.body.innerText : "";

    return detector.buildCandidate({
      jsonLd,
      url: location.href,
      host: location.hostname,
      text,
    });
  }

  function report(candidate) {
    const message = candidate
      ? { type: "spend-detected", candidate }
      : { type: "spend-none" };
    // Swallow "receiving end does not exist" if the worker is briefly asleep.
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch (e) {
      /* worker unavailable; ignore */
    }
  }
})();
