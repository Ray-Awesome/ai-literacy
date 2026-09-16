import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('local D1 applies existing-db migrations and selects an exact 100-recipient JSON batch below the parameter ceiling', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(`CREATE TABLE newsletter_deliveries (id INTEGER PRIMARY KEY, send_id INTEGER NOT NULL, subscriber_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending');`);
    const [outbox, retry] = await Promise.all([
      readFile(new URL('../../migrations/0002_newsletter_delivery_outbox.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/0003_newsletter_retry_source.sql', import.meta.url), 'utf8'),
    ]);
    for (const statement of outbox.replace(/^--.*$/gm, '').split(';').map((sql) => sql.trim()).filter((sql) => sql && !sql.startsWith('CREATE INDEX'))) await db.exec(`${statement};`);
    await db.exec('CREATE TABLE newsletter_sends (id INTEGER PRIMARY KEY, newsletter_id INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL);');
    for (const statement of retry.replace(/^--.*$/gm, '').split(';').map((sql) => sql.trim()).filter(Boolean)) await db.exec(`${statement};`);
    await db.batch(Array.from({ length: 100 }, (_, index) => db.prepare('INSERT INTO newsletter_deliveries (id, send_id, subscriber_id, status) VALUES (?, 1, ?, \'pending\')').bind(index + 1, index + 1)));
    const ids = Array.from({ length: 100 }, (_, index) => index + 1);
    const selected = await db.prepare(`SELECT id FROM newsletter_deliveries WHERE send_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY id`).bind(1, JSON.stringify(ids)).all();
    assert.equal(selected.results.length, 100);
  } finally {
    await mf.dispose();
  }
});
