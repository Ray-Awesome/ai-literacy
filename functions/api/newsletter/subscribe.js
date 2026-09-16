import { EMAIL_RE, json } from '../../../lib/auth.js';
import { newsletterConfig } from '../../../lib/newsletter/config.js';
import { consumeRateLimit } from '../../../lib/newsletter/rate-limit.js';
import { retirePriorChallenges, sendEmail } from '../../../lib/newsletter/resend.js';
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

function scheduleConfirmation(waitUntil, env, message, subscriberId, tokenHash) {
  const work = sendEmail(env, message).then(
    () => retirePriorChallenges(env, subscriberId, tokenHash),
    () => undefined,
  ).catch(() => undefined);
  if (typeof waitUntil === 'function') waitUntil(work);
}

async function createChallenge(env, email, token) {
  const challengeStatement = env.DB.prepare(`
    INSERT INTO newsletter_confirmation_challenges (token_hash, subscriber_id, expires_at)
    SELECT ?, id, datetime('now', '+24 hours')
    FROM newsletter_subscribers
    WHERE email = ? AND status = 'pending'
    RETURNING subscriber_id
  `).bind(token.hash, email);
  const stateStatement = env.DB.prepare(`
    INSERT INTO newsletter_confirmation_delivery_state (subscriber_id, current_token_hash)
    SELECT id, ? FROM newsletter_subscribers
    WHERE email = ? AND status = 'pending'
      AND EXISTS (
        SELECT 1 FROM newsletter_confirmation_challenges
        WHERE subscriber_id = newsletter_subscribers.id AND token_hash = ?
      )
    ON CONFLICT(subscriber_id) DO UPDATE SET
      current_token_hash = excluded.current_token_hash, updated_at = datetime('now')
  `).bind(token.hash, email, token.hash);
  const [challenge, state] = await env.DB.batch([challengeStatement, stateStatement]);
  return state.meta?.changes === 1 ? challenge.results?.[0] : null;
}

export async function onRequestPost({ request, env, waitUntil }) {
  const body = objectBody(await request.json().catch(() => ({})));
  if (body.company) return json({ message: GENERIC_MESSAGE }, 202);

  const email = normalizedEmail(body.email);
  if (!EMAIL_RE.test(email)) return json({ error: '올바른 이메일 주소를 입력해 주세요.' }, 400);
  if (body.consent !== true) return json({ error: '개인정보 수집·이용에 동의해야 구독할 수 있습니다.' }, 400);
  if (await rateLimited(request, env, email)) return json({ message: GENERIC_MESSAGE }, 202);

  try {
    await env.DB.prepare(`
      DELETE FROM newsletter_confirmation_challenges
      WHERE subscriber_id IN (
        SELECT id FROM newsletter_subscribers WHERE email = ? AND status <> 'pending'
      )
    `).bind(email).run();
    const subscriber = await env.DB.prepare(`
      INSERT INTO newsletter_subscribers (email, status, consent_at)
      VALUES (?, 'pending', datetime('now'))
      ON CONFLICT(email) DO UPDATE SET
        status = CASE WHEN newsletter_subscribers.status IN ('active', 'bounced', 'complained') THEN newsletter_subscribers.status ELSE 'pending' END,
        consent_at = CASE WHEN newsletter_subscribers.status IN ('active', 'bounced', 'complained') THEN newsletter_subscribers.consent_at ELSE excluded.consent_at END,
        confirmed_at = CASE WHEN newsletter_subscribers.status IN ('pending', 'active', 'bounced', 'complained') THEN newsletter_subscribers.confirmed_at ELSE NULL END,
        confirmation_token_hash = CASE WHEN newsletter_subscribers.status IN ('pending', 'active', 'bounced', 'complained') THEN newsletter_subscribers.confirmation_token_hash ELSE NULL END,
        confirmation_expires_at = CASE WHEN newsletter_subscribers.status IN ('pending', 'active', 'bounced', 'complained') THEN newsletter_subscribers.confirmation_expires_at ELSE NULL END,
        updated_at = datetime('now')
      RETURNING id, status
    `).bind(email).first();
    const token = await newConfirmationToken();
    const challenge = await createChallenge(env, email, token);
    if (subscriber && challenge) {
      const config = newsletterConfig(env);
      scheduleConfirmation(waitUntil, env, confirmationMessage(config, email, token, challenge.subscriber_id), challenge.subscriber_id, token.hash);
    }
  } catch {
    // Keep the public response uniform and never expose provider failures or tokens.
  }
  return json({ message: GENERIC_MESSAGE }, 202);
}
