# MoneyMinder resident pilot

> Proposal only: demos and partner review may proceed, but no resident may be
> enrolled and no live data may be collected until every live-cohort gate in
> [production readiness](PRODUCTION-READINESS.md) is complete.

## Fewer roommate money disputes. Clearer student finances.

MoneyMinder gives residents one view of personal spending and their share of common costs. It supports recurring rent and utilities, receipt scanning, itemized splits, WhatsApp summaries, and UPI handoff with recipient confirmation.

## Four-week pilot

- 30–60 residents, age 18+, across at least ten complete rooms
- One 30-minute onboarding workshop and QR/code household setup
- One weekly reminder sent by the residence team
- Baseline and endline three-question survey
- Aggregate adoption and outcome report
- No operator access to named purchases, receipt images, household balances, or UPI IDs

## Promotion state

The resident-outcome pilot is promotion-free by default:
`PROMOTIONS_ENABLED=false`. This prevents a merchant offer from influencing the
pilot's activation, retention, reimbursement, or money-clarity results.

A sponsored-offer experiment requires a separate written protocol and store
disclosure review before activation. If approved, it may show only one
non-personalized, clearly labelled **Sponsored** dashboard card that the resident
can dismiss. MoneyMinder must not use receipts, merchants, amounts, categories,
budgets, balances, debts, household membership, UPI IDs, receipt images, Chrome
page content, browsing activity, user IDs, or device IDs to select the offer.
The partner or merchant may receive aggregate impression/click totals only, not
named or household-level activity. No resident financial or browsing data is
sold or shared for advertising.

## Success agreed before launch

| Measure | Target |
|---|---:|
| Join within 48 hours | 60% of invitees |
| Complete-room activation | 50% of targeted rooms |
| Week-two retained use | 35% of activated users |
| Active-room usage | Median 6+ expenses |
| Outcome | 25% faster reimbursement or 20% clearer money/roommate transparency |

## Commercial test

The first evidence pilot may be free when the partner supplies a named cohort, launch date, and written outcome confirmation. A follow-on pilot tests ₹25,000–₹75,000 per 100-resident facilitated cohort or ₹30–₹100 per activated resident per year. These are hypotheses, not established prices.

## Boundaries

MoneyMinder does not hold money, request UPI PINs, read SMS messages, or claim that a UPI payment succeeded based only on returning to the app. UPI records remain pending until the recipient confirms receipt.
