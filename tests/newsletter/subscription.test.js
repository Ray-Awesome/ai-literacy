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

function publicContext(env, request) {
  return { request, env, waitUntil: env.waitUntil };
}

async function subscribeAndDrain(env, body, options) {
  const response = await subscribe(publicContext(env, jsonRequest('/api/newsletter/subscribe', body, options)));
  await env.drainScheduled();
  return response;
}

async function resendAndDrain(env, body, options) {
  const response = await resendConfirmation(publicContext(env, jsonRequest('/api/newsletter/resend-confirmation', body, options)));
  await env.drainScheduled();
  return response;
}

test('subscribe requires explicit consent and stores a normalized pending email with only a token hash', async (context) => {
  const { env } = context;
  const denied = await subscribeAndDrain(env, { email: 'a@example.com', consent: false });
  assert.equal(denied.status, 400);

  const accepted = await subscribeAndDrain(env, { email: ' A@Example.com ', consent: true });
  assert.equal(accepted.status, 202);
  assert.equal(env.rows.subscribers[0].email, 'a@example.com');
  assert.equal(env.rows.subscribers[0].status, 'pending');
  assert.equal('raw_confirmation_token' in env.rows.subscribers[0], false);
  assert.equal('raw_confirmation_token' in env.rows.challenges[0], false);
  assert.notEqual(env.rows.challenges[0].token_hash, confirmationTokenFrom(env));
});

test('subscribe rejects malformed email addresses', async (context) => {
  const response = await subscribeAndDrain(context.env, { email: 'not-an-email', consent: true });
  assert.equal(response.status, 400);
  assert.equal(context.env.rows.subscribers.length, 0);
});

test('honeypot submissions are accepted without retaining data or sending mail', async (context) => {
  const response = await subscribeAndDrain(context.env, { email: 'bot@example.com', consent: true, company: 'spam' });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { message: GENERIC_RESPONSE });
  assert.equal(context.env.rows.subscribers.length, 0);
  assert.equal(context.env.sentEmails.length, 0);
});

test('new, pending, and active addresses receive the same enumeration-safe response', async (context) => {
  const { env } = context;
  const first = await subscribeAndDrain(env, { email: 'reader@example.com', consent: true });
  const pending = await subscribeAndDrain(env, { email: 'reader@example.com', consent: true });
  env.rows.subscribers[0].status = 'active';
  const active = await subscribeAndDrain(env, { email: 'reader@example.com', consent: true });
  assert.deepEqual(await first.json(), { message: GENERIC_RESPONSE });
  assert.deepEqual(await pending.json(), { message: GENERIC_RESPONSE });
  assert.deepEqual(await active.json(), { message: GENERIC_RESPONSE });
  assert.equal(env.sentEmails.length, 2);
});

test('rate-limit records contain no raw email address or IP address', async (context) => {
  const { env } = context;
  await subscribeAndDrain(env, { email: 'privacy@example.com', consent: true }, { ip: '203.0.113.8' });
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

test('confirmation cannot activate after its presented challenge disappears during validation', async (context) => {
  const { env } = context;
  const raw = await env.seedPending('reader@example.com');
  env.DB.onChallengeValidation = () => { env.rows.challenges = []; };
  const response = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${raw}`), env });
  assert.match(response.headers.get('Location'), /state=invalid/);
  assert.equal(env.rows.subscribers[0].status, 'pending');
});

test('a pending confirmation from the prior single-hash format remains usable', async (context) => {
  const raw = await context.env.seedLegacyPending('reader@example.com');
  const response = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${raw}`), env: context.env });
  assert.match(response.headers.get('Location'), /state=confirmed/);
  assert.equal(context.env.rows.subscribers[0].status, 'active');
});

test('resending a pending confirmation issues a fresh usable challenge', async (context) => {
  const { env } = context;
  const oldToken = await env.seedPending('a@example.com');
  const response = await resendAndDrain(env, { email: 'a@example.com' });
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
  const response = await subscribeAndDrain(env, { email: subscriber.email, consent: true });
  assert.equal(response.status, 202);
  assert.equal(subscriber.status, 'pending');
  const confirmResponse = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${confirmationTokenFrom(env)}`), env });
  assert.match(confirmResponse.headers.get('Location'), /state=confirmed/);
  assert.equal(subscriber.status, 'active');
});

test('re-subscribing cannot reactivate an old challenge from before unsubscribe', async (context) => {
  const { env } = context;
  const oldToken = await env.seedPending('reader@example.com');
  env.rows.subscribers[0].status = 'unsubscribed';
  await subscribeAndDrain(env, { email: 'reader@example.com', consent: true });
  const oldConfirmation = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${oldToken}`), env });
  assert.match(oldConfirmation.headers.get('Location'), /state=invalid/);
  const freshConfirmation = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${confirmationTokenFrom(env)}`), env });
  assert.match(freshConfirmation.headers.get('Location'), /state=confirmed/);
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

test('resending confirmation does not rewrite the original consent timestamp', async (context) => {
  const { env } = context;
  await env.seedPending('reader@example.com');
  env.rows.subscribers[0].consent_at = '2024-01-01 00:00:00';
  await resendAndDrain(env, { email: 'reader@example.com' });
  assert.equal(env.rows.subscribers[0].consent_at, '2024-01-01 00:00:00');
});

test('provider failure leaves an earlier delivered confirmation token usable', async (context) => {
  const { env } = context;
  const oldToken = await env.seedPending('reader@example.com');
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  const response = await resendAndDrain(env, { email: 'reader@example.com' });
  assert.equal(response.status, 202);
  const confirmation = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${oldToken}`), env });
  assert.match(confirmation.headers.get('Location'), /state=confirmed/);
});

test('an earlier successful delivery cannot retire a newer concurrent challenge', async (context) => {
  const { env } = context;
  await env.seedPending('reader@example.com');
  const deliveries = [];
  globalThis.fetch = async (_url, init) => {
    env.sentEmails.push(JSON.parse(init.body));
    return new Promise((resolve) => deliveries.push(resolve));
  };
  await resendConfirmation(publicContext(env, jsonRequest('/api/newsletter/resend-confirmation', { email: 'reader@example.com' })));
  await resendConfirmation(publicContext(env, jsonRequest('/api/newsletter/resend-confirmation', { email: 'reader@example.com' })));
  const [firstWork, secondWork] = env.scheduled;
  deliveries[0](new Response(JSON.stringify({ id: 'first' }), { status: 200 }));
  await firstWork;
  assert.equal(env.rows.challenges.length, 3);
  deliveries[1](new Response(JSON.stringify({ id: 'second' }), { status: 200 }));
  await secondWork;
  assert.equal(env.rows.challenges.length, 1);
});

test('JSON null and arrays receive safe public responses', async (context) => {
  const { env } = context;
  const nullRequest = new Request('https://site.test/api/newsletter/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
  const arrayRequest = new Request('https://site.test/api/newsletter/resend-confirmation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' });
  const subscribeResponse = await subscribe(publicContext(env, nullRequest));
  const resendResponse = await resendConfirmation(publicContext(env, arrayRequest));
  assert.equal(subscribeResponse.status, 400);
  assert.equal(resendResponse.status, 202);
});

test('one-click unsubscribe rejects invalid RFC 8058 request bodies before mutation', async (context) => {
  const { env } = context;
  const subscriber = env.seedSubscriber('reader@example.com');
  const token = await env.unsubscribeToken(subscriber);
  const url = `https://site.test/api/newsletter/unsubscribe?token=${token}`;
  const wrongType = new Request(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'List-Unsubscribe=One-Click' });
  const wrongValue = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=Nope' });
  assert.equal((await unsubscribeOneClick({ request: wrongType, env })).status, 400);
  assert.equal((await unsubscribeOneClick({ request: wrongValue, env })).status, 400);
  assert.equal(subscriber.status, 'active');
});

test('a concurrent activation cannot schedule a confirmation challenge that D1 did not store', async (context) => {
  const { env } = context;
  const subscriber = env.seedSubscriber('reader@example.com', 'pending');
  env.DB.onSubscriberUpsert = () => { subscriber.status = 'active'; };
  const response = await subscribeAndDrain(env, { email: subscriber.email, consent: true });
  assert.equal(response.status, 202);
  assert.equal(env.sentEmails.length, 0);
});

test('subscription schedules mail outside the public response and scheduled work can be drained', async (context) => {
  const { env } = context;
  const response = await subscribe(publicContext(env, jsonRequest('/api/newsletter/subscribe', { email: 'reader@example.com', consent: true })));
  assert.equal(response.status, 202);
  assert.equal(env.scheduled.length, 1);
  await env.drainScheduled();
  assert.equal(env.sentEmails.length, 1);
});

test('resend performs the same public D1 operation shape for pending and unknown emails', async () => {
  const pending = makeEnv();
  await pending.seedPending('reader@example.com');
  pending.DB.operations = [];
  const unknown = makeEnv();
  globalThis.fetch = async () => new Promise(() => {});
  await resendConfirmation(publicContext(pending, jsonRequest('/api/newsletter/resend-confirmation', { email: 'reader@example.com' })));
  await resendConfirmation(publicContext(unknown, jsonRequest('/api/newsletter/resend-confirmation', { email: 'unknown@example.com' })));
  assert.deepEqual(pending.DB.operations, unknown.DB.operations);
});

test('subscribe performs the same public D1 operation shape for pending and unknown emails', async () => {
  const pending = makeEnv();
  await pending.seedPending('reader@example.com');
  pending.DB.operations = [];
  const unknown = makeEnv();
  globalThis.fetch = async () => new Promise(() => {});
  await subscribe(publicContext(pending, jsonRequest('/api/newsletter/subscribe', { email: 'reader@example.com', consent: true })));
  await subscribe(publicContext(unknown, jsonRequest('/api/newsletter/subscribe', { email: 'unknown@example.com', consent: true })));
  assert.deepEqual(pending.DB.operations, unknown.DB.operations);
});
