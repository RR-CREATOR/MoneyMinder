# Google Play listing

## Main listing

- App name: `MoneyMinder`
- Default language: `English (India) – en-IN`
- App or game: `App`
- Category: `Finance`
- Ads: current disabled deployment `No`; enabled sponsored-offer deployment
  `Yes` and must display Play's `Contains ads` label
- Target audience: `18 and over`

Short description (57/80 characters):

> Track receipts, budgets and shared bills with roommates.

Full description:

> MoneyMinder brings personal budgeting and shared household costs into one
> clear view.
>
> Access in this release is limited to invited adult pilot participants.
> Registration is not open to the public.
>
> See your real monthly cost of living, including your share of roommate
> expenses. Choose an existing receipt image, review the extracted details, and
> save it to your budget. Split groceries, rent, utilities, and other bills
> across household members without losing track of who owes whom.
>
> Features:
>
> • Personal monthly budget and category breakdowns
> • JPEG and PNG receipt-image review with server-side OCR
> • Shared household expenses and recurring bills
> • Exact, paise-safe split calculations
> • Recipient-confirmed settlement records
> • UPI payment handoff to an installed payment app
> • WhatsApp sharing only when you choose it
> • Data export and in-app account deletion
> • No third-party advertising or analytics SDK
>
> If merchant offers are enabled, MoneyMinder may show one clearly labelled,
> dismissible Sponsored offer on the dashboard. Offers are non-personalized and
> are never selected using receipts, purchases, budgets, balances, debts,
> household data, UPI IDs, receipt images, or browsing data. MoneyMinder uses no
> third-party advertising or analytics SDK.
>
> MoneyMinder does not hold funds, request a UPI PIN, or complete payments.
> Payment takes place in the UPI app you select. Receipt images and financial
> records are handled by the MoneyMinder service described in the privacy
> policy.

## Sponsored-offer submission gate

The code supports server-controlled merchant offers but keeps them disabled by
default with `PROMOTIONS_ENABLED=false`. A source capability is not evidence
that the submitted deployment contains active ads.

Because the operator can activate an offer without publishing a new binary,
never enable it while the Play Console answer remains `No`. Before activation:

1. set the Play Console Ads answer to `Yes` and confirm the **Contains ads**
   label;
2. submit the disclosure above and reconcile the Data safety form, content
   rating, privacy policy, and reviewer notes;
3. wait for the applicable review/approval before changing the server flag; and
4. verify the offer is non-personalized, clearly labelled **Sponsored**,
   dismissible, age-appropriate, and does not interrupt core functionality.
5. verify the merchant's identity/control and manually review the exact public
   HTTPS destination, redirects, content, and schedule; no user or HTTP admin
   route may create a campaign.

See Google's official [Ads policy](https://support.google.com/googleplay/android-developer/answer/9857753),
[app-review guidance](https://support.google.com/googleplay/android-developer/answer/9859455),
and [behavior-transparency requirements](https://support.google.com/googleplay/android-developer/answer/13323374).

## URLs

- Privacy policy: `https://<production-host>/privacy.html`
- Account deletion: `https://<production-host>/delete-account.html`
- Website: `https://<production-host>/`
- Support email: `<public-support-email>`

## Release notes

> Initial release: personal budgets, receipt-image OCR, shared household
> expenses, recurring bills, and recipient-confirmed settle-up records.

## Asset captions

1. `phone-dashboard-1080x1920.jpg` — Your personal and shared spending in one view.
2. `phone-scan-1080x1920.jpg` — Review detected receipt lines before saving.
