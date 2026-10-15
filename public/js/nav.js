// Shared bottom navigation. Call renderNav("<active page>.html") after the
// <nav class="nav"> element. Scan is the emphasized center button.
function renderNav(active) {
  const tabs = [
    {
      href: "receipts.html",
      label: "Receipts",
      icon: '<path d="M6 2h9l4 4v16l-3-2-2 2-2-2-2 2-2-2-2 2V2z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    },
    {
      href: "index.html",
      label: "Budget",
      icon: '<path d="M3 3v18h18"/><path d="M7 14l3-4 3 3 4-6"/>',
    },
    { href: "scan.html", label: "Scan", scan: true,
      icon: '<path d="M4 8a2 2 0 0 1 2-2h1.6l1-1.6h4.8l1 1.6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"/><circle cx="12" cy="12.5" r="3.2"/>',
    },
    {
      href: "household.html",
      label: "Roommates",
      icon: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><path d="M15 20c0-2 1-3.2 2.5-3.7"/>',
    },
    {
      href: "profile.html",
      label: "Profile",
      icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
    },
  ];

  const nav = document.querySelector(".nav");
  const inner = document.createElement("div");
  inner.className = "nav-inner";

  for (const t of tabs) {
    const a = document.createElement("a");
    a.href = t.href;
    if (t.href === active) a.setAttribute("aria-current", "page");
    const svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + t.icon + "</svg>";
    if (t.scan) {
      a.className = "nav-scan";
      a.innerHTML = '<span class="scan-fab">' + svg + '</span><span class="scan-label">' + t.label + "</span>";
    } else {
      a.innerHTML = svg + "<span>" + t.label + "</span>";
    }
    inner.appendChild(a);
  }

  nav.appendChild(inner);
}
