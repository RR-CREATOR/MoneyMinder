// Hand-rolled inline SVG charts — no library. Exposed as window.Charts.
// Each function returns an SVG string ready to drop into innerHTML. All data is
// numeric (no user text), so no escaping is needed here.
(function () {
  const NS = 'viewBox="0 0 %w %h" xmlns="http://www.w3.org/2000/svg"';

  // Indigo-family palette, one colour per category bucket.
  const COLORS = {
    food: "#4f46e5",
    travel: "#7c3aed",
    housing: "#0ea5e9",
    misc: "#f59e0b",
    other: "#94a3b8",
  };
  const LABELS = {
    food: "Food",
    travel: "Travel",
    housing: "Housing",
    misc: "Misc",
    other: "Other",
  };

  function formatAmount(value) {
    let amount = Number(value);
    if (!Number.isFinite(amount) || Object.is(amount, -0)) amount = 0;
    return amount.toLocaleString("en-IN", {
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    });
  }

  // Point on a circle for a given fraction (0..1) of the way round, starting at
  // 12 o'clock and going clockwise.
  function pt(cx, cy, r, frac) {
    const a = frac * 2 * Math.PI - Math.PI / 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  // Donut: stacked arcs, one per category, sized by share of the total. Returns
  // an <svg> plus an HTML legend.
  function donut(categories) {
    const size = 180;
    const cx = size / 2;
    const cy = size / 2;
    const r = 70;
    const inner = 44;
    const keys = Object.keys(COLORS).filter((k) => (categories[k] || 0) > 0);
    const total = keys.reduce((s, k) => s + categories[k], 0);

    const open = (label) =>
      '<svg class="chart-svg" ' + NS.replace("%w", size).replace("%h", size) +
      ' role="img" aria-label="' + label + '">';

    if (!total) {
      // Empty ring so the card never looks broken. Neutral colours follow the
      // Neutral colours follow the shared design tokens.
      let svg = open("Spending by category: no spend yet") +
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="' + (r - inner) + '"/>' +
        '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="central" fill="var(--muted)" font-size="12">No spend yet</text></svg>';
      return { svg, legend: "" };
    }

    // Spell out each slice for the SVG's aria-label (screen-reader data).
    const labelParts = keys.map((k) => {
      const pct = Math.round((categories[k] / total) * 100);
      return LABELS[k] + " ₹" + formatAmount(categories[k]) + " (" + pct + "%)";
    });
    const ariaLabel =
      "Spending by category, total ₹" + formatAmount(total) +
      ": " + labelParts.join(", ");

    let svg = open(ariaLabel);

    let body = "";
    let acc = 0;
    for (const k of keys) {
      const frac = categories[k] / total;
      // A single ~100% slice can't be drawn as one arc (start == end collapses
      // it). Render a full ring as a stroked <circle> instead.
      if (frac >= 0.9999) {
        body += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ((r + inner) / 2) +
          '" fill="none" stroke="' + COLORS[k] + '" stroke-width="' + (r - inner) + '"/>';
        acc = 1;
        continue;
      }
      const start = acc;
      const end = acc + frac;
      acc = end;
      const large = frac > 0.5 ? 1 : 0;
      const [x1, y1] = pt(cx, cy, r, start);
      const [ex2, ey2] = pt(cx, cy, r, end);
      const [iex2, iey2] = pt(cx, cy, inner, end);
      const [ix1, iy1] = pt(cx, cy, inner, start);
      const d =
        "M " + x1.toFixed(2) + " " + y1.toFixed(2) +
        " A " + r + " " + r + " 0 " + large + " 1 " + ex2.toFixed(2) + " " + ey2.toFixed(2) +
        " L " + iex2.toFixed(2) + " " + iey2.toFixed(2) +
        " A " + inner + " " + inner + " 0 " + large + " 0 " + ix1.toFixed(2) + " " + iy1.toFixed(2) +
        " Z";
      body += '<path d="' + d + '" fill="' + COLORS[k] + '"/>';
    }
    svg += body;
    // Hollow centre label = total.
    svg +=
      '<text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" fill="var(--muted)" font-size="10" letter-spacing="0.5">TOTAL</text>' +
      '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" fill="var(--ink)" font-size="18" font-weight="700">₹' +
      formatAmount(total) + "</text></svg>";

    let legend = '<ul class="chart-legend">';
    for (const k of keys) {
      const pct = Math.round((categories[k] / total) * 100);
      legend +=
        '<li><span class="chart-dot" style="background:' + COLORS[k] + '"></span>' +
        LABELS[k] + ' <span class="muted">' + pct + "%</span></li>";
    }
    legend += "</ul>";
    return { svg, legend };
  }

  // 14-day trend: filled area + line over a series of {date, amount}. Returns an
  // <svg> string sized to the viewBox (scales to its container width).
  function trend(daily) {
    const w = 320;
    const h = 130;
    const padX = 6;
    const padTop = 10;
    const padBottom = 18;

    if (!daily || !daily.length) {
      // Empty state mirrors the donut so daily[-1] is never accessed.
      return '<svg class="chart-svg chart-trend" ' + NS.replace("%w", w).replace("%h", h) +
        ' role="img" aria-label="Daily spend over the last 14 days: no spend yet" preserveAspectRatio="none">' +
        '<line x1="' + padX + '" y1="' + (h - padBottom) + '" x2="' + (w - padX) + '" y2="' + (h - padBottom) + '" stroke="var(--line)" stroke-width="1"/>' +
        '<text x="' + (w / 2) + '" y="' + (h / 2) + '" text-anchor="middle" dominant-baseline="central" fill="var(--muted)" font-size="12">No spend yet</text></svg>';
    }

    const n = daily.length;
    const max = Math.max(1, ...daily.map((d) => d.amount));
    const innerW = w - padX * 2;
    const innerH = h - padTop - padBottom;
    const x = (i) => padX + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = (v) => padTop + innerH - (v / max) * innerH;

    let line = "";
    let area = "M " + x(0).toFixed(1) + " " + (padTop + innerH).toFixed(1);
    daily.forEach((d, i) => {
      const px = x(i).toFixed(1);
      const py = y(d.amount).toFixed(1);
      line += (i === 0 ? "M " : "L ") + px + " " + py + " ";
      area += " L " + px + " " + py;
    });
    area += " L " + x(n - 1).toFixed(1) + " " + (padTop + innerH).toFixed(1) + " Z";

    // Screen-reader summary: total over the window and the peak day.
    const sum = daily.reduce((s, d) => s + (Number(d.amount) || 0), 0);
    const peak = daily.reduce((a, b) => (b.amount > a.amount ? b : a), daily[0]);
    const ariaLabel =
      "Daily spend over the last 14 days, total ₹" + formatAmount(sum) +
      ", peak ₹" + formatAmount(peak.amount) + " on " + peak.date;

    let svg =
      '<svg class="chart-svg chart-trend" ' + NS.replace("%w", w).replace("%h", h) +
      ' role="img" aria-label="' + ariaLabel + '" preserveAspectRatio="none">';
    // Baseline. Neutrals follow the theme; the line uses the accent token.
    svg += '<line x1="' + padX + '" y1="' + (padTop + innerH) + '" x2="' + (w - padX) + '" y2="' + (padTop + innerH) + '" stroke="var(--line)" stroke-width="1"/>';
    svg += '<path d="' + area + '" fill="var(--accent)" fill-opacity="0.14"/>';
    svg += '<path d="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
    // Mark the last point.
    if (n) {
      svg += '<circle cx="' + x(n - 1).toFixed(1) + '" cy="' + y(daily[n - 1].amount).toFixed(1) + '" r="3" fill="var(--accent)"/>';
    }
    // End-date tick labels (first + last) for context.
    if (n) {
      const lab = (s) => s.slice(8) + "/" + s.slice(5, 7);
      svg += '<text x="' + padX + '" y="' + (h - 5) + '" fill="var(--muted)" font-size="9">' + lab(daily[0].date) + "</text>";
      svg += '<text x="' + (w - padX) + '" y="' + (h - 5) + '" text-anchor="end" fill="var(--muted)" font-size="9">' + lab(daily[n - 1].date) + "</text>";
    }
    svg += "</svg>";
    return svg;
  }

  window.Charts = { donut, trend, COLORS, LABELS };
})();
