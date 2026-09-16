import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { onRequestPost } from '../../functions/api/newsletter/webhook.js';

const WEBHOOK_SECRET = `whsec_${Buffer.alloc(32, 11).toString('base64')}`;

async function webhookDatabase() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] }));
  const db = await mf.getD1Database('DB');
  await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE answers (id INTEGER PRIMARY KEY, user_id INTEGER); INSERT INTO users (id) VALUES (1);');
  for (const path of ['../../migrations/0001_newsletter_baseline.sql', '../../migrations/0002_newsletter_delivery_outbox.sql', '../../migrations/0003_newsletter_retry_source.sql', '../../migrations/0004_newsletter_webhook_events.sql']) {
    await db.exec((await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  }
  return { db, dispose: () => mf.dispose() };
}

async function postWebhook(db, { id, type, messageId }) {
  const body = JSON.stringify({
    type,
    created_at: '2026-09-16T00:00:00.000Z',
    data: { email_id: messageId, bounce: { type: 'Permanent' } },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(WEBHOOK_SECRET.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${body}`).digest('base64');
  return onRequestPost({
    request: new Request('https://site.test/api/newsletter/webhook', {
      method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` }, body,
    }),
    env: { DB: db, RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET },
  });
}

async function seedCompletedSend(db, { newsletterId = 1, sendId = 1, recipients, newsletterStatus = 'sent' }) {
  await db.prepare(`INSERT INTO newsletters (id, subject, content_json, status, created_by)
    VALUES (?, 'subject', '[]', ?, 1)`).bind(newsletterId, newsletterStatus).run();
  await db.prepare(`INSERT INTO newsletter_sends
    (id, newsletter_id, idempotency_key, status, target_count, success_count, failure_count, completed_at)
    VALUES (?, ?, ?, 'completed', ?, ?, 0, datetime('now'))`)
    .bind(sendId, newsletterId, `send-${sendId}`, recipients.length, recipients.length).run();
  for (const [index, messageId] of recipients.entries()) {
    const subscriberId = sendId * 100 + index + 1;
    await db.prepare(`INSERT INTO newsletter_subscribers (id, email, status, consent_at)
      VALUES (?, ?, 'active', datetime('now'))`).bind(subscriberId, `reader-${subscriberId}@example.test`).run();
    await db.prepare(`INSERT INTO newsletter_deliveries (send_id, subscriber_id, status, resend_message_id, sent_at)
      VALUES (?, ?, 'sent', ?, datetime('now'))`).bind(sendId, subscriberId, messageId).run();
  }
}

test('local D1 complaint after a completed one-recipient send recomputes every aggregate', async () => {
  const { db, dispose } = await webhookDatabase();
  try {
    await seedCompletedSend(db, { recipients: ['complaint-1'] });
    assert.equal((await postWebhook(db, { id: 'svix-complaint-1', type: 'email.complained', messageId: 'complaint-1' })).status, 200);
    const send = await db.prepare('SELECT target_count, success_count, failure_count, status FROM newsletter_sends WHERE id = 1').first();
    const newsletter = await db.prepare('SELECT status FROM newsletters WHERE id = 1').first();
    assert.deepEqual(send, { target_count: 1, success_count: 0, failure_count: 1, status: 'failed' });
    assert.equal(newsletter.status, 'failed');
  } finally { await dispose(); }
});

test('local D1 permanent bounce makes a completed multi-recipient send partial', async () => {
  const { db, dispose } = await webhookDatabase();
  try {
    await seedCompletedSend(db, { recipients: ['bounce-1', 'bounce-2'] });
    assert.equal((await postWebhook(db, { id: 'svix-bounce-1', type: 'email.bounced', messageId: 'bounce-1' })).status, 200);
    const send = await db.prepare('SELECT target_count, success_count, failure_count, status FROM newsletter_sends WHERE id = 1').first();
    const newsletter = await db.prepare('SELECT status FROM newsletters WHERE id = 1').first();
    assert.deepEqual(send, { target_count: 2, success_count: 1, failure_count: 1, status: 'partial' });
    assert.equal(newsletter.status, 'sent');
  } finally { await dispose(); }
});

test('local D1 concurrent duplicate webhook processing leaves one reconciled event', async () => {
  const { db, dispose } = await webhookDatabase();
  try {
    await seedCompletedSend(db, { recipients: ['duplicate-1'] });
    const responses = await Promise.all([
      postWebhook(db, { id: 'svix-duplicate-1', type: 'email.complained', messageId: 'duplicate-1' }),
      postWebhook(db, { id: 'svix-duplicate-1', type: 'email.complained', messageId: 'duplicate-1' }),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const eventCount = await db.prepare('SELECT COUNT(*) AS count FROM newsletter_webhook_events WHERE svix_id = ?').bind('svix-duplicate-1').first();
    const send = await db.prepare('SELECT success_count, failure_count, status FROM newsletter_sends WHERE id = 1').first();
    assert.equal(eventCount.count, 1);
    assert.deepEqual(send, { success_count: 0, failure_count: 1, status: 'failed' });
  } finally { await dispose(); }
});

test('local D1 older-send suppression cannot overwrite a newer retry newsletter state', async () => {
  const { db, dispose } = await webhookDatabase();
  try {
    await seedCompletedSend(db, { recipients: ['old-send-1'], newsletterStatus: 'sending' });
    await db.prepare(`INSERT INTO newsletter_sends
      (id, newsletter_id, idempotency_key, status, target_count, success_count, failure_count)
      VALUES (2, 1, 'newer-retry', 'sending', 1, 0, 0)`).run();
    assert.equal((await postWebhook(db, { id: 'svix-old-send-1', type: 'email.complained', messageId: 'old-send-1' })).status, 200);
    const oldSend = await db.prepare('SELECT success_count, failure_count, status FROM newsletter_sends WHERE id = 1').first();
    const newsletter = await db.prepare('SELECT status FROM newsletters WHERE id = 1').first();
    assert.deepEqual(oldSend, { success_count: 0, failure_count: 1, status: 'failed' });
    assert.equal(newsletter.status, 'sending');
  } finally { await dispose(); }
});

test('local D1 applies existing-db migrations, persists provider operations, and selects an exact 100-recipient JSON batch below the parameter ceiling', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(`CREATE TABLE newsletter_deliveries (id INTEGER PRIMARY KEY, send_id INTEGER NOT NULL, subscriber_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending');`);
    const [outbox, retry, provider] = await Promise.all([
      readFile(new URL('../../migrations/0002_newsletter_delivery_outbox.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/0003_newsletter_retry_source.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/0005_newsletter_provider_operations.sql', import.meta.url), 'utf8'),
    ]);
    for (const statement of outbox.replace(/^--.*$/gm, '').split(';').map((sql) => sql.trim()).filter((sql) => sql && !sql.startsWith('CREATE INDEX'))) await db.exec(`${statement};`);
    await db.exec('CREATE TABLE newsletter_sends (id INTEGER PRIMARY KEY, newsletter_id INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL);');
    for (const statement of retry.replace(/^--.*$/gm, '').split(';').map((sql) => sql.trim()).filter(Boolean)) await db.exec(`${statement};`);
    for (const statement of provider.replace(/^--.*$/gm, '').split(';').map((sql) => sql.trim()).filter((sql) => sql && !sql.startsWith('CREATE INDEX'))) await db.exec(`${statement.replace(/\s+/g, ' ')};`);
    await db.prepare("INSERT INTO newsletter_sends (id, newsletter_id, idempotency_key, status) VALUES (1, 1, 'd1-integration', 'queued')").run();
    await db.batch(Array.from({ length: 100 }, (_, index) => db.prepare('INSERT INTO newsletter_deliveries (id, send_id, subscriber_id, status) VALUES (?, 1, ?, \'pending\')').bind(index + 1, index + 1)));
    const ids = Array.from({ length: 100 }, (_, index) => index + 1);
    const selected = await db.prepare(`SELECT id FROM newsletter_deliveries WHERE send_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY id`).bind(1, JSON.stringify(ids)).all();
    assert.equal(selected.results.length, 100);
    await db.prepare(`INSERT INTO newsletter_provider_operations
      (operation_key, send_id, delivery_ids_json, request_body, provider_key, expires_at)
      VALUES (?, 1, ?, ?, ?, datetime('now', '+30 days'))`)
      .bind('claim:1:test', JSON.stringify(ids), '[{"to":["recipient@example.test"]}]', 'newsletter-1-claim-test').run();
    const operation = await db.prepare('SELECT delivery_ids_json, request_body, provider_key FROM newsletter_provider_operations WHERE operation_key = ?').bind('claim:1:test').first();
    assert.deepEqual(JSON.parse(operation.delivery_ids_json), ids);
    assert.equal(operation.request_body, '[{"to":["recipient@example.test"]}]');
  } finally {
    await mf.dispose();
  }
});

test('local D1 retry lineage excludes subscribers reserved or sent by a different retry', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE answers (id INTEGER PRIMARY KEY, user_id INTEGER);');
    for (const path of ['../../migrations/0001_newsletter_baseline.sql', '../../migrations/0002_newsletter_delivery_outbox.sql', '../../migrations/0003_newsletter_retry_source.sql', '../../migrations/0004_newsletter_webhook_events.sql', '../../migrations/0005_newsletter_provider_operations.sql']) {
      await db.exec((await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^--.*$/gm, '').replace(/\n/g, ' '));
    }
    await db.exec(`INSERT INTO users (id) VALUES (1);
      INSERT INTO newsletters (id, subject, content_json, created_by) VALUES (7, 'subject', '[]', 1);
      INSERT INTO newsletter_subscribers (id, email, status, consent_at) VALUES (9, 'member@example.test', 'active', datetime('now'));
      INSERT INTO newsletter_sends (id, newsletter_id, idempotency_key, status) VALUES (1, 7, 'source', 'failed'), (2, 7, 'retry-one', 'sending'), (3, 7, 'retry-two', 'queued');
      INSERT INTO newsletter_deliveries (send_id, subscriber_id, status) VALUES (1, 9, 'failed'), (2, 9, 'sent');`);
    const eligible = await db.prepare(`SELECT delivery.subscriber_id FROM newsletter_deliveries AS delivery
      JOIN newsletter_subscribers AS subscriber ON subscriber.id = delivery.subscriber_id
      WHERE delivery.send_id = ? AND delivery.status = 'failed' AND delivery.delivery_certainty = 'known' AND subscriber.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM newsletter_deliveries AS prior JOIN newsletter_sends AS prior_send ON prior_send.id = prior.send_id
          WHERE prior_send.newsletter_id = ? AND prior.subscriber_id = delivery.subscriber_id AND prior.send_id <> delivery.send_id
            AND (prior.status IN ('pending', 'sent') OR prior.delivery_certainty = 'indeterminate'))`).bind(1, 7).all();
    assert.equal(eligible.results.length, 0);
    await db.prepare("UPDATE newsletter_deliveries SET status = 'failed' WHERE send_id = 2").run();
    const afterKnownFailure = await db.prepare(`SELECT delivery.subscriber_id FROM newsletter_deliveries AS delivery
      JOIN newsletter_subscribers AS subscriber ON subscriber.id = delivery.subscriber_id
      WHERE delivery.send_id = ? AND delivery.status = 'failed' AND delivery.delivery_certainty = 'known' AND subscriber.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM newsletter_deliveries AS prior JOIN newsletter_sends AS prior_send ON prior_send.id = prior.send_id
          WHERE prior_send.newsletter_id = ? AND prior.subscriber_id = delivery.subscriber_id AND prior.send_id <> delivery.send_id
            AND (prior.status IN ('pending', 'sent') OR prior.delivery_certainty = 'indeterminate'))`).bind(1, 7).all();
    assert.deepEqual(afterKnownFailure.results.map((row) => row.subscriber_id), [9]);
    const reserveRetry = (id, key) => db.batch([
      db.prepare("INSERT INTO newsletter_sends (id, newsletter_id, idempotency_key, status, source_send_id) VALUES (?, 7, ?, 'queued', 1)").bind(id, key),
      db.prepare(`INSERT INTO newsletter_deliveries (send_id, subscriber_id, status)
        SELECT ?, delivery.subscriber_id, 'pending' FROM newsletter_deliveries AS delivery
        JOIN newsletter_subscribers AS subscriber ON subscriber.id = delivery.subscriber_id
        WHERE delivery.send_id = 1 AND delivery.status = 'failed' AND delivery.delivery_certainty = 'known' AND subscriber.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM newsletter_deliveries AS prior JOIN newsletter_sends AS prior_send ON prior_send.id = prior.send_id
            WHERE prior_send.newsletter_id = 7 AND prior.subscriber_id = delivery.subscriber_id AND prior.send_id <> delivery.send_id
              AND (prior.status IN ('pending', 'sent') OR prior.delivery_certainty = 'indeterminate'))`).bind(id),
    ]);
    await Promise.all([reserveRetry(4, 'retry-three'), reserveRetry(5, 'retry-four')]);
    const reservations = await db.prepare('SELECT send_id FROM newsletter_deliveries WHERE send_id IN (4, 5) ORDER BY send_id').all();
    assert.equal(reservations.results.length, 1);
  } finally { await mf.dispose(); }
});
