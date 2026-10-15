# MoneyMinder browser extension

A small Chrome (Manifest V3) companion for the MoneyMinder budgeting app. Click
the toolbar icon to:

- See today's spending pace vs your daily budget, with an on-track / over pill
  and the four category totals (food, travel, housing, misc).
- Glance at each household balance (owed / owe / settled).
- Log a quick expense to any household straight from the popup.
- **Auto-detect purchases** on the pages you visit: when a page looks like a
  completed order/receipt, the toolbar badge lights up (₹) and the popup offers a
  one-tap **Track this** into your budget, with the amount, merchant, and a
  guessed category prefilled.
- Jump to the full web app or log out.

## Requirements

The MoneyMinder server must be running locally. From the repo root:

```
npm start
```

This serves the API and web app at `http://localhost:3000`.

## Load the extension (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select this `extension/` folder.

The MoneyMinder icon appears in your toolbar. Click it, log in with your
MoneyMinder credentials, and the dashboard loads. Production enrollment is an
invite-only controlled pilot; obtain an account from the operator before using
the Store build.

## Auto-detecting purchases

Purchase detection is off by default. When you explicitly enable it, Chrome
asks for access to HTTPS pages and registers [detect.js](detect.js) +
[content.js](content.js) on the HTTPS pages you visit. Detection stays local and uses
two signals only:

1. **Structured data** — a schema.org `Order` or `Invoice` in the page's
   `application/ld+json`, with its total and seller.
2. **Confirmation pages** — a URL or text that says "order confirmation / thank
   you / receipt / payment successful", combined with a clearly labelled total
   ("Order total", "Amount paid", "Grand total", …).

A plain product or cart page is deliberately **not** treated as a spend, so it
doesn't log everything you browse. When a purchase is detected, the service
worker ([background.js](background.js)) lights the toolbar badge for that tab and
stashes the candidate in `chrome.storage.session` (in memory, per tab, gone when
the browser closes). Open the popup and tap **Track this** to save it to your
budget as a receipt (`category` / `amount` / `merchant`) — or **Dismiss** it.

Nothing is saved automatically: detection just *offers*; you confirm. The
detection core is pure and unit-tested — run `node --test extension/detect.test.js`.

**Turn it off** any time with the "Auto-detect purchases" switch at the bottom of
the popup. Disabling unregisters the content scripts and removes their page
permission.

### Privacy

Only after you opt in, the content script reads the current page and **sends nothing
off your device** — the only recipient is this extension's own service worker
(an amount, a merchant name, a guessed category). The page's content is never
uploaded. The detected amount leaves your browser only when *you* tap **Track**,
and then only to your own MoneyMinder server. Installation does not grant access
to pages you visit; Chrome asks only when you enable detection.

## API origin

The unpacked development source defaults to `http://localhost:3000`. A Chrome
Web Store ZIP instead contains one packaged production API origin, set at build
time by `MONEYMINDER_SERVER_URL`; users cannot change it at runtime. The
required host permission is limited to that exact origin. Optional
`https://*/*` access is detection-only and never selects or authorizes another
API server.

## Security notes

- **Bearer token, not cookies.** The web app's session cookie is
  `httpOnly` / `sameSite=lax`, so it never flows to a `chrome-extension://`
  origin. The extension authenticates with a bearer token issued by the server
  on login/register (only when the `X-Client: extension` header is present).
  Server-side scope permits only summary/household reads and receipt/expense
  creation.
- **Token storage.** The token lives in `chrome.storage.local`, restricted to
  trusted extension pages so all-site content scripts cannot read it. Logging
  out revokes it server-side before clearing it locally. If the server cannot
  be reached, the extension stays signed in so revocation can be retried. A 401
  also clears it.
- **Cookieless CORS.** The server only opens CORS to `chrome-extension://`
  origins and never sends `Access-Control-Allow-Credentials`, so there is no
  CSRF surface.
- **Minimal permissions.** `storage`, `scripting`, and one `host_permissions`
  entry for the packaged API origin — no `tabs`, `cookies`, `history`, or
  `webNavigation`. Page access is optional and requested only when the user
  enables local purchase detection.
- **No inline code.** All JS is in `popup.js`; every handler is attached with
  `addEventListener`, satisfying the MV3 content-security policy. No external
  CDNs or network calls beyond the packaged API base.
