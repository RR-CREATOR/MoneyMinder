# MoneyMinder UI Gate Register

Historical redesign audit snapshot. Its `STOP` verdict applies to the
then-proposed visual redesign, not the current release candidate. Use
[`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md) as the current release
authority.

Controller verdict: `STOP`

Baseline: the existing automated suite passes `56/56`. That suite does not yet
prove the financial, responsive, platform, or provenance invariants required by
the redesign.

## Ordered Release Gates

| Order | Gate | Why it blocks the redesign |
| ---: | --- | --- |
| 1 | Settlement integrity | Cash/default settlements can self-confirm; current debt direction, maximum amount, self-payment, replay, and concurrency are not safely constrained. |
| 2 | Integer money | Receipts, budgets, shared expenses, recurring bills, summaries, and settlements use floating-point `Number`; split remainders and display reconciliation are not exact. |
| 3 | Shared provenance | Receipt-derived household expenses lose their source, so “true cost” cannot be fully drilled back to evidence. |
| 4 | Atomic financial actions | Receipt splitting and repeated settlement/write actions need idempotent, concurrency-tested server transactions. |
| 5 | Responsive target truth | The current 480 px phone canvas is not a desktop/tablet design; the revised mobile target compresses five columns and invents unsupported controls/data. |
| 6 | Android trust boundary | Origin matching, intent dispatch, picker validation, lifecycle recovery, permissions, and release placeholders are not production-ready. |
| 7 | Extension truth/privacy | The extension compares monthly spending to a daily budget, reads all sites by default, persists bearer credentials too broadly, accepts unsafe API origins, and lacks detection confidence/currency constraints. |

## Platform Verdicts

| Surface | Verdict | May proceed now |
| --- | --- | --- |
| Web/PWA | `STOP` | Route/state inventory, API design, target revision, and test specification |
| Android wrapper | `GO WITH CONDITIONS` for architecture-preserving design; `NO-GO` for release | Exact-origin, permission, intent, lifecycle, inset, offline, and device-matrix specifications |
| Chrome extension | `NO-GO` for production sign-off | Detection-confidence, consent, token/origin, state, accessibility, and visual specifications |
| Server/security | `NO-GO` for redesigned money and settlement surfaces | Threat model, integer-paise policy, provenance contract, and acceptance tests |

## Authoritative Visual Target

The current focused approval pack is
`.design/targets/teal-khata-v1/README.md`. Only filenames listed in that
manifest are authoritative; earlier files in the same directory are retained
revision history.

Resolved in the authoritative pack:

- ledger rows replace narrow five-column tables
- all summary, category, receipt, shared-share, and debt-direction arithmetic
  reconciles
- pending UPI handoff is not shown as confirmed payment
- invalid money disables financial projections and submit actions
- saving locks navigation and source/allocation mutations
- extension consent, privacy copy, opaque money surfaces, and 44 px controls are
  visible contracts
- Android recovery uses opaque inset-safe navigation and safe permission exits

The pack remains a design target, not implementation QA.

## Requested Capability Expansion

| Capability | MVP boundary | Gate |
| --- | --- | --- |
| Localization | `en-IN` fallback plus reviewed `hi-IN`; native `Intl`; stable server error codes; user-entered names unchanged | Catalog parity, interpolation, 320 px/200% reflow, native/extension fallback, reviewed financial terminology |
| UPI settlement | User-initiated `upi://pay` handoff for exact server-sourced recipient and paise amount; return remains unverified | Paise migration, debt binding, duplicate/replay prevention, exact Android origin/scheme allowlist, recipient confirmation |
| Month history | Month-aware true cost and unified source-filtered activity projection | `YYYY-MM` validation, authorization, deterministic ordering, provenance, reconciliation |

Not MVP: bank feeds, UPI Autopay, payment-gateway or PSP processing, automatic
bank confirmation, multi-currency conversion, unreviewed language packs, or AI
financial advice.

## Required Target Pack

The approval pack must use fixed synthetic data, fixed date `2026-07-26`,
locale `en-IN`, deterministic IDs, and the same financial reducer.

Widths:

- 320 px phone
- 390 px phone
- 768 px tablet/WebView
- 1280 px desktop
- 200% zoom/reflow variant

Surfaces and critical states:

| Surface | States |
| --- | --- |
| Dashboard | loading, empty, on-track, over-budget, error, offline |
| Receipts | loading, empty, populated, detail with/without image, delete pending/error, offline |
| Household | none, list, owe, owed, settled, settlement sender-pending, recipient-pending, confirmed, error, offline |
| Scan/review | initial, image selected, camera denied, scanning, OCR success, manual fallback, split review, save pending/error/offline |
| Extension | logged out, permission explanation, loading, no detection, strong detection, review detection, write pending/error/success, token expired |
| Android host | cold start, committed, main-frame error/retry, external intent unavailable/return, chooser canceled, offline, IME, safe area, back, renderer recovery |

## Frozen Financial Contract Required Before GO

- amounts are integer paise at rest and during computation
- inputs reject negatives, unsafe ranges, more than two decimals, `NaN`,
  `Infinity`, and unsupported exponent notation
- split allocation preserves total paise exactly with deterministic remainders
- pending settlements never affect balances
- settlement direction must match a current debt
- settlement amount cannot exceed that debt
- payer and recipient must differ
- only the recipient can confirm
- confirmation is single-use
- duplicate pending settlement for the same household/from/to is rejected
- concurrent mutations serialize without lost updates
- shared receipt items retain capture and receipt provenance
- settlements never reduce true cost

## Platform Contracts Required Before GO

Android:

- exact scheme/host/effective-port comparison
- production HTTPS only
- allowlisted, user-initiated external schemes
- no arbitrary `intent:` dispatch
- no WebView camera/device permission grants in the picker-only wrapper
- single-image system content picker without camera or broad storage permissions
- native loading/error/retry, renderer recovery, lifecycle cleanup, Back policy
- one safe-area/IME inset owner and no portrait-only dependency

Extension:

- monthly true cost compared with monthly budget
- DOM detection off until explicit opt-in
- candidate stored per tab in `chrome.storage.session`
- bearer token inaccessible to content scripts
- remote HTTP rejected; only loopback development may use HTTP
- production CORS allowlists the release extension identity
- foreign currency rejected instead of relabelled INR
- confidence is `strong` or `review`, with explicit evidence rules
- “Add to personal ledger” exposes destination and requires a click
- raw page text, URLs, order IDs, contact/payment data, and JSON-LD are not stored

## First Implementation Batch After GO

Ponytail begins only when this code-writing batch starts.

1. Add and test a single integer-paise money boundary.
2. Fix and test settlement direction, maximum, pending/confirm, replay, and
   concurrency invariants.
3. Preserve and test receipt-to-shared-expense provenance.
4. Make financial retries idempotent/atomic where the approved UI requires them.
5. Only then implement the approved responsive design tokens and core dashboard
   hierarchy.
