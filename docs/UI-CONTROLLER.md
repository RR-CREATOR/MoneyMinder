# MoneyMinder UI Controller

Status: `STOP — pre-implementation gates are not yet green`

This document is the design-control contract for the MoneyMinder web/PWA,
Android wrapper, and Chrome extension. It turns the supplied design workflow
into an evidence-based sequence with explicit approval, security, and quality
gates.

## Verified Source

- Video: [The NEW Kimi K3 Creates Insane Web Designs](https://www.youtube.com/watch?v=sUeTik8Sf4o)
- Creator: Viktor Oddy
- Visible YouTube duration: 13:01. Player metadata reports 780 seconds.
- Related prompt index: [MotionSites Academy](https://motionsites.ai/academy)

The video is process guidance, not permission to replace MoneyMinder's stack or
copy an unrelated visual world. Its relevant workflow is:

1. Collect references at the level of websites, sections, fonts, images, and
   motion.
2. Use a structured prompt and attached references to make the first page.
3. Compare more than one output; do not accept the first result.
4. Replace generic generated media with authored assets that match the selected
   composition.
5. Iterate and inspect section by section, then inspect the entire scroll.
6. Transfer the chosen visual language to the remaining pages while preserving
   the existing product structure.
7. Use hover reveal, parallax, video, or 3D only when it improves hierarchy or
   meaning.
8. Verify the production build and mobile responsiveness.

For MoneyMinder, “preserve structure” includes route names, information
architecture, form order, financial vocabulary, API behavior, platform
architecture, and transaction semantics.

## Source Priority

When inputs disagree, use this order:

1. `PRODUCT.md` and verified user/product truth
2. Current APIs, financial invariants, and passing tests
3. User-approved visual target pack and the resulting `DESIGN.md`
4. Web, Android, extension, accessibility, privacy, and security constraints
5. Video and external-tool inspiration

## Controller Roles

| Role | Authority | Required output |
| --- | --- | --- |
| Supervisor/controller | Stops or advances each stage | Gate verdict and unresolved-decision register |
| Web reviewer | Web/PWA routes, states, responsive behavior | Route/state inventory and 320/390/768/1280 target contract |
| Android reviewer | WebView boundary and native integration | Origin, permission, intent, lifecycle, offline, and release contract |
| Extension reviewer | MV3 popup/content boundary | State, detection, permission, storage, CSP, and constrained-viewport contract |
| Security reviewer | Financial and data boundaries | Threat model, financial invariants, and executable acceptance tests |
| Resource curator | Reference and tool fit | Reference brief, tool constraints, and asset/prompt guardrails |
| Finish reviewer | Independent visual and functional QA | Same-viewport reference/output comparison and release verdict |

## Stage Gates

### Stage 0 — Evidence Freeze

Required:

- existing routes, screens, tokens, brand assets, platform architecture, and
  functional tests inventoried
- supplied videos and reference URLs captured and inspected
- reference library records what to borrow and what not to copy
- external tools classified as reference, advisory, or approved dependency

Exit condition: source evidence is traceable and no unsupported tool or visual
claim is treated as product truth.

### Stage 1 — Functional Truth Audit

Required:

- every visible control mapped to a working route, action, or explicitly
  visual-only state
- full loading, empty, populated, error, offline, pending, confirmed, and
  permission-denied state inventory
- money represented as integer paise or by an explicitly tested rounding policy
- settlement direction, maximum amount, replay, concurrency, and confirmation
  behavior frozen
- household, receipt, recurring, export, and deletion ownership rules tested

Exit condition: the design cannot imply unsupported behavior or conceal a
financial ambiguity.

### Stage 2 — Visual Target Pack

Required targets:

- dashboard at 320, 390, 768, and 1280 CSS pixels
- dashboard at 200% zoom
- household and settlement flows
- receipt scan, review, detail, loading, error, and permission-denied states
- extension popup: detected, uncertain, empty, loading, error, saved
- Android: picker selection/cancel, external-intent fallback, offline, keyboard,
  four-edge safe-area, and back-navigation states

Every target includes:

- aesthetic, attached references, intent, and guardrails
- typography, color, spacing, radius, elevation, and motion decisions
- touch, keyboard, reduced-motion, contrast, and opaque-fallback behavior
- realistic INR data and correct “true cost = personal + shared share” semantics

Current visual direction: “Teal Khata,” derived from the selected second option.
The authoritative focused pack and revision history are recorded in
`.design/targets/teal-khata-v1/README.md`. Earlier generated-image paths are
design history, not implementation inputs.

Exit condition: the user approves the full multi-viewport, multi-state pack.

### Pre-Implementation GO

The supervisor may issue `GO` only when:

- the visual target pack is approved
- `DESIGN.md` records the approved decisions
- financial and rounding invariants are frozen
- web/PWA, Android, and extension platform contracts are approved
- the threat model has executable acceptance tests
- every open decision has an owner and resolution

Until then, agents may research, audit, model threats, write test
specifications, and revise visual targets. They may not implement the redesign.

### Stage 4 — Tests First

Ponytail begins here and is used only while writing code. Add or strengthen
tests before changing behavior, starting with financial invariants and platform
boundaries.

### Capability Expansion — Contract Before UI

The requested expansion adds:

- `en-IN` and `hi-IN` localization across web/PWA, native Android host copy, and
  the extension
- safe UPI settlement handoff with an exact recipient and amount
- month history and a unified, source-filtered ledger as the highest-value
  adjacent capability

These additions do not bypass the earlier gates. UPI is an external-app handoff,
not payment processing or bank verification. Returning from a UPI app is never
proof of payment. Localization uses reviewed catalogs and native `Intl`
formatting; user-entered names remain unchanged. Additional languages, bank
feeds, Autopay, payment gateways, and AI financial advice remain out of MVP
until evidence and separate trust contracts justify them.

### Stage 5 — Server and Financial Invariants

No UI implementation may compensate for an invalid server invariant. Settlement
and ownership release gates are resolved here before surface polish.

### Stage 6 — Web/PWA

- mobile ledger rows below 768 px; tables only when space supports scanning
- liquid glass limited to navigation and transient layers with opaque fallbacks
- no glass over dense financial records or destructive/settlement confirmation
- Tweaks Bar is local-development only, resets/exports tokens, and cannot mutate
  product data
- service-worker and offline behavior do not cache API responses incorrectly
- content security policy is not weakened for visual effects

### Stage 7 — Android and Extension Adapters

Android:

- exact scheme, host, and port allowlist; release navigation uses HTTPS
- single-image system content picker; camera, microphone, and unknown WebView
  permission requests denied
- external schemes allowlisted with safe fallback
- UPI return is never treated as payment proof
- release builds have no WebView debugging, placeholders, cleartext traffic,
  broad file access, third-party cookies, or unreviewed JavaScript bridges

Extension:

- detected purchases are advisory and require explicit confirmation before save
- candidate data is held in `chrome.storage.session`, not persisted browsing
  history or page text
- site access is opt-in or narrowly scoped
- tokens are sent only to approved API origins
- production CORS permits the exact extension identity
- no inline scripts, `eval`, CDN code, or runtime code fetch

### Stage 8 — Independent Review

Reviewers compare each approved target and implementation at the same viewport
and state. Screenshots alone are not QA. The comparison must cover source code,
rendered output, keyboard/touch behavior, reduced motion, performance, security
acceptance tests, and real platform behavior.

### Stage 9 — Integration and Release

Release only after:

- all hard gates pass
- responsive and platform matrices pass
- no placeholder credentials or origins remain
- uploads verify actual image content
- session storage is production-safe
- extension CORS and Android origin policies are exact
- regression tests and production build pass

## Visual Guardrails

- Keep the recognisable “Teal Khata” account-book character without turning the
  entire interface into translucent decoration.
- Liquid glass communicates layer and temporary context; it is not a card style
  applied everywhere.
- Ledger values, provenance, balances, settlement direction, and destructive
  actions remain opaque, high-contrast, and stable.
- Motion may clarify state, causality, or navigation. Decorative parallax and
  hover-only information are prohibited in ledger and settlement flows.
- Every hover behavior needs a touch and keyboard equivalent.
- Every non-essential transition needs a reduced-motion path.
- Use authored assets only where they serve a measured slot and a real product
  story. MoneyMinder does not need background video or 3D merely because the
  source video demonstrates those techniques.

## Current Hard Blockers

- revised direction and 18-artifact approval pack not approved
- `DESIGN.md` intentionally absent pending approval
- focused multi-viewport and multi-state target pack is complete at
  `.design/targets/teal-khata-v1/`; exhaustive post-GO capture matrix remains
- mobile receipt/ledger information density is visually resolved as ledger rows
  below tablet widths; implementation and reflow tests remain
- financial settlement and rounding rules not frozen
- Android origin and permission policy not approved
- extension permission and data-minimization policy not approved
- security threat model and acceptance-test specification awaiting contract
  approval; executable tests begin only after `GO`
