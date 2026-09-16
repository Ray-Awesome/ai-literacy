# AILIT Cloudflare site and newsletter service

This repository contains the static AILIT site, Cloudflare Pages Functions, and
the newsletter delivery Worker. The approved product constraints are in
[`docs/superpowers/specs/2026-09-16-ailit-newsletter-service-design.md`](docs/superpowers/specs/2026-09-16-ailit-newsletter-service-design.md).

## Newsletter architecture

Pages serves the public newsletter pages and Functions. Public Functions create
double-opt-in challenges, verify confirmation and unsubscribe tokens, enforce
rate limits, and accept signed Resend webhooks. Administrator Functions extend
`에이릿 편집실`; they snapshot active recipients in D1, use an idempotency key
to create a send, and enqueue no more than 100 delivery IDs per message.

The `ailit-newsletter-delivery` Worker consumes
`ailit-newsletter-send`, freezes a durable provider operation (ordered delivery
IDs, exact Batch request bytes, and a provider idempotency key) before its
first Resend submission, and updates each delivery and aggregate send state in
the same D1 database. The frozen operation is server-only because it contains
recipient addresses and rendered content. After its retry limit, a message is
delivered to `ailit-newsletter-dead-letter`; an operation that might have been
accepted is marked indeterminate and must be reconciled with authorized
provider evidence before a new send is allowed. Webhook events are
signature-checked, replay-limited, and de-duplicated before permanent bounces
and complaints suppress later delivery.

No browser bundle contains delivery credentials or frozen provider-operation
payloads. The service stores only the email address required for subscription;
confirmation tokens are stored as hashes, and unsubscribe URLs contain signed
tokens rather than raw addresses. Open pixels and click-tracking redirects are
deliberately not used.

## Local development

Install dependencies, initialize the local D1 database, then start Pages:

```bash
npm install
npm run db:init:local
npm run dev
```

For a local subscription smoke check, leave `RESEND_API_KEY` absent (or use an
intentionally invalid dummy value) in `.dev.vars`. The subscription endpoint
still gives its generic `202` response but delivery cannot be scheduled with a
provider. Never put real secrets in `.dev.vars` or commit it.

Run the test suite and static build with:

```bash
npm test
npm run build
```

`dist/` is generated output and is ignored by Git. Deployment, production D1
migration, Queue provisioning, secrets, and real sending are separate external
changes; see [the operations guide](docs/newsletter-operations.md) before
performing any of them.

## Operational handoff

The complete environment inventory, migration order, provider setup, smoke
tests, monitoring, recovery, privacy, and rollback instructions are in
[`docs/newsletter-operations.md`](docs/newsletter-operations.md). In
particular, verify a dedicated Resend sending domain and disable domain-level
open and click tracking before authorizing any real message. Existing D1
databases must follow the ordered migration ledger through
`0006_newsletter_provider_operation_outcome.sql`; see the provider-reconciliation
runbook before handling an indeterminate delivery.
