import { currentUser, json } from '../../lib/auth.js';

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: '로그인이 필요합니다.' }, 401);

  const b = await request.json().catch(() => ({}));
  const itemKey = String(b.itemKey || '').trim().slice(0, 200);
  const answer = String(b.answer || '');
  const prompt = b.prompt != null ? String(b.prompt).slice(0, 1000) : null;
  const pageUrl = b.pageUrl != null ? String(b.pageUrl).slice(0, 500) : null;
  if (!itemKey) return json({ error: '문항 식별 키(itemKey)가 필요합니다.' }, 400);
  if (!answer.trim()) return json({ error: '저장할 답변 내용이 없습니다.' }, 400);

  await env.DB.prepare(
    `INSERT INTO answers (user_id, item_key, prompt, answer, page_url, updated_at)
     VALUES (?,?,?,?,?, datetime('now'))
     ON CONFLICT(user_id, item_key)
     DO UPDATE SET answer = excluded.answer, prompt = excluded.prompt,
                   page_url = excluded.page_url, updated_at = datetime('now')`
  ).bind(user.id, itemKey, prompt, answer, pageUrl).run();

  const saved = await env.DB.prepare('SELECT * FROM answers WHERE user_id = ? AND item_key = ?')
    .bind(user.id, itemKey).first();
  return json({ answer: saved });
}

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: '로그인이 필요합니다.' }, 401);
  const rows = await env.DB.prepare(
    'SELECT id, item_key, prompt, answer, page_url, updated_at FROM answers WHERE user_id = ? ORDER BY updated_at DESC'
  ).bind(user.id).all();
  return json({ answers: rows.results || [] });
}
