import { publicSiteUrl } from '../../../lib/newsletter/config.js';
import { sha256 } from '../../../lib/newsletter/tokens.js';

function redirect(env, state) {
  return new Response(null, {
    status: 302,
    headers: { Location: `${publicSiteUrl(env)}/newsletter-status.html?state=${state}`, 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ request, env }) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return redirect(env, 'invalid');

  try {
    const tokenHash = await sha256(token);
    const challenge = await env.DB.prepare(`
      UPDATE newsletter_subscribers
      SET status = 'active', confirmed_at = datetime('now'), confirmation_token_hash = NULL,
          confirmation_expires_at = NULL, updated_at = datetime('now')
      WHERE status = 'pending' AND id = (
        SELECT subscriber_id FROM newsletter_confirmation_challenges
        WHERE token_hash = ? AND expires_at > datetime('now')
      )
      RETURNING id
    `).bind(tokenHash).first();
    const legacySubscriber = challenge ? null : await env.DB.prepare(`
      UPDATE newsletter_subscribers
      SET status = 'active', confirmed_at = datetime('now'), confirmation_token_hash = NULL,
          confirmation_expires_at = NULL, updated_at = datetime('now')
      WHERE status = 'pending' AND confirmation_token_hash = ?
        AND confirmation_expires_at > datetime('now')
      RETURNING id
    `).bind(tokenHash).first();
    const subscriberId = challenge?.id || legacySubscriber?.id;
    if (!subscriberId) return redirect(env, 'invalid');
    await env.DB.prepare(`
      DELETE FROM newsletter_confirmation_challenges
      WHERE subscriber_id = ?
        AND EXISTS (SELECT 1 FROM newsletter_subscribers WHERE id = ? AND status = 'active')
    `).bind(subscriberId, subscriberId).run();
    await env.DB.prepare(`
      DELETE FROM newsletter_confirmation_delivery_state
      WHERE subscriber_id = ?
        AND EXISTS (SELECT 1 FROM newsletter_subscribers WHERE id = ? AND status = 'active')
    `).bind(subscriberId, subscriberId).run();
    return redirect(env, 'confirmed');
  } catch {
    return redirect(env, 'invalid');
  }
}
