import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('0001 through 0004 upgrades the Task-1 users/answers schema to every runtime newsletter table and column', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE answers (id INTEGER PRIMARY KEY, user_id INTEGER);`);
    for (const path of ['../../migrations/0001_newsletter_baseline.sql', '../../migrations/0002_newsletter_delivery_outbox.sql', '../../migrations/0003_newsletter_retry_source.sql', '../../migrations/0004_newsletter_webhook_events.sql']) await db.exec((await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^--.*$/gm, '').replace(/\n/g, ' '));
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    for (const name of ['newsletter_subscribers', 'newsletter_confirmation_challenges', 'newsletter_confirmation_delivery_state', 'newsletters', 'newsletter_sends', 'newsletter_deliveries', 'newsletter_rate_limits', 'newsletter_webhook_events']) assert.ok(tables.results.some((row) => row.name === name));
    const deliveries = await db.prepare('PRAGMA table_info(newsletter_deliveries)').all();
    const sends = await db.prepare('PRAGMA table_info(newsletter_sends)').all();
    for (const name of ['queued_at', 'queue_claim_key', 'queue_claimed_at']) assert.ok(deliveries.results.some((row) => row.name === name));
    assert.ok(sends.results.some((row) => row.name === 'source_send_id'));
  } finally { await mf.dispose(); }
});

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
