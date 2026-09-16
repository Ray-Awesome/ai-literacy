import { json } from '../../../../lib/auth.js';
import { requireAdmin } from '../../../../lib/newsletter/admin.js';
import { documentFrom, newsletterRow } from './index.js';

function newsletterId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function findNewsletter(env, id) {
  return env.DB.prepare(`
    SELECT id, subject, preview_text, content_json, status, created_by, created_at, updated_at, sent_at
    FROM newsletters WHERE id = ?
  `).bind(id).first();
}

export async function onRequestGet({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;
  const id = newsletterId(params?.id);
  if (!id) return json({ error: '뉴스레터 식별자가 올바르지 않습니다.' }, 400);
  try {
    const row = await findNewsletter(env, id);
    if (!row) return json({ error: '뉴스레터를 찾을 수 없습니다.' }, 404);
    const newsletter = newsletterRow(row);
    if (!newsletter) return json({ error: '뉴스레터 내용이 올바르지 않습니다.' }, 500);
    return json({ newsletter });
  } catch {
    return json({ error: '뉴스레터를 불러오지 못했습니다.' }, 500);
  }
}

export async function onRequestPut({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;
  const id = newsletterId(params?.id);
  if (!id) return json({ error: '뉴스레터 식별자가 올바르지 않습니다.' }, 400);
  const parsed = documentFrom(await request.json().catch(() => null));
  if (parsed.error) return json({ error: parsed.error }, 400);
  try {
    const current = await findNewsletter(env, id);
    if (!current) return json({ error: '뉴스레터를 찾을 수 없습니다.' }, 404);
    if (current.status !== 'draft') return json({ error: '발송이 시작된 뉴스레터는 수정할 수 없습니다.' }, 409);
    const updated = await env.DB.prepare(`
      UPDATE newsletters SET subject = ?, preview_text = ?, content_json = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'draft'
      RETURNING id, subject, preview_text, content_json, status, created_by, created_at, updated_at, sent_at
    `).bind(parsed.subject, parsed.previewText, JSON.stringify(parsed.blocks), id).first();
    if (!updated) return json({ error: '발송이 시작된 뉴스레터는 수정할 수 없습니다.' }, 409);
    return json({ newsletter: newsletterRow(updated) });
  } catch {
    return json({ error: '뉴스레터 초안을 저장하지 못했습니다.' }, 500);
  }
}

export { newsletterId, findNewsletter };
