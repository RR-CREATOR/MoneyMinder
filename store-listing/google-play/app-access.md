# Google Play app-access instructions

MoneyMinder is an invite-only controlled pilot for adults and requires a server
account. Registration is intentionally closed in production, so provide a
reusable review account.

## Play Console fields

- All or some functionality restricted: `Yes`
- Restriction: `Username and password`
- Account name: `MoneyMinder review account`
- Username: `<review-username>`
- Password: `<review-password>`
- Additional authentication: `None`

## Reviewer instructions

1. Launch the app while connected to the internet.
2. Sign in with the reusable credentials above.
3. The account already contains representative personal receipts, one
   household, one recurring bill, and one outstanding balance.
4. Open Budget to review personal and shared spending.
5. Open Roommates to review the shared ledger.
6. Open Profile to verify data export, the privacy-policy link, and the
   account-deletion path. Do not complete deletion because the same account is
   reused by reviewers.
7. Receipt-image selection is optional. Canceling Android's system picker does
   not block the rest of the app; the wrapper requests no camera or broad media
   permission.

The production backend and review account must remain available throughout
review, regardless of reviewer location, and must not require OTP, IP allowlists,
or expiring credentials.
