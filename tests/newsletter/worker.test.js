import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { processMessage } from '../../worker/src/newsletter-worker.js';

test('newsletter queue worker exposes a queue consumer', () => {
  assert.equal(typeof worker.queue, 'function');
});

function workerEnv({ response = new Response(JSON.stringify({ data: [{ id: 'resend-1' }, { id: 'resend-2' }] }), { status: 200 }) } = {}) {
  const rows = {
    newsletter: {
      id: 8, subject: '안전한 제목', preview_text: '미리보기',
      content_json: JSON.stringify([{ id: 'copy', type: 'paragraph', data: { text: '안전한 본문' } }]), status: 'sending',
    },
    send: { id: 3, newsletter_id: 8, status: 'queued', target_count: 2, success_count: 0, failure_count: 0 },
    subscribers: [{ id: 11, email: 'first@example.com', status: 'active' }, { id: 12, email: 'second@example.com', status: 'active' }],
    deliveries: [
      { id: 21, send_id: 3, subscriber_id: 11, status: 'pending' },
      { id: 22, send_id: 3, subscriber_id: 12, status: 'pending' },
    ],
  };
  function run(sql, params) {
    if (sql.includes('SELECT send.id AS send_id')) return { ...rows.newsletter, send_id: 3, newsletter_id: 8 };
    if (sql.includes("SET status = 'failed', error_code = 'inactive_subscriber'")) {
      const [sendId, ...ids] = params;
      rows.deliveries.filter((delivery) => delivery.send_id === sendId && ids.includes(delivery.id)
        && rows.subscribers.find((subscriber) => subscriber.id === delivery.subscriber_id)?.status !== 'active')
        .forEach((delivery) => { delivery.status = 'failed'; });
      return null;
    }
    if (sql.includes('SELECT delivery.id, delivery.subscriber_id')) {
      const [sendId, ...ids] = params;
      return rows.deliveries.filter((delivery) => delivery.send_id === sendId && delivery.status === 'pending' && ids.includes(delivery.id))
        .map((delivery) => ({ ...delivery, email: rows.subscribers.find((subscriber) => subscriber.id === delivery.subscriber_id).email }));
    }
    if (sql.includes("SET status = 'sent'")) {
      const [messageId, deliveryId, sendId] = params;
      const delivery = rows.deliveries.find((item) => item.id === deliveryId && item.send_id === sendId && item.status === 'pending');
      if (delivery) Object.assign(delivery, { status: 'sent', resend_message_id: messageId });
      return null;
    }
    if (sql.includes("SET status = 'failed', error_code = ?")) {
      const [code, _message, deliveryId, sendId] = params;
      const delivery = rows.deliveries.find((item) => item.id === deliveryId && item.send_id === sendId && item.status === 'pending');
      if (delivery) Object.assign(delivery, { status: 'failed', error_code: code });
      return null;
    }
    if (sql.includes('SUM(CASE WHEN status')) {
      const sendId = params[0];
      const deliveries = rows.deliveries.filter((delivery) => delivery.send_id === sendId);
      return {
        target_count: deliveries.length,
        success_count: deliveries.filter((delivery) => delivery.status === 'sent').length,
        failure_count: deliveries.filter((delivery) => ['failed', 'bounced', 'complained'].includes(delivery.status)).length,
        pending_count: deliveries.filter((delivery) => delivery.status === 'pending').length,
      };
    }
    if (sql.includes('UPDATE newsletter_sends') && sql.includes('SET target_count = ?')) {
      Object.assign(rows.send, { target_count: params[0], success_count: params[1], failure_count: params[2], status: params[3] });
      return null;
    }
    if (sql.includes('UPDATE newsletters') && sql.includes('SET status = CASE')) {
      rows.newsletter.status = params[0] === 'failed' ? 'failed' : ['completed', 'partial'].includes(params[0]) ? 'sent' : 'sending';
      return null;
    }
    throw new Error(`Unsupported worker test query: ${sql}`);
  }
  const DB = {
    prepare(sql) {
      return {
        bind: (...params) => ({
          sql, params,
          first: async () => run(sql, params),
          all: async () => ({ results: run(sql, params) }),
          run: async () => { run(sql, params); return { meta: { changes: 1 } }; },
        }),
      };
    },
    async batch(statements) {
      statements.forEach((statement) => run(statement.sql, statement.params));
      return [];
    },
  };
  return { env: {
    DB, rows, SESSION_SECRET: 'test-secret-at-least-32-characters', NEWSLETTER_FROM: 'AILIT <newsletter@site.test>',
    PUBLIC_SITE_URL: 'https://site.test', RESEND_API_KEY: 're_test_key', response,
  }, rows };
}

test('worker sends a bounded batch with individual HTTPS unsubscribe URLs and records returned IDs by order', async () => {
  const { env, rows } = workerEnv();
  const originalFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return env.response;
  };
  try {
    await processMessage({ sendId: 3, deliveryIds: [21, 22] }, env);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(payload.length, 2);
  assert.equal(payload.every((message) => message.tracking.open === false && message.tracking.click === false), true);
  assert.match(payload[0].headers['List-Unsubscribe'], /^<https:\/\/site\.test\/api\/newsletter\/unsubscribe\?token=/);
  assert.notEqual(payload[0].headers['List-Unsubscribe'], payload[1].headers['List-Unsubscribe']);
  assert.equal(payload[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.deepEqual(rows.deliveries.map((delivery) => [delivery.status, delivery.resend_message_id]), [['sent', 'resend-1'], ['sent', 'resend-2']]);
  assert.equal(rows.send.status, 'completed');
  assert.equal(rows.send.success_count, 2);
});

test('worker records permanent provider failures but throws transient failures for Queue retry', async () => {
  const permanent = workerEnv({ response: new Response(JSON.stringify({ code: 'invalid_request' }), { status: 422 }) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => permanent.env.response;
  try {
    await processMessage({ sendId: 3, deliveryIds: [21, 22] }, permanent.env);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(permanent.rows.deliveries.every((delivery) => delivery.status === 'failed'), true);
  assert.equal(permanent.rows.send.status, 'failed');

  const transient = workerEnv({ response: new Response('{}', { status: 503 }) });
  globalThis.fetch = async () => transient.env.response;
  try {
    await assert.rejects(processMessage({ sendId: 3, deliveryIds: [21, 22] }, transient.env));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(transient.rows.deliveries.every((delivery) => delivery.status === 'pending'), true);
});

test('worker rejects oversized queue messages before contacting Resend', async () => {
  const { env } = workerEnv();
  await assert.rejects(processMessage({ sendId: 3, deliveryIds: Array.from({ length: 101 }, (_, index) => index + 1) }, env), /Invalid newsletter queue message/);
});

test('worker records invalid frozen content as a permanent delivery failure without calling Resend', async () => {
  const { env, rows } = workerEnv();
  rows.newsletter.content_json = JSON.stringify([
    { id: 'image', type: 'image', data: { url: 'http://unsafe.example/image.jpg', alt: 'unsafe', width: 100 } },
  ]);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}'); };
  try {
    await processMessage({ sendId: 3, deliveryIds: [21, 22] }, env);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
  assert.equal(rows.deliveries.every((delivery) => delivery.status === 'failed'), true);
  assert.equal(rows.send.status, 'failed');
});
