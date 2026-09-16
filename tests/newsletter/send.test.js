import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as startSend } from '../../functions/api/admin/newsletters/[id]/send.js';
import { onRequestPost as retrySend } from '../../functions/api/admin/newsletters/[id]/retry.js';
import { signToken } from '../../lib/auth.js';

async function adminRequest(headers = {}) {
  const secret = 'test-secret-at-least-32-characters';
  const token = await signToken({ uid: 1, exp: Date.now() + 60_000 }, secret);
  return {
    request: new Request('https://site.test/api/admin/newsletters/4/send', {
      method: 'POST', headers: { Cookie: `ailit_session=${token}`, ...headers },
    }),
    env: { SESSION_SECRET: secret, DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 1, is_admin: 1 }) }) }) } },
    params: { id: '4' },
  };
}

async function bulkContext({ activeSubscribers = 0, idempotencyKey = 'fixed-key', queueFailsAt = 0 } = {}) {
  const secret = 'test-secret-at-least-32-characters';
  const token = await signToken({ uid: 1, exp: Date.now() + 60_000 }, secret);
  const rows = {
    newsletter: {
      id: 4, subject: '제목', preview_text: '미리보기',
      content_json: JSON.stringify([{ id: 'body', type: 'paragraph', data: { text: '본문' } }]), status: 'draft',
    },
    subscribers: Array.from({ length: activeSubscribers }, (_, index) => ({ id: index + 1, email: `reader${index + 1}@example.com`, status: 'active' })),
    sends: [], deliveries: [],
  };
  let nextSendId = 1;
  let nextDeliveryId = 1;
  function statement(sql, params) {
    if (sql.includes('SELECT * FROM users')) return { id: 1, is_admin: 1 };
    if (sql.includes('SELECT id, newsletter_id, status FROM newsletter_sends WHERE idempotency_key')) {
      return rows.sends.find((send) => send.idempotency_key === params[0]) || null;
    }
    if (sql.includes('FROM newsletters WHERE id = ?')) return rows.newsletter.id === params[0] ? rows.newsletter : null;
    if (sql.includes('SELECT id FROM newsletter_deliveries')) {
      return rows.deliveries.filter((delivery) => delivery.send_id === params[0] && delivery.status === 'pending' && !delivery.queued_at)
        .map(({ id }) => ({ id }));
    }
    if (sql.includes("INSERT INTO newsletter_sends") && sql.includes("FROM newsletters")) {
      if (rows.newsletter.status !== 'draft') return null;
      const send = { id: nextSendId++, newsletter_id: params[1], idempotency_key: params[0], status: 'queued', target_count: 0 };
      rows.sends.push(send);
      return send;
    }
    if (sql.includes("UPDATE newsletters SET status = 'sending'")) {
      if (rows.newsletter.id === params[0] && rows.newsletter.status === 'draft') rows.newsletter.status = 'sending';
      return null;
    }
    if (sql.includes('INSERT INTO newsletter_deliveries') && sql.includes('CROSS JOIN newsletter_subscribers')) {
      const send = rows.sends.find((item) => item.idempotency_key === params[0]);
      rows.subscribers.filter((subscriber) => subscriber.status === 'active').forEach((subscriber) => {
        if (!rows.deliveries.some((delivery) => delivery.send_id === send.id && delivery.subscriber_id === subscriber.id)) {
          rows.deliveries.push({ id: nextDeliveryId++, send_id: send.id, subscriber_id: subscriber.id, status: 'pending', queued_at: null });
        }
      });
      return null;
    }
    if (sql.includes('SET target_count = (SELECT COUNT(*)')) {
      const send = rows.sends.find((item) => item.idempotency_key === params[0]);
      if (send) send.target_count = rows.deliveries.filter((delivery) => delivery.send_id === send.id).length;
      return null;
    }
    if (sql.includes('SET queued_at = datetime')) {
      const [sendId, ...ids] = params;
      rows.deliveries.filter((delivery) => delivery.send_id === sendId && delivery.status === 'pending' && !delivery.queued_at && ids.includes(delivery.id))
        .forEach((delivery) => { delivery.queued_at = 'now'; });
      return null;
    }
    if (sql.includes("SET status = 'queued'")) {
      const send = rows.sends.find((item) => item.id === params[0]);
      if (send && ['queued', 'failed'].includes(send.status)) send.status = 'queued';
      return null;
    }
    if (sql.includes("SET status = 'failed'")) {
      const send = rows.sends.find((item) => item.id === params[0]);
      if (send) send.status = 'failed';
      return null;
    }
    if (sql.includes("SET status = 'completed'")) {
      const send = rows.sends.find((item) => item.id === params[0]);
      if (send) send.status = 'completed';
      return null;
    }
    throw new Error(`Unsupported newsletter test query: ${sql}`);
  }
  const DB = {
    prepare(sql) {
      return {
        bind: (...params) => ({
          sql,
          params,
          first: async () => statement(sql, params),
          all: async () => ({ results: statement(sql, params) }),
          run: async () => {
            statement(sql, params);
            return { meta: { changes: 1 } };
          },
        }),
      };
    },
    async batch(statements) {
      return statements.map((item) => ({ results: [statement(item.sql, item.params)].filter(Boolean) }));
    },
  };
  const queueMessages = [];
  let sends = 0;
  const env = {
    DB, SESSION_SECRET: secret, NEWSLETTER_FROM: 'AILIT <newsletter@site.test>', PUBLIC_SITE_URL: 'https://site.test', rows,
    NEWSLETTER_QUEUE: { send: async (message) => {
      sends += 1;
      if (queueFailsAt && sends === queueFailsAt) throw new Error('queue unavailable');
      queueMessages.push(message);
    } },
  };
  return {
    request: new Request('https://site.test/api/admin/newsletters/4/send', {
      method: 'POST', headers: { Cookie: `ailit_session=${token}`, 'Idempotency-Key': idempotencyKey },
    }), env, params: { id: '4' }, queueMessages,
  };
}

test('bulk send accepts only a bounded Idempotency-Key', async () => {
  const response = await startSend(await adminRequest({ 'Idempotency-Key': 'short' }));
  assert.equal(response.status, 400);
});

test('bulk send handler is available for snapshot and idempotent delivery tests', () => {
  assert.equal(typeof startSend, 'function');
});

test('send snapshots active recipients into batches of at most 100', async () => {
  const ctx = await bulkContext({ activeSubscribers: 205 });
  const response = await startSend(ctx);
  assert.equal(response.status, 202);
  assert.deepEqual(ctx.queueMessages.map((message) => message.deliveryIds.length), [100, 100, 5]);
  assert.equal(ctx.env.rows.newsletter.status, 'sending');
  assert.equal(ctx.env.rows.deliveries.length, 205);
  assert.equal(ctx.env.rows.deliveries.every((delivery) => delivery.queued_at), true);
});

test('same idempotency key resumes only deliveries not yet queued', async () => {
  const ctx = await bulkContext({ activeSubscribers: 205, queueFailsAt: 2 });
  assert.equal((await startSend(ctx)).status, 503);
  assert.deepEqual(ctx.queueMessages.map((message) => message.deliveryIds.length), [100]);
  assert.equal(ctx.env.rows.deliveries.filter((delivery) => delivery.queued_at).length, 100);
  ctx.env.NEWSLETTER_QUEUE.send = async (message) => ctx.queueMessages.push(message);
  assert.equal((await startSend(ctx)).status, 202);
  assert.deepEqual(ctx.queueMessages.map((message) => message.deliveryIds.length), [100, 100, 5]);
  assert.equal(ctx.env.rows.deliveries.length, 205);
  assert.equal(ctx.env.rows.deliveries.every((delivery) => delivery.queued_at), true);
});

test('repeating a fully queued send does not finalize deliveries before the worker does', async () => {
  const ctx = await bulkContext({ activeSubscribers: 3 });
  await startSend(ctx);
  await startSend(ctx);
  assert.equal(ctx.env.rows.newsletter.status, 'sending');
  assert.equal(ctx.env.rows.sends[0].status, 'queued');
});

test('failed-only retry snapshots only subscribers who are still active', async () => {
  const secret = 'test-secret-at-least-32-characters';
  const token = await signToken({ uid: 1, exp: Date.now() + 60_000 }, secret);
  const rows = {
    newsletter: { id: 4, subject: '제목', preview_text: '미리보기', content_json: JSON.stringify([{ id: 'body', type: 'paragraph', data: { text: '본문' } }]), status: 'failed' },
    subscribers: [{ id: 1, status: 'active' }, { id: 2, status: 'unsubscribed' }],
    sourceDeliveries: [{ subscriber_id: 1, status: 'failed' }, { subscriber_id: 2, status: 'failed' }],
    deliveries: [], sends: [],
  };
  function query(sql, params) {
    if (sql.includes('SELECT * FROM users')) return { id: 1, is_admin: 1 };
    if (sql.includes('WHERE idempotency_key = ?')) return rows.sends.find((send) => send.idempotency_key === params[0]) || null;
    if (sql.includes('FROM newsletters WHERE id = ?')) return rows.newsletter;
    if (sql.includes("status IN ('partial', 'failed')")) return { id: 9, newsletter_id: 4, status: 'failed' };
    if (sql.includes("INSERT INTO newsletter_sends") && sql.includes('VALUES')) {
      const send = { id: 10, newsletter_id: params[0], idempotency_key: params[1], status: 'queued' };
      rows.sends.push(send);
      return send;
    }
    if (sql.includes('INSERT INTO newsletter_deliveries') && sql.includes('JOIN newsletter_subscribers')) {
      rows.sourceDeliveries.filter((delivery) => delivery.status === 'failed')
        .filter((delivery) => rows.subscribers.find((subscriber) => subscriber.id === delivery.subscriber_id)?.status === 'active')
        .forEach((delivery, index) => rows.deliveries.push({ id: index + 1, send_id: params[0], subscriber_id: delivery.subscriber_id, status: 'pending' }));
      return null;
    }
    if (sql.includes('SET target_count')) return null;
    if (sql.includes("UPDATE newsletters SET status = 'sending'")) return null;
    if (sql.includes('SELECT id FROM newsletter_deliveries')) return rows.deliveries.filter((delivery) => delivery.status === 'pending').map(({ id }) => ({ id }));
    if (sql.includes('SET queued_at = datetime')) {
      const [, ...ids] = params;
      rows.deliveries.filter((delivery) => ids.includes(delivery.id)).forEach((delivery) => { delivery.queued_at = 'now'; });
      return null;
    }
    if (sql.includes("SET status = 'queued'")) return null;
    throw new Error(`Unsupported retry test query: ${sql}`);
  }
  const DB = {
    prepare(sql) {
      return { bind: (...params) => ({ sql, params, first: async () => query(sql, params), all: async () => ({ results: query(sql, params) }), run: async () => { query(sql, params); return { meta: { changes: 1 } }; } }) };
    },
    async batch(items) { items.forEach((item) => query(item.sql, item.params)); return []; },
  };
  const queueMessages = [];
  const ctx = {
    request: new Request('https://site.test/api/admin/newsletters/4/retry', {
      method: 'POST', headers: { Cookie: `ailit_session=${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'retry-key' }, body: JSON.stringify({ sendId: 9 }),
    }),
    env: { DB, SESSION_SECRET: secret, NEWSLETTER_QUEUE: { send: async (message) => queueMessages.push(message) } }, params: { id: '4' },
  };
  assert.equal((await retrySend(ctx)).status, 202);
  assert.deepEqual(rows.deliveries.map((delivery) => delivery.subscriber_id), [1]);
  assert.deepEqual(queueMessages[0].deliveryIds, [1]);
});
