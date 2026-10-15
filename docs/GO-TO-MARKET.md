# MoneyMinder India partner plan

Date: 12 July 2026

> Outreach and demo review may proceed. No external cohort—paid or unpaid—may
> launch until every live-cohort gate in
> [production readiness](PRODUCTION-READINESS.md) is complete.

## Decision

Do not sell MoneyMinder as “Splitwise for India.” Google Pay, PhonePe, Splitwise, and Pine Labs’ Fave already make shared-expense tracking and UPI settlement familiar. MoneyMinder’s credible wedge is narrower:

> A four-week, institution-sponsored “first month away from home” program for 18+ students sharing rooms: one view of personal spending plus each resident’s share of household costs.

The buyer is a Head of Student Experience, Community/Resident Experience, or Hostel Operations leader. The measurable outcomes are faster reimbursements, more complete roommate activation, and improved money clarity—not downloads.

## Revenue model and sponsored-offer guardrails

The primary commercial test remains an institution-paid facilitated pilot. A
merchant-sponsored dashboard offer is a separate, secondary revenue experiment;
it is not evidence of a launched ad product, partner demand, or revenue. Source
support is disabled by default through `PROMOTIONS_ENABLED=false`.

Any future merchant offer must follow these boundaries:

- show the same non-personalized offer to every eligible signed-in user;
- appear only as a clearly labelled **Sponsored**, dismissible dashboard card;
- never block, interrupt, or change budgeting, receipt, household, or settlement
  functionality;
- never select or price an offer using receipts, merchant history, item text,
  amounts, categories, budgets, balances, debts, settlements, household
  membership, UPI IDs, receipt images, Chrome page content, browsing activity,
  account identifiers, or device identifiers;
- use no third-party advertising SDK, tracking pixel, or advertising network;
- measure only aggregate impressions and clicks, with no user-, household-,
  device-, receipt-, or transaction-level reporting; and
- never sell or share user data with a merchant or sponsor.

Do not sell CPM/CPC performance or targeted placement while those constraints
apply. A first commercial test should use a fixed placement fee with an
aggregate-only report, and should be run separately from the resident-outcome
pilot so it cannot distort the primary activation and reimbursement measures.
Impression and click counts are best-effort, approximate, and unsuitable for
billing. Redemption or conversion must be confirmed by the merchant through a
separate approved process.

Before any offer is enabled, the operator must verify the merchant's identity
and control of the destination, manually review the exact public HTTPS URL and
offer content, update the privacy/store disclosures, reconcile Google Play's
**Contains ads** answer, and complete a new release review. Campaigns are
operator-controlled database records; there is no user-supplied campaign write
or campaign-admin HTTP API.

## Who to contact

These are public candidate organizations, not qualified leads.

| Priority | Organization | Why it fits | Contact route | Ask |
|---|---|---|---|---|
| 1 | Tribe Stays, Pune | A bounded Pune student-residence population and an explicit “B2B Partnerships” contact category | [Tribe contact form](https://tribestays.com/student-hostel/contact-us); select **B2B Partnerships** | One 30–60 resident, four-week pilot at one property |
| 2 | your-space | Its stated mission includes a holistic student community; public leadership and contact details are available | COO Shubha Lal; [info@your-space.in](mailto:info@your-space.in); +91 8383027664; [official page](https://www.your-space.in/about-us/) | One first-year/outstation cohort with an aggregate outcome report |
| 3 | Indira Group / Tribe Wamba, Pune | Institution-linked hostel population makes a controlled cohort easier than a national rollout | Hostel Director or Dean/Director of Student Affairs via the [institution hostel page](https://indiraiimp.edu.in/Hostel) | Ten complete rooms, workshop, and endline report |
| 4 | Roomindo | It already sells hostel/property software with API access, showing a B2B software budget | [support@roomindo.com](mailto:support@roomindo.com), +91 88917 07303, [pricing/contact](https://roomindo.com/pricing) | Explore a resident expense-sharing module only after a live pilot |
| 5 | Stanza Living | Large credibility target with a formal partnership route and college-hostel offering | [Partner With Us](https://www.stanzaliving.com/partner-with-us), [partnership contact](https://www.stanzaliving.com/contact-us), 080 4762 2222 | Approach after one proven pilot, not first |
| 6 | Zolo | Large managed-living platform with community programming and app-based resident experience | [Official site](https://zolostays.com/) and corporate contact routes | Approach after repeatable evidence; it can build internally |

Start with Tribe Stays. Contact your-space in parallel. Do not lead with Stanza or Zolo until a smaller pilot supplies proof.

## First outreach

Subject: Pune student-residence pilot to reduce roommate payment friction

Hello [Name],

I built MoneyMinder for students sharing rooms: it combines personal spending with each student’s share of rent, groceries, utilities, and other household costs, then hands settlement to UPI.

I am proposing a four-week pilot for 30–60 residents at one property. It includes a short onboarding workshop, room-level setup, weekly prompts, and an aggregate outcome report. Your team would not see named purchases, receipt images, household balances, or UPI IDs.

The pilot would test three outcomes fixed in advance: full-room activation, week-two retained use, and change in reimbursement time or money clarity. I can share the working mobile demo and one-page protocol.

Would the person responsible for student/community experience be open to a 20-minute pilot review next week?

## Thirty-day kill test

1. Interview 12 outstation students, five wardens/community managers, and three budget owners.
2. Pass interviews only if at least 8/12 students describe a recent problem, 2/3 budget owners accept a concrete next step, and one organization names a site, date, and 30+ residents.
3. Run a 14-day live cohort across at least ten complete rooms.
4. Validate only if all four occur:
   - 60% of invitees join within 48 hours.
   - 50% of targeted rooms activate at least two members.
   - 35% of activated users return in week two; median active room logs six expenses.
   - A partner pays at least ₹10,000 or signs a dated commitment of at least ₹30 per activated resident.
5. Outcome signal: median outstanding reimbursement age falls 25%, or money-clarity/roommate-transparency score improves 20% from baseline.

Kill the institutional wedge if ten qualified buyer conversations produce no dated pilot, or if the live cohort misses two of activation, retention, value, and payment thresholds. Do not answer failure with more features.

## Competitive reality

- [Splitwise](https://www.splitwise.com/index) already covers groups, recurring expenses, debt simplification, settlement, categories, and paid OCR/itemization/charts.
- [Google Pay India](https://support.google.com/pay/india/answer/11420982?hl=en) and PhonePe reduce adoption friction because users already trust their payment apps.
- Pine Labs’ Fave is a direct India-focused shared-expense/UPI competitor.
- [Roomindo](https://roomindo.com/pricing) charges ₹3,999/month for up to 25 tenants and ₹7,999/month for up to 100, but MoneyMinder does not yet replace its core property operations.

The defensible asset is a measured distribution program and verified outcomes, not feature parity.
