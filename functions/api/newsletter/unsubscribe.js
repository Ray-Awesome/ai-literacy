import { json } from '../../../lib/auth.js';
import { publicSiteUrl } from '../../../lib/newsletter/config.js';
import { verifyActionToken } from '../../../lib/newsletter/tokens.js';

async function unsubscribe(request, env) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token || !env?.SESSION_SECRET) return false;
  const action = await verifyActionToken(token, 'unsubscribe', env.SESSION_SECRET);
  if (!action || !Number.isInteger(action.sid)) return false;
  try {
    await env.DB.prepare(`
      UPDATE newsletter_subscribers
      SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, datetime('now')), updated_at = datetime('now')
      WHERE id = ?
    `).bind(action.sid).run();
    return true;
  } catch {
    return false;
  }
}

export async function onRequestGet({ request, env }) {
  const ok = await unsubscribe(request, env);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${publicSiteUrl(env)}/newsletter-status.html?state=${ok ? 'unsubscribed' : 'invalid'}`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestPost({ request, env }) {
  await unsubscribe(request, env);
  return json({ ok: true });
}
