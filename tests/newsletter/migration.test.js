import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('versioned delivery outbox migration adds every runtime queue column for existing databases', async () => {
  const sql = await readFile(new URL('../../migrations/0002_newsletter_delivery_outbox.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE newsletter_deliveries ADD COLUMN queued_at TEXT/);
  assert.match(sql, /ALTER TABLE newsletter_deliveries ADD COLUMN queue_claim_key TEXT/);
  assert.match(sql, /ALTER TABLE newsletter_deliveries ADD COLUMN queue_claimed_at TEXT/);
});
