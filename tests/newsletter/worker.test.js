import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { processMessage } from '../../worker/src/newsletter-worker.js';
import { verifyActionToken } from '../../lib/newsletter/tokens.js';

test('newsletter queue worker exposes a queue consumer', () => {
  assert.equal(typeof worker.queue, 'function');
});

function workerEnv({ response = new Response(JSON.stringify({ data: [{ id: 'resend-1' }, { id: 'resend-2' }] }), { status: 200 }), failMarkSent = false, failMarkFailure = false, failOperationResult = false, failOperationInsert = false } = {}) {
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
    operations: [],
  };
  function run(sql, params) {
    if (sql.includes('DELETE FROM newsletter_provider_operations')) return null;
    if (sql.includes('SELECT operation_key, send_id, delivery_ids_json')) return rows.operations.find((operation) => operation.operation_key === params[0]) || null;
    if (sql.includes('INSERT INTO newsletter_provider_operations')) {
      if (failOperationInsert) throw new Error('D1 operation insert failed');
      const [operation_key, send_id, queue_claim_key, delivery_ids_json, request_body, provider_key] = params;
      if (rows.operations.some((operation) => operation.operation_key === operation_key)) throw new Error('unique');
      rows.operations.push({ operation_key, send_id, queue_claim_key, delivery_ids_json, request_body, provider_key, status: 'created', provider_result: null });
      return null;
    }
    if (sql.includes('SELECT id, subscriber_id FROM newsletter_deliveries')) {
      const [sendId, idsJson] = params;
      const ids = JSON.parse(idsJson);
      return ids.map((id) => rows.deliveries.find((delivery) => delivery.send_id === sendId && delivery.id === id)).filter(Boolean);
    }
    if (sql.includes("UPDATE newsletter_provider_operations SET status = 'accepted'")) {
      if (failOperationResult) { failOperationResult = false; throw new Error('D1 operation result write failed'); }
      const operation = rows.operations.find((item) => item.operation_key === params[1]);
      if (operation) Object.assign(operation, { status: 'accepted', provider_result: params[0] });
      return null;
    }
    if (sql.includes("UPDATE newsletter_provider_operations SET outcome = 'rejected'")) {
      const operation = rows.operations.find((item) => item.operation_key === params[1]);
      if (operation) Object.assign(operation, { outcome: 'rejected', provider_result: params[0] });
      return null;
    }
    if (sql.includes('SELECT send.id AS send_id')) return { ...rows.newsletter, send_id: 3, newsletter_id: 8 };
    if (sql.includes("SET status = 'failed', error_code = 'inactive_subscriber'")) {
      const [sendId, idsJson] = params;
      const ids = JSON.parse(idsJson);
      rows.deliveries.filter((delivery) => delivery.send_id === sendId && ids.includes(delivery.id)
        && rows.subscribers.find((subscriber) => subscriber.id === delivery.subscriber_id)?.status !== 'active')
        .forEach((delivery) => { delivery.status = 'failed'; });
      return null;
    }
    if (sql.includes('SELECT delivery.id, delivery.subscriber_id')) {
      const [sendId, idsJson] = params;
      const ids = JSON.parse(idsJson);
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
      if (sql.includes("delivery_certainty = 'known'")) {
        const ids = JSON.parse(params[2]);
        rows.deliveries.filter((delivery) => delivery.send_id === params[1] && delivery.status === 'pending' && ids.includes(delivery.id))
          .forEach((delivery) => { delivery.status = 'failed'; delivery.error_code = code; delivery.delivery_certainty = 'known'; });
        return null;
      }
      const delivery = rows.deliveries.find((item) => item.id === deliveryId && item.send_id === sendId && item.status === 'pending');
      if (delivery) Object.assign(delivery, { status: 'failed', error_code: code });
      return null;
    }
    if (sql.includes("error_code = 'queue_retries_exhausted'")) {
      const [certainty, sendId, idsJson] = params;
      const ids = JSON.parse(idsJson);
      rows.deliveries.filter((delivery) => delivery.send_id === sendId && delivery.status === 'pending' && ids.includes(delivery.id))
        .forEach((delivery) => { delivery.status = 'failed'; delivery.delivery_certainty = certainty; });
      return null;
    }
    if (sql.includes('UPDATE newsletter_sends') && sql.includes('SET target_count = (SELECT')) {
      const deliveries = rows.deliveries.filter((delivery) => delivery.send_id === params[0]);
      const success = deliveries.filter((delivery) => delivery.status === 'sent').length;
      const failure = deliveries.filter((delivery) => ['failed', 'bounced', 'complained'].includes(delivery.status)).length;
      Object.assign(rows.send, { target_count: deliveries.length, success_count: success, failure_count: failure,
        status: deliveries.some((delivery) => delivery.status === 'pending') ? 'sending' : failure === 0 ? 'completed' : success ? 'partial' : 'failed' });
      return null;
    }
    if (sql.includes('UPDATE newsletters') && sql.includes('SET status = CASE')) {
      rows.newsletter.status = rows.send.status === 'failed' ? 'failed' : ['completed', 'partial'].includes(rows.send.status) ? 'sent' : 'sending';
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
      if (failMarkSent && statements.some((statement) => statement.sql.includes("SET status = 'sent'"))) {
        failMarkSent = false;
        throw new Error('D1 write failed after provider acceptance');
      }
      if (failMarkFailure && statements.some((statement) => statement.sql.includes("SET status = 'failed', error_code = ?"))) {
        failMarkFailure = false;
        throw new Error('D1 failure-result write failed');
      }
      statements.forEach((statement) => run(statement.sql, statement.params));
      return [];
    },
  };
  return { env: {
    DB, rows, SESSION_SECRET: 'test-secret-at-least-32-characters', NEWSLETTER_FROM: 'AILIT <newsletter@site.test>',
    NEWSLETTER_TOKEN_SECRET: 'newsletter-secret-at-least-32-characters',
    PUBLIC_SITE_URL: 'https://site.test', RESEND_API_KEY: 're_test_key', response,
  }, rows };
}

test('worker sends a bounded batch with individual HTTPS unsubscribe URLs and records returned IDs by order', async () => {
  const { env, rows } = workerEnv();
  const originalFetch = globalThis.fetch;
  let payload;
  let requestHeaders;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    requestHeaders = init.headers;
    return env.response;
  };
  try {
    await processMessage({ sendId: 3, deliveryIds: [21, 22] }, env);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(payload.length, 2);
  assert.equal(payload.every((message) => !Object.hasOwn(message, 'tracking')), true);
  assert.match(requestHeaders['Idempotency-Key'], /^newsletter-3-[a-f0-9]{64}$/);
  assert.match(payload[0].headers['List-Unsubscribe'], /^<https:\/\/site\.test\/api\/newsletter\/unsubscribe\?token=/);
  const unsubscribeToken = new URL(payload[0].headers['List-Unsubscribe'].slice(1, -1)).searchParams.get('token');
  assert.equal((await verifyActionToken(unsubscribeToken, 'unsubscribe', env.NEWSLETTER_TOKEN_SECRET)).sid, 11);
  assert.equal(await verifyActionToken(unsubscribeToken, 'unsubscribe', env.SESSION_SECRET), null);
  assert.notEqual(payload[0].headers['List-Unsubscribe'], payload[1].headers['List-Unsubscribe']);
  assert.equal(payload[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.deepEqual(rows.deliveries.map((delivery) => [delivery.status, delivery.resend_message_id]), [['sent', 'resend-1'], ['sent', 'resend-2']]);
  assert.equal(rows.send.status, 'completed');
  assert.equal(rows.send.success_count, 2);
});

test('worker records permanent provider failures but throws transient failures for Queue retry', async () => {
  const permanent = workerEnv({ response: new Response(JSON.stringify({ code: 'validation_error' }), { status: 422 }) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => permanent.env.response;
  try {
    await processMessage({ sendId: 3, deliveryIds: [21, 22] }, permanent.env);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(permanent.rows.deliveries.every((delivery) => delivery.status === 'failed'), true);
  assert.equal(permanent.rows.operations[0].outcome, 'rejected');
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

test('rejected operation replays the stored rejection without another provider call and DLQ stays known', async () => {
  const { env, rows } = workerEnv({ response: new Response(JSON.stringify({ code: 'validation_error' }), { status: 422 }), failMarkFailure: true });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return env.response; };
  try {
    await assert.rejects(processMessage({ sendId: 3, deliveryIds: [21, 22] }, env), /failure-result write failed/);
    await processMessage({ sendId: 3, deliveryIds: [21, 22] }, env);
    await worker.queue({ queue: 'ailit-newsletter-dead-letter', messages: [{ body: { sendId: 3, deliveryIds: [21, 22] } }] }, env);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 1);
  assert.equal(rows.operations[0].outcome, 'rejected');
  assert.equal(rows.deliveries.every((delivery) => delivery.status === 'failed' && delivery.delivery_certainty !== 'indeterminate'), true);
  assert.equal(rows.deliveries.every((delivery) => delivery.error_code === 'validation_error'), true);
});

test('worker propagates a failed durable-operation insert when no matching operation can be reread', async () => {
  const { env, rows } = workerEnv({ failOperationInsert: true });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}'); };
  try {
    await assert.rejects(processMessage({ sendId: 3, deliveryIds: [21, 22] }, env), /D1 operation insert failed/);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 0);
  assert.equal(rows.operations.length, 0);
  assert.equal(rows.deliveries.every((delivery) => delivery.status === 'pending'), true);
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

test('redelivery after a post-acceptance D1 failure reuses the frozen provider request', async () => {
  const { env, rows } = workerEnv({ failOperationResult: true });
  const originalFetch = globalThis.fetch;
  const keys = [];
  const bodyByKey = new Map();
  globalThis.fetch = async (_url, init) => {
    keys.push(init.headers['Idempotency-Key']);
    if (bodyByKey.has(init.headers['Idempotency-Key']) && bodyByKey.get(init.headers['Idempotency-Key']) !== init.body) {
      return new Response(JSON.stringify({ code: 'idempotency_key_payload_mismatch' }), { status: 409 });
    }
    bodyByKey.set(init.headers['Idempotency-Key'], init.body);
    return new Response(JSON.stringify({ data: [{ id: 'resend-1' }, { id: 'resend-2' }] }), { status: 200 });
  };
  try {
    await assert.rejects(processMessage({ sendId: 3, deliveryIds: [21, 22] }, env), /operation result write failed/);
    env.SESSION_SECRET = 'rotated-secret-at-least-32-characters';
    env.PUBLIC_SITE_URL = 'https://rotated.example.test';
    env.NEWSLETTER_FROM = 'AILIT <rotated@site.test>';
    rows.subscribers[0].status = 'unsubscribed';
    await processMessage({ sendId: 3, deliveryIds: [21, 22] }, env);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(keys, [keys[0], keys[0]]);
  assert.equal(bodyByKey.size, 1);
  assert.equal(rows.deliveries.every((delivery) => delivery.status === 'sent'), true);
});

test('concurrent Resend idempotency and missing worker configuration remain retryable', async () => {
  const concurrent = workerEnv({ response: new Response(JSON.stringify({ code: 'concurrent_idempotent_requests' }), { status: 409 }) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => concurrent.env.response;
  try {
    await assert.rejects(processMessage({ sendId: 3, deliveryIds: [21, 22] }, concurrent.env), /Resend batch delivery failed/);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(concurrent.rows.deliveries.every((delivery) => delivery.status === 'pending'), true);
  const domain = workerEnv({ response: new Response(JSON.stringify({ code: 'validation_error' }), { status: 403 }) });
  globalThis.fetch = async () => domain.env.response;
  try {
    await assert.rejects(processMessage({ sendId: 3, deliveryIds: [21, 22] }, domain.env), /Resend batch delivery failed/);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(domain.rows.deliveries.every((delivery) => delivery.status === 'pending'), true);
  const missing = workerEnv();
  delete missing.env.NEWSLETTER_TOKEN_SECRET;
  delete missing.env.SESSION_SECRET;
  await assert.rejects(processMessage({ sendId: 3, deliveryIds: [21, 22] }, missing.env), /Missing NEWSLETTER_TOKEN_SECRET/);
  assert.equal(missing.rows.deliveries.every((delivery) => delivery.status === 'pending'), true);
});

test('DLQ reconciliation marks an existing provider operation indeterminate without calling Resend', async () => {
  const { env, rows } = workerEnv();
  rows.operations.push({ operation_key: 'legacy:3:pending', send_id: 3, delivery_ids_json: '[21,22]', request_body: '[]', provider_key: 'key', provider_result: null, status: 'created' });
  // Use a claim key so the operation lookup is the same durable identity as
  // the queue message.
  rows.operations[0].operation_key = 'claim:3:11111111-1111-4111-8111-111111111111';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('must not send'); };
  try {
    await worker.queue({ queue: 'ailit-newsletter-dead-letter', messages: [{ body: { sendId: 3, deliveryIds: [21, 22], queueClaimKey: '11111111-1111-4111-8111-111111111111' } }] }, env);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 0);
  assert.equal(rows.deliveries.every((delivery) => delivery.status === 'failed'), true);
  assert.equal(rows.deliveries.every((delivery) => delivery.delivery_certainty === 'indeterminate'), true);
  assert.equal(rows.send.status, 'failed');
});

test('DLQ preserves a rejected operation diagnostic without another provider call', async () => {
  const { env, rows } = workerEnv();
  rows.operations.push({ operation_key: 'claim:3:22222222-2222-4222-8222-222222222222', send_id: 3, delivery_ids_json: '[21,22]', request_body: '[]', provider_key: 'key', provider_result: '{"code":"validation_error"}', status: 'created', outcome: 'rejected' });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('must not send'); };
  try {
    await worker.queue({ queue: 'ailit-newsletter-dead-letter', messages: [{ body: { sendId: 3, deliveryIds: [21, 22], queueClaimKey: '22222222-2222-4222-8222-222222222222' } }] }, env);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 0);
  assert.equal(rows.deliveries.every((delivery) => delivery.status === 'failed' && delivery.error_code === 'validation_error' && delivery.delivery_certainty !== 'indeterminate'), true);
});
