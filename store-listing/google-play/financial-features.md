# Google Play financial features declaration

Complete this form for every testing or production track.

## Recommended selections

- **Money transfer and wire services** — MoneyMinder creates a user-directed
  UPI payment intent for settling a recorded household balance. The external UPI
  app executes the transfer.
- **Other** — MoneyMinder budgets, records expenses, calculates shared balances,
  and helps users manage personal money.

Do not select **My app doesn't provide any financial features**.

## Scope statement

MoneyMinder does not hold funds, operate a wallet, issue credit, provide loans,
sell investments, exchange cryptocurrency, or charge for digital goods. It
does not execute transfers itself. A user explicitly taps **Pay via UPI** and
chooses an installed third-party UPI app; MoneyMinder supplies the payee VPA and
amount derived from the selected household settlement.

Before submission, the publisher must reconcile these selections with the
deployed build and the countries targeted in Play Console. If Play Console or
qualified regional counsel classifies the external UPI handoff as **Mobile
payments and digital wallets**, add that selection; do not remove the transfer
disclosure merely to avoid review.

Official references:

- <https://support.google.com/googleplay/android-developer/answer/13849271>
- <https://support.google.com/googleplay/android-developer/answer/9876821>
