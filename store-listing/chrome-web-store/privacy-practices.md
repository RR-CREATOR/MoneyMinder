# Chrome Web Store Privacy-tab answers

## Single purpose

> Track personal and shared spending from the browser by showing the user's
> MoneyMinder budget and household balances, accepting user-confirmed expenses,
> and optionally recognizing completed purchase pages locally for one-tap entry.

## Permission justifications

- `storage`: stores a revocable login token, the opt-in detection setting,
  retry-safe operation keys, and per-tab detected candidates. Persistent
  storage is restricted to trusted extension contexts.
- `scripting`: registers and removes the packaged detection scripts only after
  the user enables or disables optional purchase detection.
- Production `host_permissions`: connects only to the packaged MoneyMinder
  HTTPS server for sign-in, budget/household reads, and user-confirmed
  expense writes.
- Optional `https://*/*`: requested only when the user enables purchase
  detection; required to inspect completed order/receipt pages. Access is
  removed when detection is disabled.

## Remote code

- Uses remote code: `No`
- Explanation: all executable JavaScript is included in the submitted ZIP. The
  extension exchanges JSON data only with the packaged MoneyMinder HTTPS server.
  It does not use eval, remote scripts, WebAssembly downloads, or external CDNs.

## User data categories handled

Select:

- Personally identifiable information
- Authentication information
- Financial and payment information
- Website content
- Web browsing activity
- User-generated content

Handling statement:

> Authentication and financial fields are sent only to the packaged MoneyMinder
> HTTPS server to provide the extension's single purpose. Optional
> page detection processes the current HTTPS URL, host, order/invoice JSON-LD,
> and limited visible receipt text locally. Page text and browsing history are
> not uploaded. A derived amount, merchant, and category are sent only after the
> user presses Track. Data is not sold, used for advertising or credit
> decisions, or transferred to data brokers.

## Promotion boundary

The submitted Chrome extension does not fetch or render sponsored offers and
does not send impression or click events. Its website content, browsing
activity, account identifiers, household data, and financial records are never
used to select or measure advertising. A separately deployed PWA/Android
sponsored-offer capability does not change these Chrome declarations. Re-review
this worksheet and the extension permissions before that boundary changes.

## Certifications

- Data use complies with the Chrome Web Store User Data Policy: `Yes`
- Data use complies with Limited Use requirements: `Yes`
- Privacy policy URL: `https://<production-host>/privacy.html`
