import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as subscribe } from '../../functions/api/newsletter/subscribe.js';
import { onRequestGet as confirm } from '../../functions/api/newsletter/confirm.js';
import { onRequestPost as resendConfirmation } from '../../functions/api/newsletter/resend-confirmation.js';
import { onRequestGet as unsubscribe, onRequestPost as unsubscribeOneClick } from '../../functions/api/newsletter/unsubscribe.js';
import { ResendError, sendEmail } from '../../lib/newsletter/resend.js';
import { makeEnv, jsonRequest } from '../helpers/fixtures.js';

const GENERIC_RESPONSE = '확인할 수 있는 경우 구독 안내 메일을 보냈습니다.';
const realFetch = globalThis.fetch;

test.beforeEach((context) => {
  context.env = makeEnv();
  globalThis.fetch = async (_url, init) => {
    context.env.sentEmails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `email-${context.env.sentEmails.length}` }), { status: 200 });
  };
});

test.afterEach(() => { globalThis.fetch = realFetch; });

function confirmationTokenFrom(env) {
  return new URL(env.sentEmails.at(-1).html.match(/https?:[^"']+/)[0]).searchParams.get('token');
}

test('subscribe requires explicit consent and stores a normalized pending email with only a token hash', async (context) => {
  const { env } = context;
  const denied = await subscribe({ request: jsonRequest('/api/newsletter/subscribe', { email: 'a@example.com', consent: false }), env });
  assert.equal(denied.status, 400);

  const accepted = await subscribe({ request: jsonRequest('/api/newsletter/subscribe', { email: ' A@Example.com ', consent: true }), env });
  assert.equal(accepted.status, 202);
  assert.equal(env.rows.subscribers[0].email, 'a@example.com');
  assert.equal(env.rows.subscribers[0].status, 'pending');
  assert.equal('raw_confirmation_token' in env.rows.subscribers[0], false);
  assert.notEqual(env.rows.subscribers[0].confirmation_token_hash, confirmationTokenFrom(env));
});

test('subscribe rejects malformed email addresses', async (context) => {
  const response = await subscribe({ request: jsonRequest('/api/newsletter/subscribe', { email: 'not-an-email', consent: true }), env: context.env });
  assert.equal(response.status, 400);
  assert.equal(context.env.rows.subscribers.length, 0);
});

test('honeypot submissions are accepted without retaining data or sending mail', async (context) => {
  const response = await subscribe({ request: jsonRequest('/api/newsletter/subscribe', { email: 'bot@example.com', consent: true, company: 'spam' }), env: context.env });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { message: GENERIC_RESPONSE });
  assert.equal(context.env.rows.subscribers.length, 0);
  assert.equal(context.env.sentEmails.length, 0);
});

test('new, pending, and active addresses receive the same enumeration-safe response', async (context) => {
  const { env } = context;
  const first = await subscribe({ request: jsonRequest('/api/newsletter/subscribe', { email: 'reader@example.com', consent: true }), env });
  const pending = await subscribe({ request: jsonRequest('/api/newsletter/subscribe', { email: 'reader@example.com', consent: true }), env });
  env.rows.subscribers[0].status = 'active';
  const active = await subscribe({ request: jsonRequest('/api/newsletter/subscribe', { email: 'reader@example.com', consent: true }), env });
  assert.deepEqual(await first.json(), { message: GENERIC_RESPONSE });
  assert.deepEqual(await pending.json(), { message: GENERIC_RESPONSE });
  assert.deepEqual(await active.json(), { message: GENERIC_RESPONSE });
  assert.equal(env.sentEmails.length, 2);
});

test('rate-limit records contain no raw email address or IP address', async (context) => {
  const { env } = context;
  await subscribe({ request: jsonRequest('/api/newsletter/subscribe', { email: 'privacy@example.com', consent: true }, { ip: '203.0.113.8' }), env });
  const stored = JSON.stringify([...env.rateLimits.entries()]);
  assert.equal(stored.includes('privacy@example.com'), false);
  assert.equal(stored.includes('203.0.113.8'), false);
});

test('confirmation is one-time and activates a pending subscriber', async (context) => {
  const { env } = context;
  const raw = await env.seedPending('a@example.com');
  const first = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${raw}`), env });
  assert.equal(first.status, 302);
  assert.match(first.headers.get('Location'), /newsletter-status\.html\?state=confirmed/);
  assert.equal(env.rows.subscribers[0].status, 'active');
  assert.equal(env.rows.subscribers[0].confirmation_token_hash, null);
  const replay = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${raw}`), env });
  assert.match(replay.headers.get('Location'), /state=invalid/);
});

test('expired confirmation tokens are rejected', async (context) => {
  const raw = await context.env.seedPending('a@example.com', '2020-01-01 00:00:00');
  const response = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${raw}`), env: context.env });
  assert.match(response.headers.get('Location'), /state=invalid/);
  assert.equal(context.env.rows.subscribers[0].status, 'pending');
});

test('resending a pending confirmation invalidates the preceding token', async (context) => {
  const { env } = context;
  const oldToken = await env.seedPending('a@example.com');
  const response = await resendConfirmation({ request: jsonRequest('/api/newsletter/resend-confirmation', { email: 'a@example.com' }), env });
  const newToken = confirmationTokenFrom(env);
  assert.equal(response.status, 202);
  assert.notEqual(newToken, oldToken);
  const oldConfirmation = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${oldToken}`), env });
  assert.match(oldConfirmation.headers.get('Location'), /state=invalid/);
  const newConfirmation = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${newToken}`), env });
  assert.match(newConfirmation.headers.get('Location'), /state=confirmed/);
});

test('unsubscribe GET is idempotent and does not expose the email in the redirect', async (context) => {
  const { env } = context;
  const subscriber = env.seedSubscriber('reader@example.com');
  const token = await env.unsubscribeToken(subscriber);
  const url = `https://site.test/api/newsletter/unsubscribe?token=${token}`;
  const first = await unsubscribe({ request: new Request(url), env });
  const replay = await unsubscribe({ request: new Request(url), env });
  assert.match(first.headers.get('Location'), /state=unsubscribed/);
  assert.match(replay.headers.get('Location'), /state=unsubscribed/);
  assert.equal(first.headers.get('Location').includes('reader@example.com'), false);
  assert.equal(subscriber.status, 'unsubscribed');
  assert.ok(subscriber.unsubscribed_at);
});

test('unsubscribe accepts RFC 8058 one-click POST requests', async (context) => {
  const { env } = context;
  const token = await env.unsubscribeToken(env.seedSubscriber('reader@example.com'));
  const request = new Request(`https://site.test/api/newsletter/unsubscribe?token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
  });
  const response = await unsubscribeOneClick({ request, env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(env.rows.subscribers[0].status, 'unsubscribed');
});

test('an unsubscribed address must complete a new confirmation before reactivation', async (context) => {
  const { env } = context;
  const subscriber = env.seedSubscriber('reader@example.com', 'unsubscribed');
  const response = await subscribe({ request: jsonRequest('/api/newsletter/subscribe', { email: subscriber.email, consent: true }), env });
  assert.equal(response.status, 202);
  assert.equal(subscriber.status, 'pending');
  const confirmResponse = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${confirmationTokenFrom(env)}`), env });
  assert.match(confirmResponse.headers.get('Location'), /state=confirmed/);
  assert.equal(subscriber.status, 'active');
});

test('Resend client sets its idempotency header and returns a typed error without leaking response details', async (context) => {
  const { env } = context;
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = init;
    return new Response(JSON.stringify({ id: 'resend-id' }), { status: 200 });
  };
  assert.deepEqual(await sendEmail(env, { to: 'reader@example.com', subject: 'Subject', html: '<p>Hello</p>', text: 'Hello', idempotencyKey: 'operation-1' }), { id: 'resend-id' });
  assert.equal(captured.headers['X-Entity-Ref-ID'], 'operation-1');
  globalThis.fetch = async () => new Response(JSON.stringify({ name: 'validation_error', message: 'Invalid recipient' }), { status: 422 });
  await assert.rejects(() => sendEmail(env, { to: 'reader@example.com', subject: 'Subject', html: '<p>Hello</p>', text: 'Hello', idempotencyKey: 'operation-2' }), (error) => error instanceof ResendError && error.status === 422 && error.code === 'validation_error');
});
