"use strict";

const test = require("node:test");
const assert = require("node:assert");
const D = require("./detect");

test("parseAmount handles currency symbols, commas, decimals", () => {
  assert.strictEqual(D.parseAmount("₹1,299.00"), 1299);
  assert.strictEqual(D.parseAmount("Rs. 499"), 499);
  assert.strictEqual(D.parseAmount("INR 2,499.50"), 2499.5);
  assert.strictEqual(D.parseAmount("Order Total: 1,299"), 1299);
  assert.strictEqual(D.parseAmount("Order Total: 42"), 42);
  assert.strictEqual(D.parseAmount("$45.99"), 45.99);
  assert.strictEqual(D.parseAmount("no money here"), null);
});

test("findTotalInText prefers the strongest label", () => {
  const text = [
    "Subtotal ₹1,000.00",
    "Delivery ₹50.00",
    "Total ₹1,050.00",
    "Amount Paid ₹1,050.00",
  ].join("\n");
  const r = D.findTotalInText(text);
  assert.ok(r);
  assert.strictEqual(r.amount, 1050);
});

test("findTotalInText: a stronger label beats a larger weak-label amount", () => {
  const text = "Total ₹9,999.00\nAmount Paid ₹1,200.00";
  const r = D.findTotalInText(text);
  assert.ok(r);
  assert.strictEqual(r.amount, 1200);
});

test("findTotalInText ignores pages with no total", () => {
  assert.strictEqual(D.findTotalInText("Welcome to our store\nBrowse products"), null);
});

test("findTotalInText handles currency-free totals and ignores unusable lines", () => {
  const text = [
    `Total ${"x".repeat(141)} 999`,
    "Total unavailable",
    "Total 0",
    "Total 40.00",
    "Total 42.00",
  ].join("\n");
  assert.deepStrictEqual(D.findTotalInText(text), {
    amount: 42,
    currency: null,
    label: "Total 42.00",
  });
});

test("extractFromJsonLd reads an Order total", () => {
  const order = {
    "@context": "https://schema.org",
    "@type": "Order",
    seller: { "@type": "Organization", name: "Acme Store" },
    orderTotal: { "@type": "PriceSpecification", price: "2499.00", priceCurrency: "INR" },
  };
  const r = D.extractFromJsonLd(order);
  assert.deepStrictEqual(r, { amount: 2499, currency: "INR", merchant: "Acme Store" });
});

test("extractFromJsonLd reads Invoice totals and nested Orders", () => {
  const invoice = {
    "@type": "Invoice",
    provider: "Power Company",
    totalPaymentDue: { value: "799.50", priceCurrency: "INR" },
  };
  assert.deepStrictEqual(D.extractFromJsonLd(invoice), {
    amount: 799.5,
    currency: "INR",
    merchant: "Power Company",
  });

  const graph = {
    "@graph": [
      { "@type": "Product", name: "Ignored" },
      { "@type": "Order", merchant: { name: "Nested Store" }, price: "125" },
    ],
  };
  assert.deepStrictEqual(D.extractFromJsonLd(graph), {
    amount: 125,
    currency: null,
    merchant: "Nested Store",
  });
});

test("extractFromJsonLd rejects invalid nodes and incomplete transactions", () => {
  assert.strictEqual(D.extractFromJsonLd(null), null);
  assert.strictEqual(D.extractFromJsonLd("not an object"), null);
  assert.strictEqual(D.extractFromJsonLd([{ "@type": "Order", orderTotal: { price: "-" } }]), null);
  assert.strictEqual(D.extractFromJsonLd({ "@type": "Invoice", totalPaymentDue: { price: "-" } }), null);
  assert.strictEqual(
    D.extractFromJsonLd({ "@type": "Order", seller: {}, orderTotal: { value: "10", priceCurrency: "INR" } }).merchant,
    null,
  );
});

test("extractFromJsonLd walks @graph and ignores Product", () => {
  const graph = { "@graph": [{ "@type": "Product", name: "Shoes", offers: { price: "999" } }] };
  assert.strictEqual(D.extractFromJsonLd(graph), null);
});

test("merchantFromHost strips www and two-level suffixes", () => {
  assert.strictEqual(D.merchantFromHost("www.amazon.in"), "Amazon");
  assert.strictEqual(D.merchantFromHost("flipkart.com"), "Flipkart");
  assert.strictEqual(D.merchantFromHost("shop.myntra.com"), "Myntra");
  assert.strictEqual(D.merchantFromHost("foo.co.in"), "Foo");
  assert.strictEqual(D.merchantFromHost(""), "Web purchase");
});

test("guessCategory maps known merchants", () => {
  assert.strictEqual(D.guessCategory("Swiggy", "swiggy.com"), "food");
  assert.strictEqual(D.guessCategory("Uber", "uber.com"), "travel");
  assert.strictEqual(D.guessCategory("Airtel", "airtel.in"), "housing");
  assert.strictEqual(D.guessCategory("Amazon", "amazon.in"), "misc");
  assert.strictEqual(D.guessCategory("Someone", "example.org"), "other");
});

test("classifyPurchasePage detects confirmation pages", () => {
  assert.strictEqual(D.classifyPurchasePage("https://x.com/order-confirmation", ""), true);
  assert.strictEqual(D.classifyPurchasePage("https://x.com/cart", "Thank you for your order!"), true);
  assert.strictEqual(D.classifyPurchasePage("https://x.com/product/123", "Add to cart"), false);
});

test("buildCandidate: JSON-LD Order wins with high-quality fields", () => {
  const c = D.buildCandidate({
    jsonLd: [{ "@type": "Order", seller: { name: "BigBasket" }, orderTotal: { price: "850.50", priceCurrency: "INR" } }],
    url: "https://www.bigbasket.com/order/123",
    host: "www.bigbasket.com",
    text: "Order placed",
  });
  assert.deepStrictEqual(c, { amount: 850.5, currency: "INR", merchant: "BigBasket", category: "food", source: "order" });
});

test("buildCandidate: confirmation page + total when no JSON-LD", () => {
  const c = D.buildCandidate({
    jsonLd: [],
    url: "https://shop.example.com/thank-you",
    host: "shop.example.com",
    text: "Thank you for your order\nGrand Total ₹3,200.00",
  });
  assert.ok(c);
  assert.strictEqual(c.amount, 3200);
  assert.strictEqual(c.merchant, "Example");
  assert.strictEqual(c.source, "page");
});

test("buildCandidate: a plain product page is not a spend", () => {
  const c = D.buildCandidate({
    jsonLd: [{ "@type": "Product", name: "Shoes", offers: { price: "999", priceCurrency: "INR" } }],
    url: "https://shop.example.com/product/shoes",
    host: "shop.example.com",
    text: "Buy now ₹999",
  });
  assert.strictEqual(c, null);
});

test("buildCandidate accepts missing currency as INR and rejects incomplete totals", () => {
  const withoutCurrency = D.buildCandidate({
    jsonLd: [{ "@type": "Order", orderTotal: { price: "250" } }],
    url: "https://shop.example.com/order/123",
    host: "shop.example.com",
    text: "",
  });
  assert.strictEqual(withoutCurrency.currency, "INR");
  assert.strictEqual(withoutCurrency.amount, 250);

  assert.strictEqual(
    D.buildCandidate({
      jsonLd: [{ "@type": "Order", orderTotal: { price: "0", priceCurrency: "INR" } }],
      url: "https://shop.example.com/product",
      host: "shop.example.com",
      text: "No confirmation",
    }),
    null,
  );
  assert.strictEqual(
    D.buildCandidate({
      url: "https://shop.example.com/thank-you",
      host: "shop.example.com",
      text: "Thank you for your order, but no total is shown",
    }),
    null,
  );
});

test("buildCandidate rejects non-INR purchases instead of recording them as rupees", () => {
  const structured = D.buildCandidate({
    jsonLd: [{ "@type": "Order", orderTotal: { price: "45.99", priceCurrency: "USD" } }],
    url: "https://shop.example.com/order/123",
    host: "shop.example.com",
    text: "Order placed",
  });
  assert.strictEqual(structured, null);

  const visible = D.buildCandidate({
    jsonLd: [],
    url: "https://shop.example.com/thank-you",
    host: "shop.example.com",
    text: "Grand Total $45.99",
  });
  assert.strictEqual(visible, null);

  for (const total of [
    "Grand Total €45.99",
    "Grand Total GBP 45.99",
    "Grand Total AED 45.99",
  ]) {
    assert.strictEqual(
      D.buildCandidate({
        jsonLd: [],
        url: "https://shop.example.com/thank-you",
        host: "shop.example.com",
        text: total,
      }),
      null,
      total,
    );
  }
});
