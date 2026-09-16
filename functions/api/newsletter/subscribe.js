import { EMAIL_RE, json } from '../../../lib/auth.js';
import { newsletterConfig } from '../../../lib/newsletter/config.js';
import { consumeRateLimit } from '../../../lib/newsletter/rate-limit.js';
import { sendEmail } from '../../../lib/newsletter/resend.js';
import { newConfirmationToken, sha256 } from '../../../lib/newsletter/tokens.js';

const GENERIC_MESSAGE = '확인할 수 있는 경우 구독 안내 메일을 보냈습니다.';

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
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

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  if (body.company) return json({ message: GENERIC_MESSAGE }, 202);

  const email = normalizedEmail(body.email);
  if (!EMAIL_RE.test(email)) return json({ error: '올바른 이메일 주소를 입력해 주세요.' }, 400);
  if (body.consent !== true) return json({ error: '개인정보 수집·이용에 동의해야 구독할 수 있습니다.' }, 400);
  if (await rateLimited(request, env, email)) return json({ message: GENERIC_MESSAGE }, 202);

  let existing;
  try {
    existing = await env.DB.prepare('SELECT id, status FROM newsletter_subscribers WHERE email = ?').bind(email).first();
  } catch {
    return json({ message: GENERIC_MESSAGE }, 202);
  }
  if (existing?.status === 'active') return json({ message: GENERIC_MESSAGE }, 202);

  const token = await newConfirmationToken();
  let subscriberId = existing?.id;
  try {
    if (existing) {
      await env.DB.prepare(`
        UPDATE newsletter_subscribers
        SET status = 'pending', consent_at = datetime('now'), confirmed_at = NULL,
            confirmation_token_hash = ?, confirmation_expires_at = datetime('now', '+24 hours'), updated_at = datetime('now')
        WHERE email = ? AND status <> 'active'
      `).bind(token.hash, email).run();
    } else {
      await env.DB.prepare(`
        INSERT INTO newsletter_subscribers (email, status, consent_at, confirmation_token_hash, confirmation_expires_at)
        VALUES (?, 'pending', datetime('now'), ?, datetime('now', '+24 hours'))
      `).bind(email, token.hash).run();
      const created = await env.DB.prepare('SELECT id, status FROM newsletter_subscribers WHERE email = ?').bind(email).first();
      subscriberId = created?.id;
    }
    const config = newsletterConfig(env);
    await sendEmail(env, confirmationMessage(config, email, token, subscriberId));
  } catch {
    // Keep the public response uniform and never expose provider failures or tokens.
  }
  return json({ message: GENERIC_MESSAGE }, 202);
}
