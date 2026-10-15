# MoneyMinder Product Truth

## Product

MoneyMinder is an INR-first, phone-first money product that combines personal
budgeting with household cost splitting. It turns receipt scans, manual expenses,
shared bills, and settlements into one personal cost ledger.

Current status: pilot prototype for controlled 18+ cohorts. It is not yet a paid
public deployment.

## Primary Audience

Repository-inferred until the product owner refines it:

- Students, roommates, and young adults in India who manage both personal spending
  and recurring household costs.
- People who need a faster, clearer alternative to maintaining separate budgeting,
  receipt, and split-bill tools.

## Core Job

Show the user their trustworthy “true cost”: personal spending plus their share of
household expenses, with enough provenance to understand every amount and settle
balances confidently.

## Unique Mechanism

One receipt can become categorized personal spending, a shared household expense,
or a combination of both, while every result remains attributable to a source and
visible in the same ledger.

## Product Surfaces

- Web/PWA: primary product surface and source of truth.
- Android: WebView wrapper around the hosted web/PWA experience; not a native
  feature rewrite.
- Chrome extension: compact companion for detecting and recording online purchases,
  checking budget pace, and opening the full app.

## Essential Workflows

1. Scan or enter an expense.
2. Classify it as personal, shared, or split by line item.
3. See monthly true cost against budget.
4. Inspect receipts and shared-expense provenance.
5. See who owes whom and settle with recipient confirmation.
6. Create and manage recurring household bills.

## Product Principles

- Financial trust outranks visual novelty.
- Every total must be explainable and drillable.
- Personal and shared provenance must remain visible.
- Amounts use INR conventions and tabular numerals.
- Native controls and familiar financial affordances remain recognizable.
- The same activity vocabulary, category system, and status language span web,
  Android, and extension.
- Mobile is the primary layout; wider web layouts may use space without becoming a
  separate product.

## Hard Constraints

- Preserve the existing Node/Express, vanilla HTML/CSS/JS, JSON datastore, PWA,
  Android-wrapper, and Manifest V3 architecture unless a separate engineering
  decision changes it.
- Preserve local receipt OCR and keep secrets off the client.
- Do not introduce fabricated balances, financial claims, or unsupported features.
- Do not use generic purple gradients, glassmorphism, decorative dashboard clutter,
  or novelty interactions that weaken comprehension.

## Design Success

A first-time user can answer these questions within seconds:

- What did I truly spend this month?
- How much was personal versus shared?
- Am I on track?
- What needs my attention next?
- Where did each amount come from?

## Open Product Decisions

- Confirm the primary audience segment and acquisition context.
- Confirm whether the wallet mark and current indigo are durable brand commitments.
- Confirm which two or three products should define the conventional craft bar if
  MoneyMinder chooses the category-standard design direction.
