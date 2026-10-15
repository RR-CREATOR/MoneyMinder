# MoneyMinder pitch memo

Status basis: 26 July 2026

> MoneyMinder is an INR-first, phone-first ledger that shows a resident what
> they spent personally plus their exact share of household costs, then lets
> roommates settle through an existing UPI app without MoneyMinder holding
> money.

The initial wedge is a controlled, institution-sponsored program for adults
sharing rooms during their first month away from home. This is a product and
pilot thesis, not a claim of market validation.

## Claims baseline

This table is the commercial source of truth for this memo and
[the innovation thesis](INNOVATION.md). Code and tests are authoritative for
implemented behavior; the
[product guide](product/PRODUCT-GUIDE.md) is authoritative for product
positioning; [production readiness](PRODUCTION-READINESS.md) is authoritative
for launch status.

| Topic | Defensible statement |
| --- | --- |
| Product | Working web/PWA source, an Android WebView wrapper, and a Chrome Manifest V3 companion are present in the repository. |
| Release status | Production-hardened source exists, but the product is not externally launched. Operational, legal, hosting, signing, and final device gates remain. |
| Target user | Repository-inferred primary user: an adult student, roommate, or young adult in India managing personal and shared costs. This segment is not yet validated. |
| Initial buyer | Hypothesis: a student-experience, community, residence, or hostel-operations leader sponsoring a bounded cohort. No qualified buyer or signed partner is supplied. |
| Traction | No live cohort, active-user, retention, download, store-approval, or partner evidence is supplied. |
| Revenue | No revenue, paid pilot, contract, or payment evidence is supplied. |
| Pricing | The figures below are test ranges, not established prices. |
| Market size | No TAM, SAM, SOM, market-growth figure, or defensible sizing method is supplied. Do not add one without sourced assumptions. |
| Team | Founder/creator identity, team composition, biographies, roles, and execution history are not supplied. |
| Entity and ownership | Company status, jurisdiction, cap table, and intellectual-property ownership are not supplied. |
| Fundraising | No raise amount, instrument, valuation, runway, use of funds, or financing timeline is supplied. |
| Impact | Reimbursement and money-clarity figures below are proposed pilot thresholds, not measured outcomes. |

## Problem hypothesis

Residents sharing a room often have three separate jobs:

1. understand their own monthly spending;
2. calculate their share of rent, groceries, utilities, and other common costs;
3. move money and agree that a reimbursement is complete.

Personal budget tools, shared ledgers, payment apps, chats, and spreadsheets can
each handle part of that workflow. The product hypothesis is that separation
makes a resident's actual monthly cost harder to see and makes room-wide
adoption fragile. Payment handoff is not the same as ledger truth: an app return
cannot prove that the intended recipient received the money.

These are testable problems, not repository-proven prevalence claims. The
[go-to-market plan](GO-TO-MARKET.md) requires problem interviews and a dated
pilot commitment before treating the institutional wedge as valid.

## Users, buyer, and privacy boundary

| Role | Job to be done | MoneyMinder proposition |
| --- | --- | --- |
| Adult resident | See personal spending and household share in one monthly view | A "true cost" dashboard, receipt capture, shared expenses, recurring bills, balances, and settlement status |
| Room or household | Keep one consistent record of who paid, who shares the cost, and what remains owed | Invite-code setup, deterministic splits, simplified debts, and recipient-confirmed settlement |
| Residence partner | Improve complete-room activation and test whether money coordination becomes clearer | A bounded onboarding program and aggregate outcome report |

The proposed partner report excludes named purchases, receipt images, household
balances, and UPI IDs. MoneyMinder does not request a UPI PIN, hold funds, read
bank data, or represent an external payment as complete merely because the user
returns from a UPI app. The recipient confirms settlement.

## Product

The current workflow is:

1. Capture spending by receipt scan, manual entry, or an explicitly enabled
   browser-extension suggestion.
2. Correct the extracted receipt details before saving.
3. For itemized receipts, mark each line as personal or shared and route shared
   lines to a household.
4. Combine personal receipts with the user's allocated share of household
   expenses in one monthly INR view.
5. Create recurring household bills and see simplified balances.
6. Hand a validated debt to an installed UPI app or record cash, keep the claim
   pending, and let the recipient confirm it.
7. Export personal data or delete the account; preserve shared ledger meaning
   under a non-login deleted-member identity when roommates remain.

The server datastore and server-side calculations are the source of truth. The
web/PWA is the primary product surface; Android wraps it with validated
receipt-image selection and external-intent integration. The Chrome extension
is a permissioned companion, not an autonomous financial agent.

## Why test now

This is a "why run the experiment now" case, not a macro-market claim:

- The core journey is implemented far enough to test behavior instead of
  soliciting opinions about mock-ups.
- UPI handoff uses payment apps residents may already have; MoneyMinder does not
  need to become a payment processor to test settlement coordination.
- A residence can recruit complete rooms together, making the group-activation
  hypothesis measurable in one bounded cohort.
- The proposed four-week format can test activation, week-two return, room
  activity, reimbursement age, money clarity, and willingness to pay before
  further feature investment.
- The privacy boundary is explicit enough to test whether a partner can support
  the program without receiving resident-level financial data.

## Implemented proof

Implemented source is not customer traction, but it reduces technical
uncertainty around the proposed pilot.

| Capability | Repository evidence | What it proves |
| --- | --- | --- |
| Unified personal and shared monthly cost | [`server/api.js`](../server/api.js), [`public/index.html`](../public/index.html) | Personal receipts and allocated household shares feed one category and monthly total calculation. |
| Exact split arithmetic | [`server/money.js`](../server/money.js), [`server/households.js`](../server/households.js) | Amounts are validated and aggregated in integer paise; uneven remainders are assigned deterministically. |
| Receipt scan and correction | [`server/ocr.js`](../server/ocr.js), [`public/scan.html`](../public/scan.html) | A bundled, checksum-verified English OCR model extracts editable receipt fields and line items without a third-party OCR API. |
| Mixed receipt routing | [`public/scan.html`](../public/scan.html) | A user can mark extracted lines as personal or shared and save them to the corresponding ledger. |
| Household and recurring workflow | [`server/households.js`](../server/households.js), [`server/recurring.js`](../server/recurring.js) | Invite-code membership, expenses, recurring definitions, balances, and bounded monthly posting are implemented. |
| Settlement trust rule | [`server/households.js`](../server/households.js), [`server/e2e.test.js`](../server/e2e.test.js) | A settlement is bounded by current debt, remains pending, and affects balances only after the recipient confirms it. |
| Retry safety | [`server/http.js`](../server/http.js), [`public/js/api.js`](../public/js/api.js) | Retry-prone creates accept idempotency keys and reject reuse for different input. |
| Consent-based web purchase capture | [`extension/detect.js`](../extension/detect.js), [`extension/README.md`](../extension/README.md) | Page detection is opt-in, local, advisory, and requires a user action before saving. |
| Account controls | [`server/auth.js`](../server/auth.js), [`server/uploads.js`](../server/uploads.js) | Export, password-verified deletion, invite rotation, ledger-safe anonymization, and durable image-deletion retries are implemented. |
| Release discipline | [`package.json`](../package.json), [production readiness](PRODUCTION-READINESS.md) | The repository has syntax, test, coverage, dependency, container, SQLite restart, Chrome, and Android gates; external deployment prerequisites remain explicit. |

## Differentiation

MoneyMinder should not be pitched as "Splitwise for India," and UPI is not a
moat. OCR, group balances, recurring bills, debt simplification, categories,
charts, PWA packaging, and deep links are standard capabilities.

The differentiated thesis is the combination of:

1. **One resident-level true-cost model.** Personal receipts and the resident's
   deterministic share of household costs appear in the same monthly budget
   view.
2. **One mixed-purchase decision.** An itemized receipt can be separated into
   personal and shared lines at capture time instead of being reconciled later
   across two tools.
3. **Settlement without false certainty.** MoneyMinder hands payment to an
   external app but keeps ledger state pending until the recipient confirms.
4. **Complete-room distribution.** A residence-sponsored program attempts to
   activate the social unit together rather than acquiring isolated users.
5. **Outcome reporting without a resident-finance dashboard.** The sponsor gets
   aggregate adoption and outcome evidence, not access to named financial
   records.

The first three are implemented product behavior. The last two are unvalidated
distribution and business hypotheses. The full assessment, including what is
standard and what remains incomplete, is in
[the innovation thesis](INNOVATION.md).

## Pilot and business options: hypotheses only

The [pilot proposal](PILOT-PROPOSAL.md) controls the pilot protocol. The
[go-to-market plan](GO-TO-MARKET.md) controls qualification and kill criteria.

| Option | Proposed exchange | Evidence required before treating it as viable |
| --- | --- | --- |
| Evidence pilot | A first cohort may be free only if the partner supplies a named cohort, launch date, access to at least ten complete rooms, and written outcome confirmation. | A dated pilot commitment, completed launch gates, preregistered measures, and usable aggregate data |
| Facilitated cohort | Test ₹25,000-₹75,000 per 100-resident cohort for onboarding, reminders, and an aggregate report. | A partner actually pays or signs a dated commitment; the range is not current pricing |
| Annual active-resident model | Test ₹30-₹100 per activated resident per year. | Retained use, partner renewal intent, support-cost data, and a paid commitment |
| Residence-software module | Explore an integration or resident-expense module after a live pilot. | A platform partner asks for it, integration scope is defined, and build/support economics are credible |

There is no evidence yet for direct-to-consumer acquisition economics,
institutional sales-cycle length, gross margin, renewal, expansion, or
integration revenue.

## Proposed pilot decision rule

The current four-week proposal is 30-60 adults across at least ten complete
rooms, with a short onboarding session, a weekly partner reminder, baseline and
endline questions, and aggregate reporting.

All thresholds are hypotheses:

| Measure | Proposed threshold |
| --- | ---: |
| Invitees joining within 48 hours | 60% |
| Targeted rooms with complete-room activation | 50% |
| Activated users returning in week two | 35% |
| Active-room usage | Median of at least 6 expenses |
| Outcome | 25% faster reimbursement or 20% clearer money/roommate transparency |

Commercial validation additionally requires a partner to pay at least ₹10,000
or sign a dated commitment of at least ₹30 per activated resident. The
institutional wedge should be stopped if ten qualified buyer conversations
produce no dated pilot, or if a live cohort misses two of activation, retention,
value, and payment thresholds. Failure should narrow or end the thesis, not
automatically trigger more features.

No resident may be enrolled and no live data may be collected until every
external gate in [production readiness](PRODUCTION-READINESS.md) is complete.

## Risks and disconfirming evidence

| Risk | What would disconfirm or reduce it |
| --- | --- |
| The problem is occasional, not painful | Dated interviews showing recent reimbursement or money-clarity problems with concrete examples |
| Complete-room activation still fails | Room-level funnel data from a sponsored cohort |
| Residents prefer separate tools | Task evidence and retained use showing the unified view is understood and revisited |
| A partner will not pay | A paid pilot or dated budget commitment, not verbal interest |
| The product is easy to copy | Repeatable partner access, faster cohort launch, trusted outcome evidence, and integration know-how |
| Manual recipient confirmation is too much friction | Completion time, abandonment, disputes, and resident interviews |
| OCR errors erode trust | Correction rate, failed-scan rate, and qualitative error severity |
| Privacy concerns block adoption | Consent comprehension, opt-out reasons, partner acceptance of aggregate-only reporting, and zero unauthorized disclosure |
| Current architecture reaches its ceiling | Measured lock wait, write latency, OCR queue depth, state size, and restore time |
| Operational readiness is mistaken for launch readiness | Completion of the named host, legal, monitoring, restore, signing, and final-device gates |

The supported release topology is one Node process with embedded SQLite and
server-side OCR, capped at 30 active pilot accounts. It is not a tested
10,000-user or high-availability design.

## Evidence-led roadmap

### 1. Close external gates

Supply a controlled product name and domain, legal/operator identity, privacy
and support contacts, production infrastructure, monitoring, backup/restore
ownership, Android signing, store identities, and final hosted-device evidence.

### 2. Validate the problem and buyer

Run the interview and buyer qualification plan already defined in
[GO-TO-MARKET.md](GO-TO-MARKET.md). Record de-identified evidence and reject
leading, hypothetical-only answers.

### 3. Preregister one controlled pilot

Fix cohort, dates, consent, measures, thresholds, privacy boundary, support
owner, and stop conditions before enrollment. Use complete rooms, not a loose
pool of individual sign-ups.

### 4. Run, report, and decide

Publish invited, joined, activated, retained, and settlement-confirmed counts
with denominators and attrition. Report failures and limitations. Continue only
if the activation, value, and commercial evidence support the wedge.

### 5. Build only validated leverage

Candidate post-pilot work includes durable receipt-to-shared provenance,
all-lines atomic save, a human-reviewed pilot language, normalized reporting
tables, and requested partner integrations. These are not automatically on the
roadmap; each needs evidence from the preceding stage.

## Ask templates

### Residence partner

> Would the person responsible for student or resident experience review a
> four-week pilot for 30-60 adults across at least ten complete rooms? We would
> agree the cohort, privacy boundary, outcome measures, and stop conditions in
> advance. Your team would receive aggregate adoption and outcome reporting,
> not named resident finances.

### Advisor or evaluator

> Please challenge three assumptions: that residents value one personal-plus-
> shared cost view, that complete-room onboarding changes activation, and that
> recipient confirmation creates more trust than friction. I am looking for a
> falsifiable critique and the smallest evidence needed to change the plan.

### Research or impact collaborator

> Would you review the proposed measures, denominators, attrition reporting, and
> privacy design before a cohort is enrolled? The goal is a preregistered,
> publishable result that includes null and negative findings.

### Funder

No financing ask is currently supplied. Use this template only after the
missing facts are approved and documented:

> MoneyMinder is raising **[amount]** via **[instrument]** to achieve
> **[specific validated milestones]** over **[runway]**. Planned use is
> **[product/security]**, **[pilot delivery]**, **[distribution]**, and
> **[operations]**, with amounts and owners for each. Current evidence is
> **[verified traction/revenue/pilot results]**; the principal remaining risks
> are **[named risks]**.

Do not replace the brackets with estimates presented as facts. A financing ask
requires an approved team, entity, cap table, budget, milestone plan, and
evidence packet.

## Diligence links

- [Product guide](product/PRODUCT-GUIDE.md)
- [Innovation thesis](INNOVATION.md)
- [Pilot proposal](PILOT-PROPOSAL.md)
- [Go-to-market and competitive plan](GO-TO-MARKET.md)
- [Production readiness](PRODUCTION-READINESS.md)
- [Pitch-readiness test record](testing/pitch-ready.tdd.md)
- [Privacy notice](../public/privacy.html)
