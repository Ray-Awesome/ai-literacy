import { json } from '../../../lib/auth.js';
import { requireAdmin } from '../../../lib/newsletter/admin.js';
import { pagination } from './newsletters/index.js';

function publicSubscriber(row) {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    consentAt: row.consent_at,
    confirmedAt: row.confirmed_at,
    unsubscribedAt: row.unsubscribed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function onRequestGet({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;
  const summary = new URL(request.url).searchParams.get('summary');
  if (summary && summary !== 'active') return json({ error: '요약 정보가 올바르지 않습니다.' }, 400);
  if (summary === 'active') {
    try {
      const row = await env.DB.prepare(`
        SELECT COUNT(*) AS active_count FROM newsletter_subscribers WHERE status = 'active'
      `).bind().first();
      return json({ activeCount: Number(row?.active_count || 0) });
    } catch {
      return json({ error: '활성 구독자 수를 불러오지 못했습니다.' }, 500);
    }
  }
  const page = pagination(request);
  if (!page) return json({ error: '페이지 정보가 올바르지 않습니다.' }, 400);
  try {
    const rows = await env.DB.prepare(`
      SELECT id, email, status, consent_at, confirmed_at, unsubscribed_at, created_at, updated_at
      FROM newsletter_subscribers
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).bind(page.limit, page.offset).all();
    return json({ subscribers: (rows.results || []).map(publicSubscriber), ...page });
  } catch {
    return json({ error: '구독자 목록을 불러오지 못했습니다.' }, 500);
  }
}
