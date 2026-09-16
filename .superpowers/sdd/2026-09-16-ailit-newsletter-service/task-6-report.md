# Task 6 — Queue and deliver idempotent bulk sends

## Status

Implemented and locally verified. No queue, remote D1, Resend request, deployment, push, or subagent was used.

## Files

- `schema.sql` — adds the nullable `queued_at` marker used to resume only work not already accepted by the queue.
- `wrangler.toml` — binds the Pages producer to `ailit-newsletter-send`.
- `worker/wrangler.toml` — configures the queue consumer, D1 binding, retry limit, DLQ, compatibility date, and `nodejs_compat`.
- `functions/api/admin/newsletters/[id]/send.js` — validates bounded idempotency keys, atomically freezes a valid draft, snapshots active recipients, and queues only unqueued pending deliveries.
- `functions/api/admin/newsletters/[id]/retry.js` — creates idempotent failed-only retries for currently active subscribers.
- `worker/src/newsletter-worker.js` — safely processes queue messages, renders recipient-specific unsubscribe URLs, calls Resend Batch without tracking, records outcomes, and recomputes send state.
- `tests/newsletter/send.test.js` and `tests/newsletter/worker.test.js` — producer/consumer behavior coverage.

## RED / GREEN

- RED: focused tests first failed because the producer and Worker modules did not exist; the invalid-frozen-content test also failed before that behavior was implemented.
- GREEN: `node --test tests/newsletter/send.test.js tests/newsletter/worker.test.js` (11 passing); `npm test` (59 passing); `npm run build` (passing); `git diff --check` (clean).

## Local config validation

`npx wrangler deploy --dry-run --config worker/wrangler.toml` completed its local Worker configuration/bundle validation. The command could not write its optional user-preferences debug log in the sandbox. Pages’ `wrangler pages deploy` has no `--dry-run` option, so it was not run as a deployment.

## Concern

An existing deployed D1 database will need the corresponding additive `queued_at` column migration before this code is deployed. No remote D1 operation was performed here.
