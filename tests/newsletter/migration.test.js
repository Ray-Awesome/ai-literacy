import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('versioned delivery outbox migration adds every runtime queue column for existing databases', async () => {
  const sql = await readFile(new URL('../../migrations/0002_newsletter_delivery_outbox.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE newsletter_deliveries ADD COLUMN queued_at TEXT/);
  assert.match(sql, /ALTER TABLE newsletter_deliveries ADD COLUMN queue_claim_key TEXT/);
  assert.match(sql, /ALTER TABLE newsletter_deliveries ADD COLUMN queue_claimed_at TEXT/);
});

test('versioned retry migration binds a replay key to its source send', async () => {
  const sql = await readFile(new URL('../../migrations/0003_newsletter_retry_source.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE newsletter_sends ADD COLUMN source_send_id INTEGER/);
});

test('versioned webhook migration creates the Svix event idempotency table for existing databases', async () => {
  const sql = await readFile(new URL('../../migrations/0004_newsletter_webhook_events.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS newsletter_webhook_events/);
  assert.match(sql, /svix_id\s+TEXT\s+PRIMARY KEY/);
});
