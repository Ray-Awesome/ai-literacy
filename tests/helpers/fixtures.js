import { newConfirmationToken, signActionToken } from '../../lib/newsletter/tokens.js';
import { FakeD1 } from './fake-d1.js';

export function jsonRequest(path, body, options = {}) {
  return new Request(`https://site.test${path}`, {
    method: options.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': options.ip || '203.0.113.42',
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

export function makeEnv() {
  const rows = { subscribers: [], challenges: [] };
  const db = new FakeD1(rows);
  const env = {
    DB: db,
    NEWSLETTER_FROM: 'AILIT <newsletter@site.test>',
    PUBLIC_SITE_URL: 'https://site.test',
    RESEND_API_KEY: 're_test_key',
    SESSION_SECRET: 'test-secret-at-least-32-characters',
    rows,
    sentEmails: [],
    rateLimits: db.rateLimits,
    scheduled: [],
  };
  env.waitUntil = (work) => env.scheduled.push(Promise.resolve(work));
  env.drainScheduled = async () => {
    while (env.scheduled.length) await Promise.allSettled(env.scheduled.splice(0));
  };
  env.seedPending = async (email, expiration = '2999-01-01 00:00:00') => {
    const token = await newConfirmationToken();
    rows.subscribers.push({
      id: db.nextSubscriberId++, email, status: 'pending', consent_at: '2026-09-16 00:00:00',
      confirmation_token_hash: token.hash, confirmation_expires_at: expiration,
    });
    rows.challenges.push({ subscriber_id: db.nextSubscriberId - 1, token_hash: token.hash, expires_at: expiration });
    return token.raw;
  };
  env.seedSubscriber = (email, status = 'active') => {
    const subscriber = { id: db.nextSubscriberId++, email, status, consent_at: '2026-09-16 00:00:00' };
    rows.subscribers.push(subscriber);
    return subscriber;
  };
  env.seedLegacyPending = async (email) => {
    const token = await newConfirmationToken();
    rows.subscribers.push({
      id: db.nextSubscriberId++, email, status: 'pending', consent_at: '2026-09-16 00:00:00',
      confirmation_token_hash: token.hash, confirmation_expires_at: '2999-01-01 00:00:00',
    });
    return token.raw;
  };
  env.unsubscribeToken = (subscriber) => signActionToken({
    sid: subscriber.id, purpose: 'unsubscribe', exp: Math.floor(Date.now() / 1000) + 3600,
  }, env.SESSION_SECRET);
  return env;
}
