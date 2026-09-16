import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('0001 through 0006 upgrades the Task-1 users/answers schema to every runtime newsletter table and column', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE answers (id INTEGER PRIMARY KEY, user_id INTEGER);`);
    for (const path of ['../../migrations/0001_newsletter_baseline.sql', '../../migrations/0002_newsletter_delivery_outbox.sql', '../../migrations/0003_newsletter_retry_source.sql', '../../migrations/0004_newsletter_webhook_events.sql', '../../migrations/0005_newsletter_provider_operations.sql', '../../migrations/0006_newsletter_provider_operation_outcome.sql']) await db.exec((await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^--.*$/gm, '').replace(/\n/g, ' '));
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    for (const name of ['newsletter_subscribers', 'newsletter_confirmation_challenges', 'newsletter_confirmation_delivery_state', 'newsletters', 'newsletter_sends', 'newsletter_deliveries', 'newsletter_rate_limits', 'newsletter_webhook_events', 'newsletter_provider_operations']) assert.ok(tables.results.some((row) => row.name === name));
    const deliveries = await db.prepare('PRAGMA table_info(newsletter_deliveries)').all();
    const sends = await db.prepare('PRAGMA table_info(newsletter_sends)').all();
    for (const name of ['queued_at', 'queue_claim_key', 'queue_claimed_at', 'delivery_certainty']) assert.ok(deliveries.results.some((row) => row.name === name));
    assert.ok(sends.results.some((row) => row.name === 'source_send_id'));
    const operations = await db.prepare('PRAGMA table_info(newsletter_provider_operations)').all();
    for (const name of ['outcome', 'settled_at']) assert.ok(operations.results.some((row) => row.name === name));
    const indexes = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_newsletter_deliveries_queue_claim'").all();
    assert.equal(indexes.results.length, 1);
  } finally { await mf.dispose(); }
});

test('versioned provider outcome migration makes known rejections terminal', async () => {
  const sql = await readFile(new URL('../../migrations/0006_newsletter_provider_operation_outcome.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN outcome/);
  assert.match(sql, /ADD COLUMN settled_at/);
  assert.match(sql, /WHERE status = 'accepted'/);
});

test('0006 backfills accepted provider operations while leaving unresolved created operations pending', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    await db.exec("CREATE TABLE newsletter_provider_operations (operation_key TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, accepted_at TEXT); INSERT INTO newsletter_provider_operations VALUES ('accepted', 'accepted', '2026-01-01', '2026-01-02'), ('unresolved', 'created', '2026-01-01', NULL);");
    const sql = await readFile(new URL('../../migrations/0006_newsletter_provider_operation_outcome.sql', import.meta.url), 'utf8');
    await db.exec(sql.replace(/^--.*$/gm, '').replace(/\n/g, ' '));
    const rows = await db.prepare('SELECT operation_key, outcome, settled_at FROM newsletter_provider_operations ORDER BY operation_key').all();
    assert.deepEqual(rows.results, [
      { operation_key: 'accepted', outcome: 'accepted', settled_at: '2026-01-02' },
      { operation_key: 'unresolved', outcome: 'pending', settled_at: null },
    ]);
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

test('versioned provider-operation migration preserves frozen provider work and certainty for existing databases', async () => {
  const sql = await readFile(new URL('../../migrations/0005_newsletter_provider_operations.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE newsletter_deliveries ADD COLUMN delivery_certainty/);
  assert.match(sql, /CREATE TABLE newsletter_provider_operations/);
  assert.match(sql, /request_body\s+TEXT\s+NOT NULL/);
  assert.match(sql, /provider_key\s+TEXT\s+NOT NULL/);
});
