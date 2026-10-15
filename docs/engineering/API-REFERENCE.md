# MoneyMinder API reference

This is the HTTP contract implemented by [server/app.js](../../server/app.js),
[server/auth.js](../../server/auth.js), [server/api.js](../../server/api.js), and
[server/households.js](../../server/households.js), with the optional sponsored
offer contract in [server/promotions.js](../../server/promotions.js).

## Protocol conventions

- All API paths are relative to the deployed MoneyMinder origin.
- JSON requests use `Content-Type: application/json`; the JSON body limit is
  64 KiB.
- Receipt OCR alone uses `multipart/form-data`.
- Successful responses are JSON except receipt-image responses and empty CORS
  preflights.
- Most create operations return HTTP 200, not 201.
- Errors use `{"error":"human-readable message"}`.
- API responses set `Cache-Control: no-store`.
- Lists are unpaginated but bounded by entity quotas.
- Money values are JSON numbers in rupees with at most two decimal places at
  input. Individual values cannot exceed ₹1 crore.
- Domain dates are `YYYY-MM-DD`; timestamps are ISO 8601 strings.
- Unknown JSON properties are generally ignored. Clients should send only the
  documented fields.

Every response carries `X-Request-ID`. A client may supply one matching
`[A-Za-z0-9._:-]{1,80}`; otherwise the server generates a UUID.

## Authentication

### Browser session

Register/login without `X-Client: extension` sets an HttpOnly session cookie.
Browser fetches use same-origin credentials. Protected account operations,
OCR, receipt reads/deletes/images, household detail, settlement, and recurring
management require this session.

### Extension bearer

Register/login with:

```http
X-Client: extension
```

returns `token`. Send it as:

```http
Authorization: Bearer <token>
X-Client: extension
```

The raw token is exactly 64 lowercase hexadecimal characters. Malformed bearer
headers are rejected without a datastore lookup. Every well-shaped bearer
attempt is limited to 60/minute/IP. Digests absent from the startup/runtime
known-token admission cache additionally consume the 180/minute/process
unknown-token budget before datastore lookup; a cached digest skips only that
second limiter and still requires full datastore-backed authentication.

Bearer access is limited to:

| Method | Path |
| --- | --- |
| `GET` | `/api/summary` |
| `GET` | `/api/households` |
| `POST` | `/api/receipts` |
| `POST` | `/api/households/<UUIDv4>/expenses` |

Authentication can succeed and still return 403 when bearer scope excludes the
route. Tokens expire after thirty days and logout revokes the presented token.

### Mutation origin

In production, a mutating API request must either:

- carry an `Origin` equal to `APP_ORIGIN`;
- carry the configured `EXTENSION_ORIGIN`; or
- have no `Origin` and carry an exactly shaped bearer authorization header.

Other mutation origins return 403 before authentication.

## Idempotency

These create endpoints accept:

```http
Idempotency-Key: <16-80 characters from A-Z a-z 0-9 . _ : ->
```

- `POST /api/receipts`
- `POST /api/households`
- `POST /api/households/:id/expenses`
- `POST /api/households/:id/settle`
- `POST /api/households/:id/recurring`

The header is optional. Repeating an equivalent request with the same
actor-scoped key returns the original object or ID. Reusing a key for different
input returns 409. Invalid syntax returns 400. The key is never returned.

`POST /api/promotions/:id/events` also uses this header, but requires a fresh
event-scoped value. Its SHA-256 hash is stored only for deduplication; the raw
key is not stored.

## Common errors

| Status | Meaning |
| ---: | --- |
| 400 | Invalid JSON, multipart structure, field, date, money, target, or idempotency key |
| 401 | Missing/expired authentication or authentication changed during the write |
| 403 | Registration closed, mutation origin blocked, browser session required, current-password check failed, or bearer scope denied |
| 404 | Resource absent or intentionally hidden because the user is not a member/owner |
| 409 | Idempotency conflict, duplicate pending settlement, or expired staged image |
| 413 | JSON/upload too large or an entity count ceiling reached |
| 429 | Fixed-window rate limit exceeded |
| 500 | Unexpected server failure; details are not returned |
| 503 | Database/OCR busy, startup state unavailable, join-code allocation failure, or readiness failure |
| 507 | Application-state or receipt-image storage ceiling reached |

## Health and static routes

### `GET /livez`

No authentication. Reports only that the process can serve HTTP.

```json
{ "ok": true }
```

### `GET /readyz`

### `GET /healthz`

No authentication. These aliases check the durable data directory and SQLite
`app_state` row. The result is cached for two seconds.

- 200: `{"ok":true}`
- 503: `{"ok":false}`

### Static application

Express serves [public/](../../public) at the origin root after API routes.
When production registration is closed, `GET /register.html` returns 404.

## Authentication endpoints

### `POST /api/register`

Open endpoint, but production registration defaults closed.

Body:

```json
{
  "username": "aarav",
  "email": "aarav@example.org",
  "mobile": "+919876543210",
  "budget": 25000,
  "password": "at least fifteen chars",
  "vpa": "aarav@bank"
}
```

Rules:

- all fields except `vpa` are required; `budget: 0` is valid;
- username is 1–32 ASCII letters, digits, dot, underscore, or hyphen and is
  unique case-insensitively;
- `.`, `..`, `__proto__`, `prototype`, and `constructor` are reserved;
- password is at least 15 Unicode code points and at most 72 UTF-8 bytes;
- email must have non-space text around `@` and a dot in its domain;
- mobile is 8–20 characters, starts with an optional `+` then a digit, and may
  contain digits, spaces, or hyphens;
- optional VPA has 2–64 word/dot/hyphen characters on each side of `@`.

Browser response:

```json
{
  "ok": true,
  "user": {
    "username": "aarav",
    "email": "aarav@example.org",
    "mobile": "+919876543210",
    "budget": 25000,
    "vpa": "aarav@bank",
    "displayName": ""
  }
}
```

Extension response adds a 64-character lowercase hexadecimal
`"token":"<raw bearer token>"` and does not create a browser login session.

Endpoint-specific errors:

- 400 missing/invalid/overlong fields;
- 403 registration closed;
- 409 username taken or its previous upload-directory deletion is pending;
- 429 auth IP/account limit.

### `POST /api/login`

Open endpoint.

Body:

```json
{ "username": "aarav", "password": "at least fifteen chars" }
```

The successful browser/extension shapes match registration. Failure returns
401 with `Invalid username or password`; it does not reveal whether the account
exists. Rate-limit failure is 429.

### `POST /api/logout`

Session or bearer may be supplied; the route also succeeds when already logged
out.

```json
{ "ok": true }
```

For bearer auth, the presented token digest is removed. For a browser, the
session is destroyed.

## Account endpoints

All account endpoints require authentication. The mutating/export/delete
operations explicitly require a browser session.

### `GET /api/me`

Browser session only in practice because it is outside bearer scope.

```json
{
  "user": {
    "username": "aarav",
    "email": "aarav@example.org",
    "mobile": "+919876543210",
    "budget": 25000,
    "vpa": "aarav@bank",
    "displayName": "Aarav"
  }
}
```

### `PATCH /api/me`

Browser session required. Any subset of these fields may be supplied:

```json
{
  "budget": 30000,
  "displayName": "Aarav",
  "vpa": "aarav@bank",
  "currentPassword": "required only when changing the VPA"
}
```

Rules:

- budget uses normal money syntax and may be zero;
- display name is at most 64 characters;
- VPA may be cleared with `""`;
- changing VPA requires the current password; resubmitting the same VPA does
  not.

Response:

```json
{
  "ok": true,
  "user": {
    "username": "aarav",
    "email": "aarav@example.org",
    "mobile": "+919876543210",
    "budget": 30000,
    "vpa": "aarav@bank",
    "displayName": "Aarav"
  }
}
```

Errors include 400 invalid profile values, 403 browser session/password
required, and 401 if authentication changed before commit.

### `POST /api/me/export`

Browser session and current-password reauthentication required.

```json
{ "currentPassword": "the current password" }
```

Response:

```json
{
  "exportedAt": "2026-07-26T12:00:00.000Z",
  "user": {
    "username": "aarav",
    "email": "aarav@example.org",
    "mobile": "+919876543210",
    "budget": 30000,
    "vpa": "aarav@bank",
    "displayName": "Aarav"
  },
  "receipts": [],
  "households": [],
  "expenses": [],
  "settlements": []
}
```

The export includes:

- the user's personal receipts;
- each household where the user is a member;
- expenses from those households;
- settlements where the user is payer or recipient.

Internal idempotency keys are recursively removed. Incorrect password returns
403.

### `DELETE /api/me`

Browser session and current-password reauthentication required.

```json
{ "currentPassword": "the current password" }
```

Success:

```json
{ "ok": true }
```

The account, tokens, personal receipts, and upload directory are removed or
queued for removal. Shared ledger records are retained under a non-login
deleted-member identifier, affected invite codes rotate, and the current
session is destroyed. Incorrect password returns 403.

## Budget and insights

### `GET /api/summary`

Session or scoped bearer.

```json
{
  "budget": 25000,
  "dailyBudget": 806.4516129032259,
  "spent": 4800,
  "personalSpent": 3500,
  "sharedShare": 1300,
  "categories": {
    "food": 1800,
    "travel": 400,
    "housing": 2400,
    "misc": 200,
    "other": 0
  },
  "onTrack": true
}
```

Values cover the current `APP_TIME_ZONE` calendar month. `spent` is personal
receipts plus the authenticated user's exact share of household expenses.
`dailyBudget` is monthly budget divided by the month's number of days.

### `GET /api/insights`

Browser session required.

```json
{
  "categories": {
    "food": 1800,
    "travel": 400,
    "housing": 2400,
    "misc": 200,
    "other": 0
  },
  "daily": [
    { "date": "2026-07-13", "amount": 0 },
    { "date": "2026-07-14", "amount": 225.5 }
  ]
}
```

`daily` always has fourteen dates ending today and combines personal spend with
the user's household shares.

## Sponsored merchant-offer endpoints

These browser-session routes exist in source but are disabled unless
`PROMOTIONS_ENABLED=true`. They use the same SQLite database as application
state and sessions. They are outside the Chrome bearer allowlist, so a valid
extension token receives 403.

There is no HTTP endpoint to create, edit, activate, or report a campaign. No
user-supplied campaign write is accepted. An operator must verify the merchant's
identity and control of the destination, manually review the exact public HTTPS
URL and content, and use a controlled database-change process before activation.

### `GET /api/promotions/current`

Browser session required. Limited to 120 requests/minute/client IP; the coarse
600 requests/minute/client IP API ceiling also applies.

Disabled or no eligible campaign:

```json
{ "promotion": null }
```

Enabled response:

```json
{
  "promotion": {
    "id": "3d8c2e12-f3d7-4ea2-9bed-87e6b7b52f08",
    "title": "Save on groceries",
    "description": "A useful discount for MoneyMinder users.",
    "ctaLabel": "View offer",
    "url": "https://offers.example.com/moneyminder-student"
  }
}
```

The repository selects one `active` campaign whose schedule contains the
current UTC time, ordered by latest start then ID. It accepts no
targeting input. Only canonical campaign UUID, non-empty bounded plain text
(80-character title, 240-character description, 40-character CTA), and a
bounded credential-free, default-port HTTPS destination on a public DNS-style
hostname are returned. Runtime validation rejects IP literals,
localhost/private-style names, and special-use suffixes. An absent or invalid
row returns `promotion: null`.

### `POST /api/promotions/:id/events`

Browser session required. Limited to 30 requests/minute/client IP and
10/minute/authenticated user; the coarse 600/minute/client IP API ceiling also
applies. The path ID must be a canonical UUID and `Idempotency-Key` is
mandatory.

The body must contain exactly one property:

```json
{ "eventType": "impression" }
```

`eventType` is `impression` or `click`. Success, including an equivalent retry,
returns 204 with no body. Errors include:

- 400 invalid UUID, body shape/type, or missing/invalid idempotency key;
- 404 disabled, absent, inactive, or out-of-schedule campaign;
- 409 the same idempotency key was already used for another campaign event;
- 429 route limit; and
- 503 an operational SQLite failure.

The server hashes the event key with SHA-256 and sends only campaign ID, event
type, UTC metric date, and key hash to the promotion repository. It does not
send or persist the authenticated user or request IP. One transaction
deduplicates the event and increments the campaign's UTC daily impression/click
counter. Click reconciliation ensures counts never report more clicks than
impressions.

Client telemetry is deliberately approximate and must not be used for billing:
the dashboard attempts one impression after at least 50% visibility and a click
only for a trusted link click, but both requests are best-effort and fail
without interrupting navigation or core functionality. Redemption/conversion
must be confirmed by the merchant through a separate approved process.

Dedup rows become eligible for pruning after 48 hours only when a later event
triggers cleanup; the last rows of an idle campaign can persist longer. Daily
aggregate metrics have no implemented expiry. Promotions must remain disabled
until a finite lifecycle is implemented/tested or explicitly approved and
disclosed. This endpoint contract is not a guaranteed 48-hour retention policy.

## Receipt OCR and receipts

### `POST /api/parse-receipt`

Browser session required. Rate limited to one request/minute/account and two
requests/minute/process.

Multipart body:

```text
field name: input
value: one JPEG or PNG file
```

Limits:

- one file, no text fields, at most 5 MiB;
- valid JPEG/PNG signature and dimensions;
- width and height at most 8,192;
- at most 16 million pixels.

Recognized response:

```json
{
  "configured": true,
  "image": "7f6f32c5-3db6-4dc0-9c15-92fcb16e3be3.jpg",
  "category": "food",
  "date": "2026-07-26",
  "amount": 428.5,
  "supplier": "Example Market",
  "document": "upi",
  "lineItems": [
    { "description": "Rice", "amount": 120 },
    { "description": "Unitemized remainder", "amount": 308.5 }
  ]
}
```

When recognition yields no useful field:

```json
{
  "configured": false,
  "image": "<saved filename when recognition ran>",
  "category": "",
  "date": "",
  "amount": "",
  "supplier": "",
  "document": "",
  "lineItems": []
}
```

An early OCR initialization/recognition failure returns the same fallback with
an empty image. OCR busy returns 503 and `Retry-After: 30`. Invalid uploads
return 400/413; image storage exhaustion returns 507.

This endpoint saves a staged image but not a receipt record. The client must
review the result and call `POST /api/receipts`.

### `GET /api/receipts`

Browser session required. Returns the authenticated user's receipts, newest
first:

```json
{
  "receipts": [
    {
      "id": "54de78f5-23c0-43a2-a4b2-a6fdd3da38e4",
      "userKey": "aarav",
      "category": "food",
      "date": "2026-07-26",
      "amount": 428.5,
      "supplier": "Example Market",
      "document": "UPI",
      "image": "7f6f32c5-3db6-4dc0-9c15-92fcb16e3be3.jpg",
      "createdAt": "2026-07-26T12:00:00.000Z"
    }
  ]
}
```

Stored `userKey` is currently part of the receipt view; `operationKey` is not.

### `POST /api/receipts`

Session or scoped bearer. Optional idempotency key.

```json
{
  "category": "food",
  "date": "2026-07-26",
  "amount": 428.5,
  "supplier": "Example Market",
  "document": "UPI",
  "image": "7f6f32c5-3db6-4dc0-9c15-92fcb16e3be3.jpg"
}
```

Rules:

- amount is required and greater than zero;
- category defaults to `miscellaneous`, maximum 32 characters;
- date may be empty, otherwise it must be a real `YYYY-MM-DD`, maximum 10;
- supplier and document may be empty, maximum 120 characters each;
- image may be empty, maximum 100 characters, and is reduced to its basename;
- a supplied image must resolve inside the authenticated user's directory and
  still be readable;
- at most 1,000 receipts per account.

Response:

```json
{
  "ok": true,
  "receipt": {
    "id": "54de78f5-23c0-43a2-a4b2-a6fdd3da38e4",
    "userKey": "aarav",
    "category": "food",
    "date": "2026-07-26",
    "amount": 428.5,
    "supplier": "Example Market",
    "document": "UPI",
    "image": "7f6f32c5-3db6-4dc0-9c15-92fcb16e3be3.jpg",
    "createdAt": "2026-07-26T12:00:00.000Z"
  }
}
```

Errors include 400 invalid input, 409 conflicting key or missing staged image,
413 receipt ceiling, 401 stale authentication, and 507 state ceiling.

### `GET /api/receipts/:id`

Browser session required. Returns:

```json
{
  "receipt": {
    "id": "54de78f5-23c0-43a2-a4b2-a6fdd3da38e4",
    "userKey": "aarav",
    "category": "food",
    "date": "2026-07-26",
    "amount": 428.5,
    "supplier": "Example Market",
    "document": "UPI",
    "image": "7f6f32c5-3db6-4dc0-9c15-92fcb16e3be3.jpg",
    "createdAt": "2026-07-26T12:00:00.000Z"
  }
}
```

Absent or another user's receipt returns 404.

### `DELETE /api/receipts/:id`

Browser session required.

```json
{ "ok": true }
```

Deleting the last receipt that references its image queues physical deletion.
Other-user/absent IDs return 404; stale authentication returns 401.

### `GET /api/image/:name`

Browser session required. Sends the file from the authenticated user's upload
directory with `Cache-Control: private, no-store`. Invalid names, absent files,
and other-user paths return 404. The response is image bytes, not JSON.

## Household endpoints

### `GET /api/households`

Session or scoped bearer.

Browser-session response:

```json
{
  "households": [
    {
      "id": "e45244d6-842f-42f2-9768-bc69f6b3f412",
      "name": "Flat 4B",
      "balance": -640.25,
      "code": "K7M2QZ",
      "members": 3
    }
  ]
}
```

Bearer response deliberately omits join code and member count:

```json
{
  "households": [
    {
      "id": "e45244d6-842f-42f2-9768-bc69f6b3f412",
      "name": "Flat 4B",
      "balance": -640.25
    }
  ]
}
```

Positive balance means the household owes the user; negative means the user
owes the household.

### `POST /api/households`

Browser session required. Optional idempotency key.

```json
{ "name": "Flat 4B" }
```

Name is required, trimmed, and at most 100 characters. Success:

```json
{
  "ok": true,
  "household": {
    "id": "e45244d6-842f-42f2-9768-bc69f6b3f412",
    "name": "Flat 4B",
    "code": "K7M2QZ",
    "ownerKey": "aarav",
    "members": ["aarav"],
    "createdAt": "2026-07-26T12:00:00.000Z"
  }
}
```

Errors include 413 after 20 memberships, 503 if a unique join code cannot be
allocated in ten attempts, and normal 400/409/401 errors.

### `POST /api/households/join`

Browser session required.

```json
{ "code": "K7M2QZ" }
```

Code is trimmed, uppercased, and must be six characters from
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.

```json
{ "ok": true, "id": "e45244d6-842f-42f2-9768-bc69f6b3f412" }
```

Joining an existing membership is successful. Errors: 400 invalid code, 404
unknown code, 413 account's 20-household ceiling or household's 50-active-member
ceiling, 401 stale authentication, and 429 join limit.

### `GET /api/households/:id`

Browser session and membership required.

```json
{
  "id": "e45244d6-842f-42f2-9768-bc69f6b3f412",
  "name": "Flat 4B",
  "code": "K7M2QZ",
  "me": "aarav",
  "members": [
    { "key": "aarav", "name": "aarav", "vpa": "aarav@bank" }
  ],
  "expenses": [
    {
      "id": "f65d7d3c-9133-48cc-9349-9ecfecc4f90b",
      "householdId": "e45244d6-842f-42f2-9768-bc69f6b3f412",
      "paidBy": "aarav",
      "paidByName": "aarav",
      "description": "Electricity",
      "amount": 1800,
      "category": "housing",
      "splitAmong": ["aarav"],
      "splitNames": ["aarav"],
      "date": "2026-07-26",
      "createdAt": "2026-07-26T12:00:00.000Z"
    }
  ],
  "balances": [
    { "key": "aarav", "name": "aarav", "net": 0 }
  ],
  "owes": [],
  "pendingSettlements": []
}
```

Expenses are newest first. `balances` may include a `Deleted member` row with
an empty key to preserve historic totals. `owes` includes active-member payment
suggestions only. `pendingSettlements` includes only pending records where the
authenticated user is payer or recipient. Non-members receive 404.

### `POST /api/households/:id/expenses`

Session or scoped bearer, but bearer scope requires a lowercase UUIDv4
household ID in the path. Membership required. Optional idempotency key.

```json
{
  "description": "Electricity",
  "amount": 1800,
  "date": "2026-07-26",
  "category": "housing",
  "splitAmong": ["aarav", "diya"]
}
```

Rules:

- amount is required and greater than zero;
- description defaults to `Expense`, is trimmed, non-empty, and at most 256;
- omitted date defaults to the current configured-zone date;
- category outside `food|travel|housing|misc|other` becomes `other`;
- split members are deduplicated and filtered to active members;
- missing/empty/fully invalid split falls back to all active members.

```json
{ "ok": true, "id": "f65d7d3c-9133-48cc-9349-9ecfecc4f90b" }
```

Errors include 404 non-membership, 413 at 1,000 expenses by the payer or 1,000
for the household, and normal 400/409/401/507 errors.

### `POST /api/households/:id/settle`

Browser session and membership required. Optional idempotency key.

```json
{ "to": "diya", "amount": 640.25, "method": "upi" }
```

Rules:

- `to` must be another active household member;
- method is `cash` by default and must be `cash` or `upi`;
- amount must be greater than zero and no more than the current simplified debt
  from the authenticated user to `to`;
- only one pending settlement from this user to the same recipient in this
  household is allowed.

```json
{ "ok": true, "id": "13708fc9-9469-48f8-81a0-340234f7da5a" }
```

The response records a pending ledger proposal; it does not confirm external
payment. Errors include 400 unknown target/invalid debt/method, 404
non-membership, 409 duplicate pending request or idempotency conflict, 413 at
1,000 settlements by the user or household, and 401 stale auth.

### `POST /api/households/:id/settlements/:sid/confirm`

Browser session required. Only the settlement recipient may confirm it.
The JSON body may be empty:

```json
{}
```

```json
{ "ok": true }
```

Confirming an already confirmed settlement is idempotently successful. Missing,
unrelated, non-pending, non-member, or wrong-recipient records return 404.

## Recurring endpoints

### `GET /api/households/:id/recurring`

Browser session and membership required.

```json
{
  "recurring": [
    {
      "id": "2f5f773a-252d-4522-85f6-74376c52cc1c",
      "description": "Rent",
      "amount": 18000,
      "category": "housing",
      "splitAmong": null,
      "dayOfMonth": 1,
      "lastPostedYM": "2026-07",
      "createdBy": "aarav"
    }
  ]
}
```

Internal operation keys are omitted.

### `POST /api/households/:id/recurring`

Browser session and membership required. Optional idempotency key.

```json
{
  "description": "Rent",
  "amount": 18000,
  "category": "housing",
  "dayOfMonth": 1,
  "splitAmong": ["aarav", "diya"]
}
```

Rules:

- amount is greater than zero;
- day is an integer from 1 through 28;
- description defaults to `Bill`, is non-empty, and at most 256;
- category is canonicalized like expenses;
- supplied split members are deduplicated and filtered to active members;
- omitted or fully invalid split is stored as `null`, meaning all active
  members when the bill posts.

```json
{
  "ok": true,
  "recurring": {
    "id": "2f5f773a-252d-4522-85f6-74376c52cc1c",
    "description": "Rent",
    "amount": 18000,
    "category": "housing",
    "splitAmong": ["aarav", "diya"],
    "dayOfMonth": 1,
    "lastPostedYM": null,
    "createdBy": "aarav"
  }
}
```

Errors include 404 non-membership, 413 at 200 definitions created by the user or
100 in the household, and normal 400/409/401/507 errors.

### `DELETE /api/households/:id/recurring/:rid`

Browser session and membership required.

```json
{ "ok": true }
```

Any household member may remove a recurring definition. Missing definition or
non-membership returns 404; stale auth returns 401.

## Operational behavior not represented as endpoints

- Recurring bills post on process boot and every six hours after their local
  day arrives. The posted record is a normal household expense.
- Receipt/upload and application-state quotas are enforced during writes.
- There is no API for password reset, leaving a household, deleting an expense,
  canceling a pending settlement, administration, payment-provider callbacks,
  or pagination.
- There is no public API version prefix. A breaking contract change requires
  coordinated updates to the web pages, extension, Android-hosted web
  deployment, tests, and this reference.
