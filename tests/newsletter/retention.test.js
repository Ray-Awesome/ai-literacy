import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('retention purge removes only terminal history older than 24 months and preserves active and suppression records', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(`CREATE TABLE newsletter_subscribers (id INTEGER PRIMARY KEY, email TEXT, status TEXT); CREATE TABLE newsletters (id INTEGER PRIMARY KEY, status TEXT, sent_at TEXT, updated_at TEXT); CREATE TABLE newsletter_sends (id INTEGER PRIMARY KEY, newsletter_id INTEGER, source_send_id INTEGER, status TEXT, completed_at TEXT); CREATE TABLE newsletter_deliveries (id INTEGER PRIMARY KEY, send_id INTEGER, subscriber_id INTEGER, status TEXT, delivery_certainty TEXT NOT NULL DEFAULT 'known', error_code TEXT, error_message TEXT, updated_at TEXT); CREATE TABLE newsletter_provider_operations (operation_key TEXT PRIMARY KEY, send_id INTEGER NOT NULL REFERENCES newsletter_sends(id), status TEXT NOT NULL, outcome TEXT NOT NULL, expires_at TEXT NOT NULL); CREATE TABLE newsletter_confirmation_challenges (created_at TEXT); CREATE TABLE newsletter_confirmation_delivery_state (updated_at TEXT); CREATE TABLE newsletter_webhook_events (created_at TEXT); INSERT INTO newsletter_subscribers VALUES (1,'suppressed@example.test','unsubscribed'),(2,'active@example.test','active'); INSERT INTO newsletters VALUES (1,'sent',datetime('now','-25 months'),datetime('now','-25 months')),(2,'sent',datetime('now','-1 month'),datetime('now','-1 month')),(3,'failed',NULL,datetime('now','-25 months')),(4,'failed',NULL,datetime('now','-1 month')),(5,'failed',NULL,datetime('now','-25 months')); INSERT INTO newsletter_sends VALUES (1,1,NULL,'completed',datetime('now','-25 months')),(2,2,1,'completed',datetime('now','-1 month')),(3,2,NULL,'sending',NULL),(4,3,NULL,'failed',datetime('now','-25 months')),(5,4,NULL,'failed',datetime('now','-1 month')),(6,5,NULL,'sending',NULL); INSERT INTO newsletter_deliveries VALUES (1,1,1,'failed','known','old','detail',datetime('now','-25 months')),(2,2,2,'sent','known','new','detail',datetime('now')),(3,3,2,'pending','known','pending','detail',datetime('now')),(4,4,1,'failed','indeterminate','old','detail',datetime('now','-25 months')),(5,5,2,'failed','known','recent','detail',datetime('now')),(6,6,2,'pending','known','active','detail',datetime('now')); INSERT INTO newsletter_provider_operations VALUES ('expired-settled',1,'accepted','accepted',datetime('now','-31 days')),('retain-indeterminate',4,'accepted','accepted',datetime('now','-31 days'));`);
    const sql = await readFile(new URL('../../docs/newsletter-retention.sql', import.meta.url), 'utf8');
    await db.exec(sql.replace(/^--.*$/gm, '').replace(/\n/g, ' '));
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM newsletter_deliveries WHERE send_id = 1').first()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM newsletter_provider_operations WHERE operation_key = 'expired-settled'").first()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM newsletter_provider_operations WHERE operation_key = 'retain-indeterminate'").first()).count, 1);
    assert.equal((await db.prepare('SELECT source_send_id FROM newsletter_sends WHERE id = 2').first()).source_send_id, null);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM newsletter_sends WHERE id = 2 OR id = 3').first()).count, 2);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM newsletters WHERE id = 1').first()).count, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM newsletters WHERE id IN (2, 3, 4, 5)').first()).count, 4);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM newsletter_subscribers').first()).count, 2);
    await db.exec(sql.replace(/^--.*$/gm, '').replace(/\n/g, ' '));
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM newsletter_subscribers WHERE status = \'unsubscribed\'').first()).count, 1);
  } finally { await mf.dispose(); }
});
