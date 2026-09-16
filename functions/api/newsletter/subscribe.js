import { EMAIL_RE, json } from '../../../lib/auth.js';
import { newsletterConfig } from '../../../lib/newsletter/config.js';
import { consumeRateLimit } from '../../../lib/newsletter/rate-limit.js';
import { sendEmail } from '../../../lib/newsletter/resend.js';
import { newConfirmationToken, sha256 } from '../../../lib/newsletter/tokens.js';

const GENERIC_MESSAGE = '확인할 수 있는 경우 구독 안내 메일을 보냈습니다.';

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function objectBody(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function rateLimited(request, env, email) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const [emailHash, ipHash] = await Promise.all([sha256(email), sha256(ip)]);
  const [emailAllowed, ipAllowed] = await Promise.all([
    consumeRateLimit(env.DB, 'newsletter-subscribe-email', emailHash, 5, 60 * 60),
    consumeRateLimit(env.DB, 'newsletter-subscribe-ip', ipHash, 20, 60 * 60),
  ]);
  return !emailAllowed || !ipAllowed;
}

function confirmationMessage(config, email, token, id) {
  const url = `${config.publicSiteUrl}/api/newsletter/confirm?token=${encodeURIComponent(token.raw)}`;
  return {
    to: email,
    from: config.from,
    subject: '에이릿 뉴스레터 구독 확인',
    html: `<p>에이릿 뉴스레터 구독을 확인해 주세요.</p><p><a href="${url}">구독 확인하기</a></p>`,
    text: `에이릿 뉴스레터 구독 확인: ${url}`,
    idempotencyKey: `newsletter-confirmation-${id}-${token.hash}`,
  };
}

function scheduleConfirmation(waitUntil, env, message) {
  const work = sendEmail(env, message).catch(() => undefined);
  if (typeof waitUntil === 'function') waitUntil(work);
}

async function pendingSubscriber(env, email) {
  let subscriber = await env.DB.prepare('SELECT id, status FROM newsletter_subscribers WHERE email = ?').bind(email).first();
  if (subscriber?.status === 'active') return null;

  if (subscriber) {
    const wasPending = subscriber.status === 'pending';
    if (!wasPending) {
      await env.DB.prepare('DELETE FROM newsletter_confirmation_challenges WHERE subscriber_id = ?').bind(subscriber.id).run();
    }
    const changed = await env.DB.prepare(wasPending ? `
      UPDATE newsletter_subscribers
      SET status = 'pending', consent_at = datetime('now'), confirmed_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status <> 'active'
    ` : `
      UPDATE newsletter_subscribers
      SET status = 'pending', consent_at = datetime('now'), confirmed_at = NULL,
          confirmation_token_hash = NULL, confirmation_expires_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status <> 'active'
    `).bind(subscriber.id).run();
    if (changed.meta?.changes !== 1) return null;
    return subscriber;
  }

  const inserted = await env.DB.prepare(`
    INSERT INTO newsletter_subscribers (email, status, consent_at)
    VALUES (?, 'pending', datetime('now'))
  `).bind(email).run();
  subscriber = await env.DB.prepare('SELECT id, status FROM newsletter_subscribers WHERE email = ?').bind(email).first();
  if (!subscriber || subscriber.status === 'active') return null;
  if (inserted.meta?.changes !== 1) {
    const wasPending = subscriber.status === 'pending';
    if (!wasPending) {
      await env.DB.prepare('DELETE FROM newsletter_confirmation_challenges WHERE subscriber_id = ?').bind(subscriber.id).run();
    }
    const changed = await env.DB.prepare(wasPending ? `
      UPDATE newsletter_subscribers
      SET status = 'pending', consent_at = datetime('now'), confirmed_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status <> 'active'
    ` : `
      UPDATE newsletter_subscribers
      SET status = 'pending', consent_at = datetime('now'), confirmed_at = NULL,
          confirmation_token_hash = NULL, confirmation_expires_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status <> 'active'
    `).bind(subscriber.id).run();
    if (changed.meta?.changes !== 1) return null;
  }
  return subscriber;
}

async function createChallenge(env, email, token) {
  return env.DB.prepare(`
    INSERT INTO newsletter_confirmation_challenges (token_hash, subscriber_id, expires_at)
    SELECT ?, id, datetime('now', '+24 hours')
    FROM newsletter_subscribers
    WHERE email = ? AND status = 'pending'
  `).bind(token.hash, email).run();
}

export async function onRequestPost({ request, env, waitUntil }) {
  const body = objectBody(await request.json().catch(() => ({})));
  if (body.company) return json({ message: GENERIC_MESSAGE }, 202);

  const email = normalizedEmail(body.email);
  if (!EMAIL_RE.test(email)) return json({ error: '올바른 이메일 주소를 입력해 주세요.' }, 400);
  if (body.consent !== true) return json({ error: '개인정보 수집·이용에 동의해야 구독할 수 있습니다.' }, 400);
  if (await rateLimited(request, env, email)) return json({ message: GENERIC_MESSAGE }, 202);

  try {
    const subscriber = await pendingSubscriber(env, email);
    if (!subscriber) return json({ message: GENERIC_MESSAGE }, 202);
    const token = await newConfirmationToken();
    const challenge = await createChallenge(env, email, token);
    if (challenge.meta?.changes !== 1) return json({ message: GENERIC_MESSAGE }, 202);
    const config = newsletterConfig(env);
    scheduleConfirmation(waitUntil, env, confirmationMessage(config, email, token, subscriber.id));
  } catch {
    // Keep the public response uniform and never expose provider failures or tokens.
  }
  return json({ message: GENERIC_MESSAGE }, 202);
}
