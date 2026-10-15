# MoneyMinder documentation

This is the canonical documentation index for product, engineering, operations,
store publication, partner communication, and future agent-assisted work.

The running code and automated tests are authoritative when prose and behavior
disagree. Store-policy instructions are dated guidance and must be checked
against the linked official console documentation before each submission.

## Start here

| Reader | First document | Then read |
| --- | --- | --- |
| User, partner, or evaluator | [Product guide](product/PRODUCT-GUIDE.md) | [How it works](product/HOW-IT-WORKS.md) |
| Engineer | [Architecture](engineering/ARCHITECTURE.md) | [Codebase guide](engineering/CODEBASE-GUIDE.md), [API reference](engineering/API-REFERENCE.md) |
| Coding agent | [Agentic handoff](engineering/AGENTIC-HANDOFF.md) | [`AGENTS.md`](../AGENTS.md) or [`CLAUDE.md`](../CLAUDE.md) |
| Backend operator | [Deployment and distribution](release/DEPLOYMENT-AND-DISTRIBUTION.md) | [OCI deployment and paired-recovery package](../deploy/oci/README.md), [production readiness](PRODUCTION-READINESS.md) |
| Google Play publisher | [Google Play upload guide](release/GOOGLE-PLAY-UPLOAD.md) | [Play console copy and assets](../store-listing/google-play/) |
| Chrome publisher | [Chrome Web Store upload guide](release/CHROME-WEB-STORE-UPLOAD.md) | [Chrome console copy and assets](../store-listing/chrome-web-store/) |
| Partner or funder | [Pitch](PITCH.md) | [Innovation thesis](INNOVATION.md), [Pilot proposal](PILOT-PROPOSAL.md) |

## Product and working documentation

- [Product guide](product/PRODUCT-GUIDE.md) — audience, capabilities,
  boundaries, privacy, and support expectations.
- [How MoneyMinder works](product/HOW-IT-WORKS.md) — end-to-end personal,
  household, receipt, extension, and Android workflows.
- [Pitch](PITCH.md) — shareable project narrative without fabricated traction
  or commercial claims.
- [Innovation thesis](INNOVATION.md) — what is differentiated, what is
  conventional, limitations, defensibility, and validation plan.

## Engineering documentation

- [System architecture](engineering/ARCHITECTURE.md)
- [Codebase guide](engineering/CODEBASE-GUIDE.md)
- [HTTP API reference](engineering/API-REFERENCE.md)
- [Agentic coding handoff](engineering/AGENTIC-HANDOFF.md)
- [Interactive architecture CodeTour](../.tours/architect-moneyminder-system.tour)
- [Design QA evidence](../design-qa.md)
- [Build plan](../BUILD-PLAN.md)

## Release and operations

- [Deployment and distribution](release/DEPLOYMENT-AND-DISTRIBUTION.md)
- [OCI Always Free controlled-pilot deployment and paired-recovery package](../deploy/oci/README.md)
- [Google Play upload guide](release/GOOGLE-PLAY-UPLOAD.md)
- [Chrome Web Store upload guide](release/CHROME-WEB-STORE-UPLOAD.md)
- [Production readiness and incident gates](PRODUCTION-READINESS.md)
- [Android implementation notes](../android/README.md)
- [Android release notes](../android/RELEASE.md)
- [Android privacy checklist](../android/PRIVACY.md)
- [Extension implementation and security notes](../extension/README.md)
- [Store upload kit](../store-listing/README.md)

## Partner and evidence materials

- [Go-to-market plan](GO-TO-MARKET.md)
- [Four-week pilot proposal](PILOT-PROPOSAL.md)
- [Stanford impact evidence plan](STANFORD-IMPACT.md)
- [Pitch-readiness test record](testing/pitch-ready.tdd.md)
- [Merchant promotions TDD and verification record](testing/merchant-promotions.tdd.md)

## Documentation maintenance rules

1. Update code, tests, and the relevant canonical document together.
2. Put implemented behavior in product/engineering docs and clearly label
   future behavior as unimplemented.
3. Never place credentials, signing keys, live reviewer passwords, `.env`
   contents, private contact data, or production SQLite files/backups in
   documentation.
4. Recheck Google Play, Chrome Web Store, Android, and Node release requirements
   immediately before publishing.
5. Keep console worksheets under `store-listing/`; keep reusable operational
   procedures under `docs/release/`.
