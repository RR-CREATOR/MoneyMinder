# MoneyMinder Android privacy publication

The canonical privacy notice is
[`public/privacy.html`](../public/privacy.html). Deploy it at the same public
HTTPS origin as the app.

- Privacy URL: `https://<production-host>/privacy.html`
- Account deletion URL: `https://<production-host>/delete-account.html`

Before submission, replace the operator note in the hosted notice with the
legal operator name and address, privacy/support/incident contacts, hosting and
database processors, and the final account, log, and backup-retention schedule.

The hosted notice covers account/contact/VPA data, budgets, receipt images,
expenses, recurring bills, settlements, household content, bundled Tesseract
server-side OCR, operational logs, household visibility, user-directed UPI and
WhatsApp sharing, export and deletion, retained shared ledger rows under a
deleted-member identifier, the disabled-by-default non-personalized sponsored
offer capability, no third-party advertising or analytics SDK, and the Chrome
extension's promotion-free local page processing and Limited Use compliance.

Keep `PROMOTIONS_ENABLED=false` for a Play submission unless the operator has
first updated the hosted notice, Play Ads/Data safety/content-rating answers,
listing, and reviewer notes, completed Play review, verified the merchant and
exact public HTTPS destination, and approved finite campaign-metric retention.

Use [`../store-listing/google-play/data-safety.md`](../store-listing/google-play/data-safety.md)
to complete Play Console and reconcile every answer with the deployed
infrastructure before submission.
