# Chrome Web Store listing

## Listing fields

- Name: `MoneyMinder`
- Language: `English`
- Category: `Productivity`
- Single purpose: `Track personal and shared spending from the browser`

Summary:

> See your budget and roommate balances, then track confirmed purchases in one tap.

Detailed description:

> MoneyMinder sends your username and password and any user-confirmed expense
> fields only to the packaged MoneyMinder HTTPS server. It stores a revocable
> authentication token in extension-only storage so it can show your budget and
> household data and save expenses you choose to track.
>
> MoneyMinder is the browser companion for your MoneyMinder budgeting account.
> Access in this release is limited to invited adult pilot participants; public
> registration is closed.
>
> Open the toolbar popup to see today's spending pace, category totals, and
> household balances. Add a shared expense without leaving the current tab.
>
> Optional purchase detection can recognize a completed order or receipt on an
> HTTPS page. It processes order data and limited receipt text locally in your
> browser, then shows the amount, merchant, and category for review. Nothing is
> saved automatically. Purchase details are sent to your MoneyMinder server only
> after you press Track.
>
> Chrome's optional HTTPS permission is used only for purchase detection, which
> is off by default. Enabling it requests HTTPS page access for local detection;
> disabling detection unregisters that processing and removes the optional page
> permission without affecting access to the packaged server. MoneyMinder does
> not upload page text or browsing history, show ads, or sell user data.
>
> The Chrome extension never fetches or displays sponsored merchant offers,
> reports promotion events, or uses website content, browsing activity, or
> financial records to select advertising.
>
> A MoneyMinder account on the packaged HTTPS server is required.

## Promotion boundary

This Chrome Web Store item is promotion-free even if the separate MoneyMinder
PWA/Android deployment later enables its server-controlled dashboard offer.
Do not add a promotion endpoint, sponsored UI, promotion telemetry, or
advertising data use to the extension without a new permission/privacy review
and matching Chrome Web Store submission update.

## URLs

- Homepage: `https://<production-host>/`
- Support: `https://<production-host>/support.html`
- Privacy policy: `https://<production-host>/privacy.html`

## Graphic captions

1. `budget-glance-1280x800.jpg` — Budget and household balances from the toolbar.
2. `purchase-detection-1280x800.jpg` — Review a locally detected purchase before saving.

## Reviewer access

- Server: `https://<production-host>`
- Username: `<review-username>`
- Password: `<review-password>`
- Registration: closed; use the reusable account above.
- Purchase detection is optional. Enable it from the popup to see Chrome's HTTPS
  host-permission prompt.
