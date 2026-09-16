import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { onRequestPost } from '../../functions/api/newsletter/webhook.js';

const SECRET_BYTES = Buffer.alloc(32, 7);
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;

function eventBody(type = 'email.bounced', options = {}) {
  return JSON.stringify({
    type,
    created_at: '2026-09-16T00:00:00.000Z',
    data: {
      email_id: options.messageId ?? 'resend-message-1',
      bounce: options.bounce ?? { type: options.bounceType ?? 'Permanent' },
    },
  });
}

function signature(id, timestamp, body, secret = SECRET) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

class WebhookD1 {
  constructor() {
    this.rows = {
      subscribers: [{ id: 1, email: 'reader@example.test', status: 'active' }],
      deliveries: [{ id: 1, subscriber_id: 1, resend_message_id: 'resend-message-1', status: 'sent' }],
      webhookEvents: [],
    };
    this.failSuppression = false;
  }

  prepare(sql) {
    return {
      bind: (...params) => ({
        sql, params,
        run: () => this.run(sql, params),
        first: () => this.first(sql, params),
      }),
    };
  }

  async first(sql, params) {
    if (sql.includes('SELECT svix_id FROM newsletter_webhook_events')) {
      return this.rows.webhookEvents.find((event) => (
        event.svix_id === params[0] && event.processed_at !== null
      )) ?? null;
    }
    throw new Error(`Unsupported first query: ${sql}`);
  }

  async batch(statements) {
    const snapshot = structuredClone(this.rows);
    try {
      const results = [];
      for (const statement of statements) results.push(await this.run(statement.sql, statement.params));
      return results;
    } catch (error) {
      this.rows = snapshot;
      throw error;
    }
  }

  async run(sql, params) {
    if (sql.includes('INSERT INTO newsletter_webhook_events')) {
      const [svixId, claimToken] = params;
      const messageId = params.length === 5 ? params[4] : null;
      if (messageId && !this.rows.deliveries.some((delivery) => delivery.resend_message_id === messageId)) {
        return { meta: { changes: 0 } };
      }
      if (!this.rows.webhookEvents.some((event) => event.svix_id === svixId)) {
        this.rows.webhookEvents.push({ svix_id: svixId, claim_token: claimToken, processed_at: null });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (sql.includes('UPDATE newsletter_deliveries')) {
      if (this.failSuppression) throw new Error('simulated D1 failure');
      const [status, messageId, svixId, claimToken] = params;
      const claimed = this.rows.webhookEvents.some((event) => event.svix_id === svixId && event.claim_token === claimToken);
      if (!claimed) return { meta: { changes: 0 } };
      for (const delivery of this.rows.deliveries) {
        if (delivery.resend_message_id === messageId && !['bounced', 'complained'].includes(delivery.status)) delivery.status = status;
      }
      return { meta: { changes: 1 } };
    }

    if (sql.includes('UPDATE newsletter_subscribers')) {
      const [status, messageId, svixId, claimToken] = params;
      const claimed = this.rows.webhookEvents.some((event) => event.svix_id === svixId && event.claim_token === claimToken);
      if (!claimed) return { meta: { changes: 0 } };
      const delivery = this.rows.deliveries.find((item) => item.resend_message_id === messageId);
      const subscriber = delivery && this.rows.subscribers.find((item) => item.id === delivery.subscriber_id);
      if (subscriber && !['unsubscribed', 'bounced', 'complained'].includes(subscriber.status)) subscriber.status = status;
      return { meta: { changes: subscriber ? 1 : 0 } };
    }

    if (sql.includes('SET processed_at')) {
      const [svixId, claimToken] = params;
      const event = this.rows.webhookEvents.find((item) => item.svix_id === svixId && item.claim_token === claimToken);
      if (event) event.processed_at = '2026-09-16 00:00:00';
      return { meta: { changes: event ? 1 : 0 } };
    }

    throw new Error(`Unsupported query: ${sql}`);
  }
}

function makeWebhookContext(options = {}) {
  const id = options.id ?? 'msg_01H00000000000000000000000';
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const body = options.body ?? eventBody(options.event, options);
  const expected = signature(id, timestamp, body, options.secret ?? SECRET);
  const supplied = options.signature ?? `v1,${expected}`;
  const headers = new Headers({
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': supplied,
  });
  if (options.withoutHeader) headers.delete(options.withoutHeader);
  const db = new WebhookD1();
  if (options.subscriberStatus) db.rows.subscribers[0].status = options.subscriberStatus;
  if (options.deliveryStatus) db.rows.deliveries[0].status = options.deliveryStatus;
  db.failSuppression = Boolean(options.failSuppression);
  return {
    request: new Request('https://site.test/api/newsletter/webhook', { method: 'POST', headers, body }),
    env: { DB: db, RESEND_WEBHOOK_SECRET: options.secret ?? SECRET },
    db,
  };
}

test('rejects an invalid webhook signature before changing data', async () => {
  const ctx = makeWebhookContext({ signature: 'v1,bad' });
  assert.equal((await onRequestPost(ctx)).status, 400);
  assert.equal(ctx.db.rows.subscribers[0].status, 'active');
  assert.equal(ctx.db.rows.webhookEvents.length, 0);
});

test('rejects missing Svix headers and malformed webhook secrets before parsing data', async () => {
  for (const options of [
    { withoutHeader: 'svix-id' }, { withoutHeader: 'svix-timestamp' }, { withoutHeader: 'svix-signature' },
    { secret: 'not-a-whsec-secret' }, { secret: 'whsec_not-valid-base64!' },
  ]) {
    const ctx = makeWebhookContext(options);
    assert.equal((await onRequestPost(ctx)).status, 400);
    assert.equal(ctx.db.rows.webhookEvents.length, 0);
  }
});

test('rejects stale and implausibly future signed webhook timestamps', async () => {
  for (const timestamp of [Math.floor(Date.now() / 1000) - 301, Math.floor(Date.now() / 1000) + 301]) {
    const ctx = makeWebhookContext({ timestamp });
    assert.equal((await onRequestPost(ctx)).status, 400);
    assert.equal(ctx.db.rows.webhookEvents.length, 0);
  }
});

test('accepts a valid v1 signature when another supplied v1 signature is invalid', async () => {
  const ctx = makeWebhookContext();
  const body = await ctx.request.clone().text();
  const good = signature('msg_01H00000000000000000000000', ctx.request.headers.get('svix-timestamp'), body);
  ctx.request = new Request(ctx.request, { headers: new Headers({
    'svix-id': 'msg_01H00000000000000000000000',
    'svix-timestamp': ctx.request.headers.get('svix-timestamp'),
    'svix-signature': `v1,bad v1,${good}`,
  }) });
  assert.equal((await onRequestPost(ctx)).status, 200);
  assert.equal(ctx.db.rows.subscribers[0].status, 'bounced');
});

test('accepts an unpadded base64 Svix secret', async () => {
  const secret = `whsec_${SECRET_BYTES.toString('base64').replace(/=+$/, '')}`;
  const ctx = makeWebhookContext({ secret });
  assert.equal((await onRequestPost(ctx)).status, 200);
  assert.equal(ctx.db.rows.subscribers[0].status, 'bounced');
});

test('permanent bounce suppresses the matching delivery and subscriber', async () => {
  const ctx = makeWebhookContext({ event: 'email.bounced', bounceType: 'Permanent' });
  assert.equal((await onRequestPost(ctx)).status, 200);
  assert.equal(ctx.db.rows.subscribers[0].status, 'bounced');
  assert.equal(ctx.db.rows.deliveries[0].status, 'bounced');
});

test('transient bounce leaves delivery and subscriber sendable', async () => {
  const ctx = makeWebhookContext({ event: 'email.bounced', bounceType: 'Transient' });
  assert.equal((await onRequestPost(ctx)).status, 200);
  assert.equal(ctx.db.rows.subscribers[0].status, 'active');
  assert.equal(ctx.db.rows.deliveries[0].status, 'sent');
});

test('complaint suppresses the matching delivery and subscriber', async () => {
  const ctx = makeWebhookContext({ event: 'email.complained' });
  assert.equal((await onRequestPost(ctx)).status, 200);
  assert.equal(ctx.db.rows.subscribers[0].status, 'complained');
  assert.equal(ctx.db.rows.deliveries[0].status, 'complained');
});

test('a duplicate Svix delivery is idempotent', async () => {
  const first = makeWebhookContext({ id: 'msg_duplicate' });
  assert.equal((await onRequestPost(first)).status, 200);
  const second = makeWebhookContext({ id: 'msg_duplicate' });
  second.db = first.db;
  second.env.DB = first.db;
  assert.equal((await onRequestPost(second)).status, 200);
  assert.equal(first.db.rows.webhookEvents.length, 1);
  assert.equal(first.db.rows.subscribers[0].status, 'bounced');
});

test('a failed suppression transaction does not consume its Svix event', async () => {
  const ctx = makeWebhookContext({ id: 'msg_retry_after_failure', failSuppression: true });
  assert.equal((await onRequestPost(ctx)).status, 500);
  assert.equal(ctx.db.rows.webhookEvents.length, 0);
  ctx.db.failSuppression = false;
  const retry = makeWebhookContext({ id: 'msg_retry_after_failure' });
  retry.db = ctx.db;
  retry.env.DB = ctx.db;
  assert.equal((await onRequestPost(retry)).status, 200);
  assert.equal(ctx.db.rows.subscribers[0].status, 'bounced');
});

test('a suppression event retries until the worker has stored its provider message id', async () => {
  const first = makeWebhookContext({ id: 'msg_before_provider_id' });
  first.db.rows.deliveries[0].resend_message_id = null;
  assert.equal((await onRequestPost(first)).status, 500);
  assert.equal(first.db.rows.subscribers[0].status, 'active');
  assert.equal(first.db.rows.webhookEvents.length, 0);

  first.db.rows.deliveries[0].resend_message_id = 'resend-message-1';
  const retry = makeWebhookContext({ id: 'msg_before_provider_id' });
  retry.db = first.db;
  retry.env.DB = first.db;
  assert.equal((await onRequestPost(retry)).status, 200);
  assert.equal(first.db.rows.subscribers[0].status, 'bounced');
  assert.equal(first.db.rows.webhookEvents.length, 1);
});

test('valid unhandled events are acknowledged after validation', async () => {
  const ctx = makeWebhookContext({ event: 'email.delivered' });
  assert.equal((await onRequestPost(ctx)).status, 200);
  assert.equal(ctx.db.rows.subscribers[0].status, 'active');
});

test('suppression never overwrites an existing terminal or unsubscribed state', async () => {
  for (const subscriberStatus of ['unsubscribed', 'bounced', 'complained']) {
    const ctx = makeWebhookContext({ subscriberStatus, deliveryStatus: 'complained' });
    assert.equal((await onRequestPost(ctx)).status, 200);
    assert.equal(ctx.db.rows.subscribers[0].status, subscriberStatus);
    assert.equal(ctx.db.rows.deliveries[0].status, 'complained');
  }
});

test('rejects signed payloads without a usable email provider message id', async () => {
  const ctx = makeWebhookContext({ body: JSON.stringify({ type: 'email.complained', data: {} }) });
  assert.equal((await onRequestPost(ctx)).status, 400);
  assert.equal(ctx.db.rows.webhookEvents.length, 0);
});
