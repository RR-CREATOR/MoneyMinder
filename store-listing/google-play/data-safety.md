# Google Play Data safety worksheet

This worksheet describes the current code. Reconfirm it against the production
hosting, logging, backup, and support configuration before submitting.

The source includes a sponsored-offer capability that is disabled by default
with `PROMOTIONS_ENABLED=false`. While it remains disabled, no offer is served
and no promotion event is collected. Before enabling it, complete the
reconciliation section below and update the submitted form to the exact hosted
behavior.

## Top-level answers

- Does the app collect or share required user data types? `Yes — collects`
- Is all user data encrypted in transit? `Yes`
- Can users request deletion? `Yes`
- In-app deletion path: `Profile → Your data → Delete account`
- External deletion URL: `https://<production-host>/delete-account.html`
- Data shared under Play's definition: expected `No`, provided hosting/storage
  vendors act only as service providers and user-initiated UPI/WhatsApp handoffs
  qualify for the user-action exception. Confirm the deployed contracts.

## Data types

| Play data type | Required or optional | Purpose | Handling |
| --- | --- | --- | --- |
| Name | Optional display name | App functionality | Stored until changed/deleted |
| User IDs | Required username/account identifier | Account management, security | Stored until account deletion |
| Email address | Required | Account management | Stored until account deletion |
| Phone number | Required | Account management | Stored until account deletion |
| User payment info | Optional UPI ID/VPA | App functionality | Shown only to relevant household members |
| Purchase history | Optional receipts, expenses, settlements | App functionality | Stored until deleted; shared-ledger rows are pseudonymized on account deletion |
| Other financial info | Monthly budget, balances, debts | App functionality | Stored while the account/ledger exists |
| Photos | Optional receipt scans | App functionality | Sent for server-side OCR; retained with a saved receipt, or queued for deletion after 24 hours if the recognized scan is abandoned |
| Other user-generated content | Optional household names, descriptions, merchant and recurring-bill text | App functionality | Stored with the related record |
| App interactions | Required while using the service; sponsored events only when enabled | Security, diagnostics; declared aggregate pilot Analytics; Advertising or marketing and Analytics for enabled sponsored events | Route/method/status/duration logs with no request bodies; enabled promotion records use campaign/type only, not user/IP |
| Diagnostics | Required while using the service | App functionality, diagnostics | Request status and duration |
| Device or other IDs | IP address processed ephemerally | Fraud prevention, security | Used for rate limiting; the app does not log or infer location from it |

## Deletion and retention

- Credentials, active sessions, extension tokens, personal receipts, and
  uploaded images are deleted with the account.
- Shared expenses, recurring bills, and settlements remain under a non-login
  deleted-member identifier so other members' balances remain correct.
- Encrypted recovery points include the SQLite state/session database and the
  `DATA_DIR` filesystem containing stored and staged receipt images. Local
  copies are pruned 30 days after a newly verified backup.
- The dedicated private, versioning-disabled OCI backup bucket must have an
  enabled, unfiltered **Delete objects** lifecycle rule of no more than 30 days.
  Weekly encrypted operator-held copies outside the tenancy must also be
  configured and verified to expire within 30 days.
- Every restore must be isolated first and reconciled against the external
  deletion register before restored data can replace production, preventing
  an older recovery point from silently resurrecting deleted accounts or
  receipt images.
- Service logs expire according to the operator's published production
  retention schedule.
- If aggregate pilot reporting continues, select `Analytics` as a purpose for
  the data used to produce those reports; otherwise remove that use from the
  public policy.

## Sponsored-offer reconciliation

An enabled deployment may collect only the fact that a non-personalized
sponsored card became visible or its HTTPS link was deliberately clicked. Treat
those records as **App interactions** used for **Advertising or marketing** and
**Analytics** in the Play form, even though reports contain aggregate totals
only.

Each event request uses a fresh random idempotency key. The server persists only
its SHA-256 hash, campaign ID, event type, and timestamp, then increments
per-campaign UTC daily counts; it does not persist the signed-in user or request
IP with the event. The current cleanup removes hash receipts older than 48 hours
only when a later event arrives, so an idle campaign can retain its last batch
longer. Daily aggregate counters also have no implemented expiry. Promotions
must remain disabled until the operator implements and tests guaranteed cleanup
or approves, publishes, and submits a different finite retention schedule.
Never describe the current code as a guaranteed 48-hour deletion.

The implementation and submission must preserve these answers:

- offers are not selected using receipts, purchases, merchant history, item
  text, amounts, categories, budgets, balances, debts, settlements, household
  membership, UPI IDs, receipt images, Chrome page content, browsing activity,
  account identifiers, advertising IDs, or device identifiers;
- no promotion payload or event is sent to a merchant, advertising network, or
  third-party advertising/analytics SDK;
- merchant reporting is limited to aggregate impression and click totals and
  cannot be joined to users, households, receipts, transactions, or devices;
- disabling promotions stops serving offers and collecting promotion events;
  and
- the Chrome extension remains promotion-free and sends no promotion events.

Before activation, re-review Data safety, the hosted privacy policy, content
rating, listing copy, reviewer notes, and the Play Console Ads answer. Set the
answer required for Play's **Contains ads** label and complete the applicable
review before changing the server flag. Verify the merchant's identity and
control of the destination and manually review the exact public HTTPS URL and
content; users and HTTP clients cannot create campaigns. Do not infer Console
answers from the source default.

## Not collected by the app

- Precise or approximate location
- Contacts
- SMS or call log
- Audio
- Advertising ID
- Health data
- Files outside user-selected receipt images
- Third-party advertising or analytics SDK data
