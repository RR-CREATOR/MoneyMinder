# MoneyMinder product guide

MoneyMinder is an INR-first, phone-first budgeting application for people who
need one answer that ordinary receipt trackers and bill splitters keep separate:
**what did living actually cost me this month?**

The implemented dashboard adds:

1. the account holder's saved personal receipts; and
2. that account holder's exact allocated share of household expenses.

The result is called **true cost** in the product. Personal receipts stay private,
while household members see the shared ledger, balances, settlement claims, and
UPI IDs needed to pay one another.

This repository contains hardened source and release materials for a controlled
18+ pilot. It is not evidence of a public launch, store approval, active users,
revenue, a partnership, or market validation. Read [how it works](HOW-IT-WORKS.md)
for task-by-task instructions and
[deployment and distribution](../release/DEPLOYMENT-AND-DISTRIBUTION.md) before
operating a hosted service.

## Who it is for

| Persona | Job to be done | Best entry point |
| --- | --- | --- |
| Resident tracking personal spend | Capture purchases and see month-to-date spend against a budget | Dashboard, Scan, Receipts |
| Roommate or shared-house resident | Record common costs, understand who owes whom, and settle without changing everyone else's personal ledger | Roommates |
| Browser shopper | Notice a completed web purchase and deliberately add it without retyping the amount and merchant | Chrome extension |
| Pilot coordinator/operator | Control enrollment, keep the service recoverable, support participants, and report only defensible aggregate outcomes | [Deployment guide](../release/DEPLOYMENT-AND-DISTRIBUTION.md) |

The current pilot is not designed for children, anonymous public use, businesses
doing bookkeeping, regulated accounting, lenders, or people who need bank-feed
reconciliation.

## What is implemented

### Accounts and budget

- Username/password registration, when an operator opens enrollment.
- A rolling 30-day browser session.
- Profile display name, monthly budget, and optional UPI ID.
- Current-password checks before changing the UPI ID, exporting data, or
  deleting an account.
- A dashboard showing monthly true cost, personal/shared components, budget
  pace, category totals, recent personal receipts, and a 14-day spend trend.

The **On track** state compares month-to-date true cost with the elapsed fraction
of the monthly budget. It is a pacing signal, not a forecast or financial
recommendation.

### Personal receipts

- Camera or file selection in the web/PWA; the Android wrapper deliberately uses
  a validated, picker-only JPEG/PNG flow with no camera/media permission.
- Server-side OCR using a bundled, checksum-verified English Tesseract model.
- Best-effort extraction of merchant, date, total, category, payment/document
  hint, and up to 30 line items.
- User review and correction before a receipt becomes ledger data.
- A line-item route that can save each recognized item as personal or send it
  to one selected household as a shared expense.
- Authenticated receipt history, detail, image access, and deletion.

OCR is an input aid, not a source of truth. It is heuristic, English-only, and
can misread totals, dates, merchants, categories, and line items. The user must
review the result.

### Households

- Create a household or join one using a six-character code.
- Record a shared expense with a payer, category, date, and selected split
  members.
- Exact integer-paise allocation and deterministic remainder handling.
- Simplified debtor-to-creditor balances.
- Recurring bills that post once per application-time-zone month after their
  configured day.
- Cash or UPI settlement claims that do not change balances until the recipient
  confirms receipt.
- A user-directed UPI deep link for the exact server-computed creditor and
  amount.
- A user-directed WhatsApp handoff containing the current named debts.

Every member can currently add expenses and recurring definitions. There is no
household administrator workflow beyond the stored owner field.

### Companion surfaces

- An installable PWA whose static shell can open offline. Financial data and
  writes always require the server; API responses are never cached.
- A single-activity Android WebView wrapper with validated receipt-image picker
  support, target-36 safe-area handling, first-party cookie sessions,
  exact-origin navigation, and user-initiated HTTPS, UPI, WhatsApp, phone, SMS,
  and mail handoff. `intent:` and `market:` links are blocked.
- A Chrome Manifest V3 extension that shows budget pace and household balances,
  adds quick household expenses, and offers completed-purchase candidates.
  Purchase detection is off by default, runs locally after explicit HTTPS-page
  permission, and saves nothing until the user selects **Track**.

## What it is not

MoneyMinder does not currently provide:

- bank, card, wallet, SMS, email, or UPI transaction import;
- payment processing, escrow, UPI PIN collection, Autopay, payment-status
  verification, refunds, or chargeback handling;
- financial advice, credit scoring, lending, investing, tax, or accounting;
- multiple currencies or exchange-rate conversion;
- automatic purchase logging by the Chrome extension;
- guaranteed OCR accuracy or third-party/manual OCR review;
- offline financial data access or offline writes;
- password reset, email/SMS verification, MFA, SSO, or an operator admin
  console;
- household rename/delete/leave, member removal, or shared-expense edit/delete;
- notifications, reminders, comments, attachments beyond receipt images, or
  real-time collaboration;
- horizontal multi-instance deployment.

Future concepts must be labeled as unimplemented. They must not appear in user,
partner, or store copy as shipped behavior.

## Product behavior that matters

### True cost and privacy boundary

For the current application-zone month:

```text
true cost = owned personal receipts + allocated shares of household expenses
```

Confirmed settlements change who owes whom; they do not erase the expense or
reduce true cost. A transfer settles a liability, while the purchase remains a
cost.

Household members can see household expenses, balances, settlement claims, and
member UPI IDs. They cannot see another member's personal receipt list, receipt
images, or monthly budget through the household API.

### UPI and WhatsApp

The UPI button constructs a `upi://pay` handoff from the server-returned
creditor, UPI ID, and exact outstanding amount. Returning from a payment app is
not proof of payment. The debtor must request confirmation, and the recipient
must confirm before balances change.

WhatsApp sharing opens `wa.me` with the household name and all current named
debts. It is an explicit user action. The external app/service receives the
message the user chooses to send; MoneyMinder does not send it in the
background.

### Recurring bills

The server checks recurring definitions at startup and every six hours. A due
definition posts at most once for the current month after its day (1–28) is
reached. The application time zone defaults to Asia/Kolkata and is
operator-configurable. The current UI splits new recurring definitions across
all active members.

### Categories

The canonical buckets are Food, Travel, Housing, Misc, and Other. OCR vocabulary
such as transport, gasoline, parking, toll, and accommodation is normalized for
dashboard totals. Unknown personal receipt categories fall into Misc; unknown
household categories fall into Other.

## Hard limits

These are enforced by the current source, not capacity promises.

| Boundary | Enforced limit |
| --- | --- |
| Money | Greater than zero for expenses/receipts/settlements; budget may be zero; maximum ₹1 crore per amount; at most two decimal places |
| Username | 1–32 letters, numbers, dot, underscore, or hyphen |
| Password | At least 15 Unicode code points; at most 72 UTF-8 bytes |
| Display name | 64 characters |
| Browser session | Rolling 30 days |
| Extension tokens | 30-day lifetime; at most 5 live tokens per account |
| Households | 20 memberships per account |
| Household members | 50 active members |
| Invite code | 6 characters, excluding ambiguous 0/O/1/I |
| Shared expenses | 1,000 created by an account and 1,000 in a household |
| Recurring bills | 200 created by an account and 100 in a household |
| Settlements | 1,000 created by an account and 1,000 in a household |
| Personal receipts | 1,000 saved records per account |
| One receipt upload | One JPEG or PNG; at most 5 MiB; width/height at most 8,192 px; at most 16 million pixels |
| Stored receipt images | 200 files or 100 MiB per account |
| Default global image ceiling | 10,000 files or 4 GiB, operator-configurable |
| Default application-state ceiling | 25 MiB serialized state, operator-configurable |
| OCR parser | Up to 30 proposed line items; at most 50,000 recognized characters processed |
| OCR request rate | 1 scan/account/minute and 2 scans/process/minute |
| API JSON body | 64 KiB |

The single OCR worker serializes recognition, and the current embedded SQLite
model serializes every state mutation through one version-guarded state row.
The supported release is capped at 30 active pilot accounts in one Node process.
These ceilings fit that controlled pilot, not unmeasured public scale or a
10,000-user/high-availability deployment.

## Privacy, export, and deletion

The canonical participant-facing statements are the
[privacy notice](../../public/privacy.html) and
[account deletion page](../../public/delete-account.html). They still require
real operator identity, contacts, processors, and retention periods before
external launch.

From Profile, a signed-in browser user can enter the current password and
download a JSON export. The export contains the public profile, owned receipt
records, households the user belongs to, expenses in those households, and
settlements involving the user. It is not a ZIP of receipt-image binaries.

Account deletion:

- removes credentials, server sessions, extension tokens, personal receipt
  records, and the user's uploaded-image directory through a durable retry
  queue;
- deletes a household and its ledger when no active member remains;
- otherwise rotates the household invite code, transfers ownership when needed,
  and replaces historical references with a non-login deleted-member identifier
  so remaining balances do not change;
- is irreversible from the product;
- does not immediately erase encrypted SQLite/uploads recovery points, proxy
  logs, or provider snapshots; those expire under the operator's published
  retention schedule.

Deletion cleanup can continue after the HTTP request. A pending user-directory
deletion temporarily blocks reuse of the same username.

## Support and recovery boundaries

Ask participants for the time, action, visible error, and response
`X-Request-ID` when available. Never ask for a password, session cookie, bearer
token, UPI PIN, SQLite file/backup, or an unredacted receipt unless the
published support process explicitly requires and protects it.

| Symptom | Supported response |
| --- | --- |
| Offline message | Reconnect. The shell may open offline, but data and changes are server-backed. |
| Scanner busy | Wait at least the server-provided retry interval and retry once; do not submit repeatedly. |
| OCR fields are wrong/blank | Correct the proposed fields before saving. A scan can be saved manually even when OCR cannot extract useful fields. |
| UPI app does not open | Use another installed UPI handler or record a cash/UPI claim manually; the recipient still confirms. |
| Payment remains pending | The named recipient must select **Confirm received**. A second claim for the same pair is blocked while one is pending. |
| Extension returns to login | Sign in again. Tokens expire, are revoked on logout/deletion, and are cleared after server rejection. |
| Account password is forgotten | There is no self-service reset or tested operator reset path. Use the published privacy/support contact for deletion or pilot-specific handling. Do not edit the production SQLite file by hand. |
| Account was deleted | It cannot be restored in-product. Shared history may remain pseudonymized; personal receipts and images are queued for deletion. |

The missing password-recovery/admin workflow is a real external-launch gap, not
a documentation omission. The operator must define a secure identity,
support, and deletion-request procedure before enrollment.

## Grounded differentiation

The strongest implemented product ideas are:

1. **One cost number across two privacy domains.** Personal receipts remain
   private while their amounts and household allocations reconcile into one
   monthly true-cost total.
2. **Capture once, route at line-item level.** OCR-proposed receipt lines can be
   assigned to the personal ledger or a household ledger before saving.
3. **Payment handoff without false certainty.** UPI launches externally, and the
   ledger stays unchanged until recipient confirmation.
4. **Deterministic accounting.** Amounts and split remainders use integer paise,
   so displayed balances reconcile exactly.
5. **Local-first companion detection.** The Chrome extension examines purchase
   pages only after opt-in and uploads only the derived fields the user chooses
   to track.
6. **Self-contained OCR operations.** The language model is bundled and
   checksum-verified; receipt images are not sent to an OCR SaaS or model CDN.

These are code-backed implementation choices, not proof that no competitor has
similar features. Market novelty and user value still require the evidence
program in [the pilot proposal](../PILOT-PROPOSAL.md) and
[impact plan](../STANFORD-IMPACT.md).

## Related documents

- [How MoneyMinder works](HOW-IT-WORKS.md)
- [Deployment and distribution](../release/DEPLOYMENT-AND-DISTRIBUTION.md)
- [Production readiness](../PRODUCTION-READINESS.md)
- [Repository README](../../README.md)
- [Android implementation notes](../../android/README.md)
- [Chrome extension implementation notes](../../extension/README.md)
