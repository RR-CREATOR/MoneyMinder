# Pitch-readiness TDD evidence

## User journeys

- As a resident, I need a corrupt datastore to stop safely so my financial records are not replaced by an empty file.
- As a roommate, I need each person counted once in a split.
- As a payee, I need to confirm a claimed UPI payment before balances change.
- As a user, I need to export or delete my personal data.
- As an operator, I need production to reject a missing session secret.
- As a maintainer, I need an isolated datastore for black-box HTTP tests.

## Test specification

| Guarantee | Evidence | Result |
|---|---|---|
| Missing SQLite store initializes; invalid/corrupt state fails closed | `server/db.test.js` | PASS |
| Concurrent mutations serialize without lost updates | `server/db.test.js` | PASS |
| App data and browser sessions survive a process restart | `server/sqlite-integration.test.js` | PASS |
| Pending UPI does not change balances | `server/households.test.js` | PASS |
| Only recipient confirms; duplicate pending request is rejected | `server/households.test.js` | PASS |
| Split members are deduplicated | `server/households.test.js` | PASS |
| Export excludes secrets; deletion anonymizes shared records | `server/auth.test.js` | PASS |
| Production requires `SESSION_SECRET` | `server/auth.test.js` | PASS |
| Registration → household expense → UPI request → recipient confirmation works over HTTP | `server/e2e.test.js` | PASS |

Current validation commands:

```powershell
npm audit --omit=dev --audit-level=low
npm run verify
npm run test:sqlite
```

`npm run verify` enforces at least 80% line, function, and branch coverage.
`npm run test:sqlite` uses a disposable embedded database and requires no
external database service or Docker daemon. Record the exact release-commit
output with the release evidence; browser visual verification remains in
`design-qa.md`.
