# MoneyMinder v2 — Build Plan ("better than Splitwise")

This is the single source of truth for the v2 build. Build agents read this file and
implement the section named in their task. Keep changes minimal and consistent with the
existing stack (ponytail: stdlib/native first, no new deps unless a few lines won't do it).

## Vision
A unified personal + shared money app for roommates in India. Two moats Splitwise can't copy:
1. **One money picture** — your share of shared expenses flows into your personal category
   budget, so the dashboard shows your *true cost of living*.
2. **It moves money** — UPI deep-link settle-up turns a balance into an actual payment.
Plus: give away what Splitwise paywalls (no ads, no add caps, free OCR, free charts).
Phone-first, fast, installable (PWA), delightful UX.

## Existing stack (do not rewrite)
Express + JSON store (`server/db.js`) + vanilla JS frontend (`public/`, `window.API` in
`js/api.js`, shared nav in `js/nav.js`, design system in `css/app.css`) + Chrome extension
(`extension/`). Auth: bcrypt + express-session cookie + bearer token for the extension;
`requireAuth` guards all `/api/*` except register/login/logout. Money is ₹ (INR).
Data lives in `data/db.json` (gitignored). Tests via `node --test`.

---

## P1 — Backend: data model + endpoints

### db.js
- `EMPTY` already has users/receipts/households/expenses/settlements/tokens. No new top-level
  collections needed (recurring lives inside each household).

### Data shape additions (validate on write)
- `users[key]`: add optional `vpa` (UPI id like `name@bank`, regex `^[\w.\-]{2,64}@[\w.\-]{2,64}$`)
  and optional `displayName` (<=64 chars). Never returned for *other* users except `vpa`+username
  inside a shared household.
- `expenses[id]`: add `category` — one of `food|travel|housing|misc|other` (default `other`).
- `households[id]`: add `recurring: []` of
  `{ id, description, amount, category, splitAmong:[key]|null, dayOfMonth(1-28), lastPostedYM }`.
- `settlements[id]`: add optional `method` (`upi|cash`, default `cash`).

### Endpoints
Profile (auth.js or a small profile route):
- `PATCH /api/me` body `{vpa?, budget?, displayName?}` — update own profile fields that are
  present; validate vpa regex, budget is a finite number >= 0, displayName length. Return updated public user (now includes `vpa`, `displayName`).
- `register`: accept optional `vpa` and store it.
- Public user shape becomes `{username, email, mobile, budget, vpa, displayName}`.

Budget / insights (api.js):
- `GET /api/summary` → **cost of living**. Compute personal category totals from the user's
  receipts AND add the user's share of every shared expense they're split into, bucketed by
  `expense.category`. Return:
  `{ budget, dailyBudget, spent, personalSpent, sharedShare, categories:{food,travel,housing,misc,other}, onTrack }`
  where `spent = personalSpent + sharedShare`, `onTrack = spent <= dailyBudget * dayOfMonth`.
- `GET /api/insights` → for charts:
  `{ categories:{...same buckets...}, daily:[{date:"YYYY-MM-DD", amount}] }` for the last 14 days
  (personal receipts + the user's share of shared expenses, by date). Derive, don't store.

Households (households.js):
- `POST /api/households/:id/expenses` → also accept `category` (default `other`).
- `POST /api/households/:id/settle` → also accept `method`.
- `GET /api/households/:id` detail → for each member include `{key, name, vpa}`; for each expense
  include `category`.
- Recurring bills:
  - `GET /api/households/:id/recurring` → `{recurring:[...]}` (members only)
  - `POST /api/households/:id/recurring` body `{description, amount, category, dayOfMonth, splitAmong?}` → add (members only)
  - `DELETE /api/households/:id/recurring/:rid` → remove (members only)
  - **Engine** (`server/recurring.js`, called from app.js): on boot and every 6h via `setInterval`,
    scan all households' `recurring[]`; for each item where `dayOfMonth <= today.getDate()` and
    `lastPostedYM !== current YYYY-MM`, insert an expense (paidBy = the household owner, split =
    item.splitAmong or all members, category = item.category) and set `lastPostedYM`. ponytail:
    plain loop + setInterval, no cron dependency. Idempotent via lastPostedYM.

Line items (ocr.js):
- Receipt OCR runs locally and free via tesseract.js (no API key, nothing leaves the server). One
  reusable Tesseract worker, created lazily; recognitions are serialized through a promise-queue
  (a worker can't recognize concurrently). The first scan downloads the ~15MB English model into
  `data/ocr-cache` (gitignored) and reuses it afterward. The raw text is run through pure, exported
  parser helpers (`parseAmount`/`parseDate`/`parseSupplier`/`parseCategory`/`parseLineItems`/`parse`).
- `parse-receipt` → return `lineItems: [{description, amount}]` parsed from lines that look like
  "<description> .... <amount>" (skip total/subtotal/tax lines, cap ~30); empty array if none.
  Don't fail if absent. On OCR failure or an unreadable receipt, return `configured:false` so the
  UI falls back to manual entry.

### Tests
Extend `server/*.test.js`: cost-of-living summary merges personal + shared share; recurring engine
posts once per month (idempotent); a settle with method records correctly. Keep using `node:test`.

---

## P2 — Frontend features (public/)
- **Dashboard (index)**: show *cost of living* (personal + shared share), a personal-vs-shared
  breakdown, the 4 (+other) category cards, budget status. Add **charts**: a category donut and a
  14-day trend line, **hand-rolled inline SVG** from `/api/insights` (ponytail: no chart lib).
- **Household detail**:
  - Each `owes` row → **Pay ₹X** button → open `upi://pay?pa=<payeeVpa>&pn=<name>&am=<amt>&cu=INR&tn=MoneyMinder%20settle`.
    On return, a **Mark as paid** action → `POST settle {to, amount, method:"upi"}`. If payee has no
    `vpa`, show "Ask <name> to add their UPI ID in Profile."
  - **Share on WhatsApp** button → `https://wa.me/?text=<urlencoded balances + owes summary>`.
  - Add-expense: **category** select + **can-I-afford** inline check — if (my category spent + my
    share) > category budget portion, show an amber non-blocking warning.
  - **Recurring bills** subsection: list + add (description/amount/category/day) + remove.
- **Scan (line-item split)**: after parse, if `lineItems` present, render them with per-line controls
  — mark each line *mine* / *shared* / assign to a member; "mine" lines post to personal receipt,
  "shared" lines create a household split. Fall back to the current single-total flow if no line items.
- **Profile**: edit `budget`, `vpa` (UPI ID), `displayName` via `PATCH /api/me`.
- Use `window.API` for everything; keep escaping (XSS) and `requireUser()` discipline.

## P3 — UX polish + PWA
- Toasts (success/error), loading skeletons, friendly empty states, smooth card/transition motion,
  first-login onboarding hint, optimistic UI where safe, strong focus states, and a polished
  **light-only** interface for consistent partner demos.
- **PWA**: `public/manifest.webmanifest` + `public/sw.js` service worker (cache the app shell + CSS/JS
  for offline launch; network-first for `/api`). Register SW from pages. Add icons + theme color.
  This makes the app installable and makes the Android wrapper trivial.
- Design polish pass via an ecc design/a11y agent (taste + accessibility), staying in the indigo system.

## P4 — Security + code review
ecc:security-reviewer (authZ on new routes — recurring/profile/insights must check ownership/membership;
validate vpa/category/dayOfMonth; UPI link injection safe) + a JS code review. Fix findings. `npm audit`.

## P5 — Verify
Boot, run unit tests, drive in a phone viewport, screenshot the dashboard, charts, UPI settlement
confirmation, line-item split, recurring, and public demo. Show the user.

## P6 — Android wrapper
Since P3 makes it a real PWA, wrap it as a **Trusted Web Activity** (Bubblewrap) OR a minimal
Android **WebView** Studio project under `android/`. Deliverable: the project + `digital asset links`
notes + build instructions. NOTE: compiling the APK needs Android SDK + JDK + Gradle, which may not be
installed in this environment — we scaffold and document; the `./gradlew assembleRelease` (or
`bubblewrap build`) step is run by the user. Pick WebView project if it must build offline against the
local server; pick TWA if the PWA will be hosted.

## ponytail guardrails (DO NOT build)
- No chart library — hand-roll SVG. No multi-currency. No real payment processing (UPI deep-link only).
- No push/email infra — WhatsApp share + extension badge cover notifications.
- No frontend framework, no state library. Keep the JSON store (note the SQLite upgrade path in code).
- Android = a wrapper only (TWA/WebView), not a native rewrite.
