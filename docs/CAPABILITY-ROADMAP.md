# MoneyMinder Capability Roadmap

Status: `CONTRACT READY — IMPLEMENTATION WAITS FOR VISUAL APPROVAL`

## Capability

MoneyMinder becomes a multilingual, INR-first personal and household ledger
with a safe UPI settlement handoff and explainable month history. It does not
become a bank, payment processor, multi-currency wallet, or financial adviser.

## MVP Order

1. Integer-paise accounting, deterministic splits, shared provenance, atomic
   writes, and settlement integrity.
2. Safe peer-to-peer UPI handoff for a server-derived household debt.
3. Locale-ready UI with `en-IN` plus one human-reviewed pilot language.
4. Month history and one unified source-filtered activity ledger.

## Financial Foundation

- Store and compute every amount as integer paise.
- Reject negatives, exponent notation, unsafe ranges, `NaN`, `Infinity`, and
  more than two decimal places.
- Preserve split totals exactly with deterministic remainder allocation.
- Bind each settlement to a current debt inside the serialized write.
- Require payer and recipient to differ.
- Require `0 < amount <= current debt`.
- Allow at most one active settlement per household/from/to.
- Pending, cancelled, rejected, failed, and expired attempts never affect
  balances or true cost.
- Only the recipient can confirm; confirmation is single-use and idempotent.
- Receipt-derived shared expenses retain receipt and capture provenance.

## Localization Contract

### Supported pilot

- `en-IN`: canonical fallback.
- `hi-IN`: proposed pilot assumption; release requires a named bilingual
  reviewer and owner approval.

Additional language packs follow pilot evidence. Hindi UI does not imply Hindi
receipt OCR.

### Interfaces and data

- Persist an allowlisted BCP-47 `locale` on the user profile.
- Use native `Intl.NumberFormat`, `Intl.DateTimeFormat`, and `Intl.PluralRules`.
- Keep API enums, category keys, ISO dates at rest, paise values, and UPI
  protocol fields locale-neutral.
- Return stable server error codes with an English fallback message.
- Translate known codes client-side; unknown codes use a localized generic
  error.
- Keep user-entered merchant, household, member, receipt, email, phone, and UPI
  text unchanged.
- Web/PWA uses one shared catalog and helper.
- Extension uses packaged Chrome locale assets plus the account preference.
- Android native errors use string resources; the WebView inherits the web
  locale.
- Missing keys fall back to `en-IN`; development reports only the key.
- Development-only pseudo-localization expands copy by roughly 35%.

### Localization gates

- Human review of financial, settlement, permission, privacy, authentication,
  destructive-action, and error terminology.
- Equal catalog keys and interpolation placeholders.
- Correct `lang`, font glyphs, focus, live regions, chart summaries, and
  screen-reader labels.
- No clipping or horizontal overflow at 320, 390, 768, 1280, and 200% zoom.
- Identical financial results and UPI protocol amounts in every locale.

## UPI Settlement Contract

### Scope

UPI is a user-initiated external-app handoff between household members.
MoneyMinder never requests a UPI PIN, holds funds, reads bank data, or treats an
app return as proof.

The extension may open the full app at the settlement record; it never launches
a payment.

### Safe flow

```text
current debt
  -> review exact recipient, VPA, amount, and INR
  -> prepared handoff
      -> cancelled / expired / app unavailable
      -> payer marks payment completed
          -> awaiting recipient
              -> confirmed
              -> rejected
```

Only `confirmed` affects balances.

### Handoff rules

- The server derives the creditor, VPA, amount, currency, note, and public
  reference from the current debt.
- The MVP defaults to full settlement; payee and amount are not editable.
- The URI contains an encoded VPA/name, an ASCII two-decimal amount, `cu=INR`,
  and a non-sensitive public reference.
- Canonicalize once, then validate before exactly-once percent encoding:
  VPA 3–100 ASCII characters matching one `@`; payee name 1–100 Unicode
  characters; public reference 1–35 uppercase ASCII letters/digits/hyphens;
  note 1–80 printable ASCII characters.
- Reject control characters, line breaks, duplicate query parameters, decoded
  delimiters, invalid percent escapes, overlong values, and any field that
  changes after encode/decode round-trip.
- Do not include phone, email, household name, receipt details, bank data, free
  text, callback URL, or merchant fields.
- Do not store or log the launch URI, raw provider response, bank details, UTR,
  PIN, page URL, or analytics payload.
- VPA snapshots are visible only to payer and recipient.
- The Android host requires exact trusted origin, main-frame navigation, a user
  gesture, `upi:` plus the `pay` authority, validated fields, and an installed
  handler.
- Arbitrary `intent:` and unknown schemes are rejected.
- App unavailable, cancelled, provider failure, returned-without-result, and
  provider-reported success remain unverified states.
- Cancel and expiry are valid only while the handoff is `prepared`. After the
  payer claims payment, it remains awaiting the recipient until confirmation or
  rejection; it never silently expires.
- Rejection keeps balances unchanged, retains the audit record, warns both
  parties to verify before another attempt, and never triggers automatic retry.

### Required API behavior

- Idempotency key on prepare, claim-paid, cancel, confirm, and reject.
- Same key and same request returns the original result.
- Same key and a changed request returns `409`.
- Debt validation, duplicate detection, record creation, and idempotency
  persistence occur inside one atomic datastore update.
- Settlement/VPA endpoints are unavailable to extension bearer credentials.
- General household responses do not expose every member's VPA.
- Sensitive responses use `Cache-Control: no-store`.

## Month History Contract

- Validate a `YYYY-MM` month on summary, insights, receipts, and activity reads.
- Project one unified activity stream instead of duplicating stored data.
- Support personal receipt, shared expense, recurring expense, pending
  settlement, and confirmed settlement records.
- Filter by source, category, personal/shared/settlement, and month.
- Order deterministically by effective date, creation time, and ID.
- Preserve authorization and source drill-down.
- Pending settlements remain excluded from spend and balances.

## Required States

| Capability | States |
| --- | --- |
| Localization | first choice, profile choice, saved, missing-key fallback, long-text reflow, offline, extension restart, Android native error |
| UPI | review, app unavailable, launched, cancelled, returned unknown, payer claim, awaiting recipient, confirmed, rejected, expired, offline, retry |
| Month history | loading, empty, populated, filter, detail, invalid month, error, offline |

## TDD Handoff

1. Money parser, formatter, overflow, decimals, split remainder, and migration.
2. Settlement self-pay, direction, maximum, duplicate, replay, concurrency,
   confirmation, cancel, reject, and idempotency.
3. Receipt-to-shared provenance and atomic retries.
4. Locale allowlist, persistence, fallback, catalogs, interpolation, plural,
   INR/date formatting, and coded errors.
5. Month validation, reconciliation, filtering, ordering, and authorization.
6. UPI URI encoding, immutable server-derived fields, unavailable/cancel/return,
   and unverified state handling.
7. Android exact-origin, gesture, scheme, handler, cancellation, and return.
8. Extension locale/consent/INR/full-app handoff.
9. Critical E2E in both locales and at all approved viewports.
10. Coverage gate: at least 80% across changed unit, integration, and E2E scope.

## Non-Goals

- Bank feeds, UPI Autopay, collect requests, refunds, disputes, stored bank
  credentials, payment gateways, PSP/TPAP behavior, or automatic verification.
- Provider-specific payment buttons.
- Multi-currency or currency conversion.
- Runtime machine translation, shallow all-India language rollout,
  multilingual OCR, or RTL before a selected locale requires it.
- AI financial advice or autonomous money movement.

## Open Approval

- Approve Teal Khata as the product-wide visual direction.
- Approve `hi-IN` as the first pilot language, or name the pilot language.
- Approve handoff-only UPI and full-debt settlement for the pilot.
