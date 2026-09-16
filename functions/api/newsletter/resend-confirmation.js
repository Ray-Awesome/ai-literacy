import { EMAIL_RE, json } from '../../../lib/auth.js';
import { newsletterConfig } from '../../../lib/newsletter/config.js';
import { consumeRateLimit } from '../../../lib/newsletter/rate-limit.js';
import { sendEmail } from '../../../lib/newsletter/resend.js';
import { newConfirmationToken, sha256 } from '../../../lib/newsletter/tokens.js';

const GENERIC_MESSAGE = '확인할 수 있는 경우 구독 안내 메일을 보냈습니다.';

function objectBody(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function confirmationMessage(config, email, token, id) {
  const url = `${config.publicSiteUrl}/api/newsletter/confirm?token=${encodeURIComponent(token.raw)}`;
  return {
    to: email, from: config.from, subject: '에이릿 뉴스레터 구독 확인',
    html: `<p>에이릿 뉴스레터 구독을 확인해 주세요.</p><p><a href="${url}">구독 확인하기</a></p>`,
    text: `에이릿 뉴스레터 구독 확인: ${url}`,
    idempotencyKey: `newsletter-confirmation-${id}-${token.hash}`,
  };
}

export async function onRequestPost({ request, env, waitUntil }) {
  const body = objectBody(await request.json().catch(() => ({})));
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ message: GENERIC_MESSAGE }, 202);

  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const [emailHash, ipHash] = await Promise.all([sha256(email), sha256(ip)]);
    const [emailAllowed, ipAllowed] = await Promise.all([
      consumeRateLimit(env.DB, 'newsletter-resend-email', emailHash, 5, 60 * 60),
      consumeRateLimit(env.DB, 'newsletter-resend-ip', ipHash, 20, 60 * 60),
    ]);
    if (!emailAllowed || !ipAllowed) return json({ message: GENERIC_MESSAGE }, 202);

    const subscriber = await env.DB.prepare('SELECT id, status FROM newsletter_subscribers WHERE email = ?').bind(email).first();
    if (!subscriber || subscriber.status !== 'pending') return json({ message: GENERIC_MESSAGE }, 202);
    const token = await newConfirmationToken();
    const challenge = await env.DB.prepare(`
      INSERT INTO newsletter_confirmation_challenges (token_hash, subscriber_id, expires_at)
      SELECT ?, id, datetime('now', '+24 hours')
      FROM newsletter_subscribers
      WHERE email = ? AND status = 'pending'
    `).bind(token.hash, email).run();
    if (challenge.meta?.changes === 1) {
      const work = sendEmail(env, confirmationMessage(newsletterConfig(env), email, token, subscriber.id)).catch(() => undefined);
      if (typeof waitUntil === 'function') waitUntil(work);
    }
  } catch {
    // Enumeration-safe endpoint: do not reveal storage or mail delivery errors.
  }
  return json({ message: GENERIC_MESSAGE }, 202);
}
