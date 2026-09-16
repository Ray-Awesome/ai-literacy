# Newsletter operations guide

This runbook is for the AILIT newsletter service. It documents an execution
plan; it does **not** authorize or perform Cloudflare, Resend, GitHub, or email
changes. Queue creation, secret entry, remote D1 migration, deployment, real
email, and Git push each require a separately approved change window.

## Service map

Cloudflare Pages hosts the static site and Pages Functions. The Functions
handle subscription, confirmation, re-confirmation, unsubscribe, administrator
endpoints, and the Resend webhook. D1 holds subscriber, campaign, delivery,
idempotency, challenge, rate-limit, and webhook state. The Pages queue producer
places frozen recipient batches (maximum 100) on `ailit-newsletter-send`.

The standalone `ailit-newsletter-delivery` Worker consumes that queue, sends
through Resend Batch API, and writes result state to the same D1 database. It
retries queue failures up to three times. The queue's dead-letter queue is
`ailit-newsletter-dead-letter`; its configured consumer records exhausted work
as failed rather than silently losing it.

The public webhook is:

```
https://ailiteracy.or.kr/api/newsletter/webhook
```

Configure that exact HTTPS endpoint in Resend and subscribe it at least to
`email.bounced` and `email.complained`. The endpoint checks Svix headers,
rejects stale signatures, de-duplicates `svix-id` values in D1, and changes a
permanent bounce to `bounced` and a complaint to `complained`. Those statuses
are excluded from later sends.

## Environment inventory

Keep secrets in Cloudflare secret storage only. Never place any of the values
below in static files, `dist/`, source control, browser code, issue trackers,
or logs.

| Runtime | Secrets | Non-secret variables |
| --- | --- | --- |
| Pages / Pages Functions | `SESSION_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | `ADMIN_EMAIL`, `NEWSLETTER_FROM`, `PUBLIC_SITE_URL=https://ailiteracy.or.kr` |
| Delivery Worker | `SESSION_SECRET`, `RESEND_API_KEY` | `NEWSLETTER_FROM`, `PUBLIC_SITE_URL=https://ailiteracy.or.kr` |

`SESSION_SECRET` must be the same high-entropy value in Pages and Worker so
action-token signatures remain valid. `RESEND_WEBHOOK_SECRET` belongs only to
Pages because the webhook is a Pages Function. `ADMIN_EMAIL` is only consumed
by the existing Pages signup/admin flow. `NEWSLETTER_FROM` must be an address
on the verified Resend sending domain; a dedicated newsletter subdomain is the
recommended reputation boundary. `PUBLIC_SITE_URL` must be the exact public
HTTPS origin, with no trailing slash.

Set non-secret Pages variables in the Pages project's production environment.
Before deploying the Worker, place its two non-secret variables in the
`[vars]` section of `worker/wrangler.toml` (or the equivalent Worker dashboard
variables); do not substitute secret values there.

The following are **commands for a separately approved production change**.
They were intentionally not executed as part of this repository work:

```bash
npx wrangler queues create ailit-newsletter-send
npx wrangler queues create ailit-newsletter-dead-letter
npx wrangler pages secret put SESSION_SECRET
npx wrangler pages secret put RESEND_API_KEY
npx wrangler pages secret put RESEND_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY --config worker/wrangler.toml
npx wrangler secret put SESSION_SECRET --config worker/wrangler.toml
```

## Resend provider setup

1. Add and verify the newsletter sending domain in Resend before any real
   email. Publish every DNS record Resend supplies and wait for verified status.
2. Select that verified address as `NEWSLETTER_FROM`; do not use an unverified
   sender for tests or production.
3. In the Resend domain settings, disable **Open tracking** and **Click
   tracking** at the domain level. This service must not add a tracking pixel
   or rewrite links.
4. Create the signed webhook above, copy its `whsec_...` signing secret only
   into Pages `RESEND_WEBHOOK_SECRET`, and send a provider test event only in
   an authorized provider test window.

## D1 bootstrap and migration discipline

The checked-in `schema.sql` is the current snapshot for a **fresh** database.
It includes the delivery outbox fields, retry source, webhook-events table,
provider-operation records, confirmation challenge tables, confirmation
delivery state, and rate limits.
For a fresh local database, run:

```bash
npm run db:init:local
```

For a fresh production database, an authorized operator may apply `schema.sql`
once using the remote D1 target, then verify its table list. Do not subsequently
apply migrations `0002` through `0006` to that fresh snapshot, because their
schema changes are already included.

For the real pre-newsletter AILIT database, first prove the precondition: its
only application tables are `users` and `answers` (no `newsletter_%` table).
Take an export/backup, record its location and checksum, then apply migrations
**once** and in this exact order:

```bash
npx wrangler d1 execute ailit-db --remote --file=migrations/0001_newsletter_baseline.sql
npx wrangler d1 execute ailit-db --remote --file=migrations/0002_newsletter_delivery_outbox.sql
npx wrangler d1 execute ailit-db --remote --file=migrations/0003_newsletter_retry_source.sql
npx wrangler d1 execute ailit-db --remote --file=migrations/0004_newsletter_webhook_events.sql
npx wrangler d1 execute ailit-db --remote --file=migrations/0005_newsletter_provider_operations.sql
npx wrangler d1 execute ailit-db --remote --file=migrations/0006_newsletter_provider_operation_outcome.sql
```

`0001` creates the complete pre-outbox newsletter baseline; it intentionally
does not create the delivery queue columns added by `0002`, the retry source
added by `0003`, webhook events added by `0004`, provider-operation and
delivery-certainty fields added by `0005`, or terminal-operation outcome fields
added by `0006`. `0002`, `0003`, `0005`, and `0006` use
non-repeatable `ALTER TABLE`: never reapply them. A partially migrated database
is a stop condition—compare `PRAGMA table_info(newsletter_deliveries)`,
`PRAGMA table_info(newsletter_sends)`, and the provider-operation table with
the migration ledger and obtain a recovery plan rather than guessing. These are
remote mutations and are intentionally not part of local verification.
Record the change ticket, database backup/export location, timestamp, operator,
and each command's output. Do not use `db:init:remote` against an existing
production database: it is a bootstrap convenience, not a migration ledger.

After either path, confirm that the newsletter tables include all of:

```
newsletter_subscribers
newsletter_confirmation_challenges
newsletter_confirmation_delivery_state
newsletters
newsletter_sends
newsletter_deliveries
newsletter_rate_limits
newsletter_webhook_events
newsletter_provider_operations
```

The first six include the core subscriber, confirmation, content, send, and
delivery model; the last two are required operational controls and must not be
omitted from schema verification.

## Deployment sequence (authorized change only)

1. Confirm Resend domain verification and disabled domain-level open/click
   tracking.
2. Back up D1 and choose either the fresh-bootstrap or ordered-existing-DB path
   above.
3. Create both queues, configure Pages/Worker bindings and variables, and set
   the listed secrets through protected prompts.
4. Verify the Pages producer binding and Worker consumer/D1 binding using a
   dry run, then deploy Pages and Worker in the approved window.
5. Configure the Resend webhook and verify a signed non-production event.
6. Conduct a separately authorized canary/test send before an audience send.

The typical deploy commands are `npm run deploy` for Pages and
`npx wrangler deploy --config worker/wrangler.toml` for the Worker. Neither was
run by the local verification procedure.

## Monitoring, idempotency, retry, and DLQ response

Monitor Cloudflare Pages/Worker error logs, queue backlog and retry counts,
D1 errors, Resend API failures, webhook 4xx/5xx, and per-send counts in
`newsletter_sends`. A send should reconcile as:

| Expected state | Interpretation and response |
| --- | --- |
| `completed` | Every delivery was marked `sent`. Retain the send record. |
| `partial` | Some deliveries failed; use the editor's failed-recipient retry action only when `retryableFailureCount` is nonzero and the cause is understood. |
| `failed` | No eligible delivery succeeded or queueing failed; inspect errors, bindings, and provider state before retrying. A nonzero `indeterminateCount` requires provider reconciliation, not normal retry. |
| `sending` / `queued` for more than 15 minutes | Page the on-call editor and investigate queue backlog, Worker deployment/logs, D1 connectivity, and claimed/queued rows. |

The initial-send and retry routes require an `Idempotency-Key`; reuse the same
key only to resume the same request, never for another newsletter. Recipient
rows are unique by `(send_id, subscriber_id)`, and a retry clones only known
failed, still-active recipients that are not already pending or sent by another
send in the same newsletter lineage. Indeterminate deliveries are never normal
failed-recipient retry candidates. Queue claim keys identify a durable provider
operation: its ordered delivery IDs, exact Resend Batch request bytes, and
provider idempotency key are persisted before first submission. Queue
redelivery reuses those bytes and key, so a mutable configuration or subscriber
change cannot create a second physical message.

The editor/API also enforce a conservative UTF-8 block-document byte limit.
This is a delivery-storage limit, not an invitation to split arbitrary large
content: it ensures a valid 100-recipient claim can be frozen in one D1 value.
An oversized draft is rejected before it can lock the newsletter; reduce the
copy or split it into separate newsletters.

If `ailit-newsletter-dead-letter` receives a message, preserve the message
metadata and correlate `sendId`/delivery IDs with D1. If no provider operation
exists, its consumer marks still-pending deliveries `failed` with
`queue_retries_exhausted`. If an operation exists, it marks them
`indeterminate`, retains the original operation/key, and recomputes the send;
this is not safely retryable. Do not manually replay a DLQ message or use
failed-recipient retry for an indeterminate delivery. Use the authorized
[provider reconciliation runbook](newsletter-provider-reconciliation.md): query
Resend with the stored key, then record proven delivery or proven non-delivery
before creating any new provider key.

The on-call owner is the designated **newsletter editor**; the technical owner
is the Cloudflare service maintainer. At least every 15 minutes during an active
send, alert if a send is still `queued`/`sending`, queue backlog is nonzero for
15 minutes, DLQ has any message, or Pages/Worker webhook or queue errors exceed
0 in five minutes. Use the Cloudflare queue dashboard and Worker/Pages logs,
then run this read-only D1 reconciliation query:

```sql
SELECT s.id, s.status, s.started_at, s.target_count, s.success_count, s.failure_count,
       SUM(d.status = 'pending') AS pending, SUM(d.status = 'failed') AS failed
FROM newsletter_sends s LEFT JOIN newsletter_deliveries d ON d.send_id = s.id
WHERE s.status IN ('queued', 'sending', 'partial', 'failed')
GROUP BY s.id ORDER BY s.started_at;
```

For an alert, pause new sends, preserve logs/message metadata, identify the
binding/provider cause, and only then use the failed-recipient retry action.

## Local smoke tests and build verification

Use a local `.dev.vars` with no `RESEND_API_KEY` (or an invalid dummy value).
This makes the confirmation delivery path fail before provider delivery while
the public endpoint returns its deliberately non-enumerating response. It
prevents a local smoke test from sending mail.

```bash
npm test
npm run build
npm run db:init:local
npx wrangler d1 execute ailit-db --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
npx wrangler deploy --config worker/wrangler.toml --dry-run
npm run dev

curl -i http://localhost:8788/newsletter
curl -i -X POST http://localhost:8788/api/newsletter/subscribe \
  -H 'Content-Type: application/json' \
  --data '{"email":"delivered@resend.dev","consent":true,"company":""}'
curl -i http://localhost:8788/api/admin/newsletters
```

Expected local results: `/newsletter` returns `200`; the subscription
returns `202` and the generic Korean confirmation-notice copy (not account
existence); the unauthenticated administrator call returns `401`. Stop the
local dev server after the checks. `dist/` must contain only generated public
assets and must not contain `.dev.vars`, API/webhook keys, raw confirmation
tokens, or the smoke-test address.

## Rollback and recovery

Do not roll back a database migration by running destructive SQL in production.
If a deployment is unhealthy, first stop new sends by removing the Pages
producer binding or rolling back Pages/Worker to the known-good artifact in an
authorized window. Preserve D1, queue, Resend, and logs for incident analysis.

Before resuming, reconcile each active `newsletter_sends` record from its
delivery rows. Re-deploy a corrected Worker, let its D1 bindings process queued
work, and use the failed-recipient retry flow only after counts and
idempotency/source-send links have been inspected. If migration recovery is
needed, restore the approved D1 backup to a controlled environment and obtain a
separate data-recovery decision; do not guess or edit recipient status in bulk.

## Privacy and retention

The newsletter collects an email address and its consent/status timestamps.
Confirmation token values are not stored raw; challenge hashes expire after 24
hours. Unsubscribe changes the subscriber to `unsubscribed` rather than
physically deleting it, preserving the minimal record needed to prevent future
mail. Permanent bounces and complaints remain suppressed. Access to subscriber,
delivery, and webhook data is limited to authorized administrators.

Purge confirmation challenges and confirmation-delivery state after 30 days;
purge delivery error details and webhook event payload metadata after 90 days;
purge settled accepted or definitively rejected provider-operation payloads after 30 days, but retain an
operation with pending or indeterminate delivery evidence until authorized
provider reconciliation resolves it. Provider-operation rows contain rendered
mail and recipient addresses and are server-only: never export them to browser
responses or logs. Retain the original operation/key while reconciliation is
pending; only provider evidence of non-delivery permits a new provider key.
retain immutable newsletter content, send aggregates, recipient-target history,
and provider delivery IDs for 24 months after a terminal send. After 24 months,
purge terminal send/delivery rows and an old sent/failed newsletter with no
remaining sends; drafts remain under editorial control. Retain `unsubscribed`,
`bounced`, and `complained` subscriber email/status records indefinitely as the
minimal anti-resend suppression record, unless a superseding legal deletion
request requires an approved exception process. Run the ordered,
writer-paused, backup-first, ordered sequence in
[`newsletter-retention.sql`](newsletter-retention.sql) only in an approved
maintenance window after privacy-owner sign-off. D1 does not support SQL
`BEGIN`/`COMMIT` here: run the exact file with `wrangler d1 execute --file`,
wait for success, and keep newsletter writers paused for the whole command.
Each statement is idempotent and safe to rerun. If a statement fails, keep
writers paused, investigate from the backup and D1 output, correct the cause,
then rerun the entire file; it deletes old delivery targets, severs a newer
retry's `source_send_id` to an expiring source, then deletes old terminal sends
and unreferenced content. Old `sent` content ages by `sent_at`; old `failed`
content ages by `updated_at`. It never deletes suppression subscriber rows.

```bash
npx wrangler d1 execute ailit-db --local --file=docs/newsletter-retention.sql
# Production: use --remote only in the separately approved maintenance window.
```

Production retention enablement is blocked until the privacy-policy owner
approves these durations and the maintenance procedure. Restrict exports and
securely delete any derived files when their retention ends.
The service must never enable open or click tracking.
