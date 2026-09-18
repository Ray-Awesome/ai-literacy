import { json } from '../../../lib/auth.js';
import { newsletterTokenSecret, publicSiteUrl } from '../../../lib/newsletter/config.js';
import { verifyActionToken } from '../../../lib/newsletter/tokens.js';

async function unsubscribe(request, env) {
  const token = new URL(request.url).searchParams.get('token');
  const secret = newsletterTokenSecret(env);
  if (!token || !secret) return 'invalid';
  const action = await verifyActionToken(token, 'unsubscribe', secret);
  if (!action || !Number.isInteger(action.sid)) return 'invalid';
  try {
    await env.DB.prepare(`
      UPDATE newsletter_subscribers
      SET status = CASE WHEN status IN ('bounced', 'complained') THEN status ELSE 'unsubscribed' END,
          unsubscribed_at = CASE
            WHEN status IN ('bounced', 'complained') THEN unsubscribed_at
            ELSE COALESCE(unsubscribed_at, datetime('now'))
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(action.sid).run();
    return 'ok';
  } catch {
    return 'failed';
  }
}

export async function onRequestGet({ request, env }) {
  const result = await unsubscribe(request, env);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${publicSiteUrl(env)}/newsletter-status.html?state=${result === 'ok' ? 'unsubscribed' : result === 'failed' ? 'error' : 'invalid'}`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestPost({ request, env }) {
  const contentType = (request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded' || await request.text() !== 'List-Unsubscribe=One-Click') {
    return json({ error: 'Invalid one-click unsubscribe request.' }, 400);
  }
  const result = await unsubscribe(request, env);
  if (result === 'failed') return json({ error: 'Unsubscribe is temporarily unavailable. Please retry.' }, 503, { 'Retry-After': '60' });
  return json({ ok: true });
}
