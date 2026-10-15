"use strict";

// Purchase detection for the MoneyMinder extension. Pure functions only — no
// DOM, no chrome APIs — so they can be unit-tested under Node (see detect.test.js)
// and reused by content.js, which feeds them the page's JSON-LD and visible text.
//
// The bar for "this page is a spend" is deliberately high: a structured Order /
// Invoice, or an order-confirmation / receipt page with a clear total. Browsing a
// product is not a purchase, so a bare Product/Offer is ignored on purpose.

// Pull a money amount out of a string. Prefers a currency-tagged number, then a
// decimal, then a grouped integer, then a bare integer as a last resort.
function parseAmount(str) {
  const s = String(str);
  const m =
    s.match(/(?:₹|rs\.?|inr|\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i) ||
    s.match(/([0-9][0-9,]*\.[0-9]{1,2})/) ||
    s.match(/\b([0-9]{1,3}(?:,[0-9]{2,3})+)\b/) ||
    s.match(/\b([0-9]+)\b/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const NON_INR_CURRENCY_CODE_RE =
  /\b(?:USD|EUR|GBP|JPY|CNY|RMB|AUD|CAD|CHF|HKD|SGD|NZD|AED|SAR|QAR|KWD|BHD|OMR|MYR|THB|IDR|PHP|KRW|VND|ZAR|BRL|MXN|TRY|RUB|PLN|SEK|NOK|DKK|PKR|LKR|BDT|NPR)\b/i;

function currencyFromText(text) {
  const value = String(text);
  const symbols = value.match(/\p{Sc}/gu) || [];
  if (symbols.some((symbol) => symbol !== "₹") || NON_INR_CURRENCY_CODE_RE.test(value)) {
    return "NON_INR";
  }
  if (/₹|\bINR\b|\bRs\.?/i.test(value)) return "INR";
  return null;
}

// Total labels, strongest first. A "paid/order/grand total" beats a plain "total".
const TOTAL_LABELS = [
  { re: /\b(amount\s*paid|you\s*paid|order\s*total|grand\s*total|total\s*paid|amount\s*due|total\s*amount|net\s*payable|paid\s*amount)\b/i, weight: 2 },
  { re: /\btotal\b/i, weight: 1 },
];

// Scan visible text line-by-line for a labelled total. Returns the strongest-
// labelled, largest amount found, or null.
function findTotalInText(text) {
  const lines = String(text)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 1200);
  let best = null;
  for (const line of lines) {
    if (line.length > 140) continue;
    for (const { re, weight } of TOTAL_LABELS) {
      if (!re.test(line)) continue;
      const amount = parseAmount(line);
      if (amount != null && amount > 0) {
        if (!best || weight > best.weight || (weight === best.weight && amount > best.amount)) {
          best = { amount, weight, label: line };
        }
      }
      break;
    }
  }
  return best
    ? { amount: best.amount, currency: currencyFromText(best.label), label: best.label }
    : null;
}

function num(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function ldName(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v.name) return String(v.name);
  return null;
}

// Extract an amount/currency/merchant from a parsed JSON-LD node. Only Order and
// Invoice count as a real transaction; everything else returns null. Walks arrays
// and @graph so it works whatever the site nests its data in.
function extractFromJsonLd(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = extractFromJsonLd(n);
      if (r) return r;
    }
    return null;
  }
  if (node["@graph"]) {
    const r = extractFromJsonLd(node["@graph"]);
    if (r) return r;
  }
  const type = String(node["@type"] || "").toLowerCase();
  if (type.includes("order")) {
    const spec = node.orderTotal || node.priceSpecification || {};
    const amount = num(spec.value != null ? spec.value : spec.price) ?? num(node.price);
    if (amount != null) {
      return { amount, currency: spec.priceCurrency || node.priceCurrency || null, merchant: ldName(node.seller || node.merchant) };
    }
  }
  if (type.includes("invoice")) {
    const due = node.totalPaymentDue || {};
    const amount = num(due.price != null ? due.price : due.value);
    if (amount != null) {
      return { amount, currency: due.priceCurrency || null, merchant: ldName(node.provider || node.seller) };
    }
  }
  return null;
}

// "www.amazon.in" -> "Amazon". Handles two-level suffixes like ".co.in".
function merchantFromHost(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  const parts = h.split(".").filter(Boolean);
  const twoLevel = ["co", "com", "net", "org", "gov", "ac", "edu"];
  let label = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || "";
  if (parts.length >= 3 && twoLevel.includes(parts[parts.length - 2])) {
    label = parts[parts.length - 3];
  }
  if (!label) return "Web purchase";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Map a merchant/host to one of MoneyMinder's buckets. Just a prefill — the user
// can change it before tracking.
const CATEGORY_RULES = [
  { re: /(swiggy|zomato|ubereats|dominos|pizza|restaurant|cafe|\bfood\b|grocery|bigbasket|blinkit|zepto|instamart|dunzo)/i, cat: "food" },
  { re: /(uber|\bola\b|rapido|irctc|makemytrip|goibibo|redbus|ixigo|cleartrip|flight|airlines|indigo|spicejet|railway|\bmetro\b|petrol|\bfuel\b)/i, cat: "travel" },
  { re: /(\brent\b|electricity|broadband|wifi|airtel|\bjio\b|vodafone|bescom|\bwater\b|\bgas\b|housing|maintenance|\bdth\b|tata\s*power)/i, cat: "housing" },
  { re: /(amazon|flipkart|myntra|ajio|meesho|nykaa|\bstore\b|\bshop\b|\bmall\b|retail|tatacliq|croma|reliance)/i, cat: "misc" },
];

function guessCategory(merchant, host) {
  const hay = `${merchant || ""} ${host || ""}`;
  for (const { re, cat } of CATEGORY_RULES) {
    if (re.test(hay)) return cat;
  }
  return "other";
}

const PURCHASE_URL_RE = /(order[-_]?confirmation|orderconfirm|thank[-_]?you|thankyou|receipt|invoice|payment[-_]?success|order[-_]?complete|order[-_]?placed|orders?\/|checkout\/success|\/order\/|booking[-_]?confirm)/i;
const PURCHASE_TEXT_RE = /(thank you for your (order|purchase)|your order (is |has been )?(confirmed|placed)|payment (was )?successful|order confirmation|order placed|booking confirmed|payment received|successfully placed)/i;

// Does this page look like a completed purchase (not a product/cart page)?
function classifyPurchasePage(url, text) {
  return PURCHASE_URL_RE.test(String(url || "")) || PURCHASE_TEXT_RE.test(String(text || "").slice(0, 8000));
}

function finalize(found, host, source) {
  const merchant = found.merchant || merchantFromHost(host);
  return {
    amount: Math.round(found.amount * 100) / 100,
    currency: "INR",
    merchant,
    category: guessCategory(merchant, host),
    source,
  };
}

// Given everything content.js gathered from the page, return a spend candidate or
// null. Structured Order/Invoice data wins; otherwise a confirmation page with a
// readable total. Anything weaker is intentionally not a "spend".
function buildCandidate({ jsonLd, url, host, text }) {
  for (const node of jsonLd || []) {
    const found = extractFromJsonLd(node);
    if (found && found.amount > 0) {
      return !found.currency || String(found.currency).toUpperCase() === "INR"
        ? finalize(found, host, "order")
        : null;
    }
  }
  if (classifyPurchasePage(url, text)) {
    const total = findTotalInText(text);
    if (total && total.amount > 0 && (!total.currency || total.currency === "INR")) {
      return finalize({ amount: total.amount, currency: "INR", merchant: null }, host, "page");
    }
  }
  return null;
}

const MMDetect = {
  parseAmount,
  findTotalInText,
  extractFromJsonLd,
  merchantFromHost,
  guessCategory,
  classifyPurchasePage,
  buildCandidate,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = MMDetect;
} else if (typeof globalThis !== "undefined") {
  globalThis.MMDetect = MMDetect;
}
