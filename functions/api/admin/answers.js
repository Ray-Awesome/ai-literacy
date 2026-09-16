import { currentUser, json } from '../../../lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: '로그인이 필요합니다.' }, 401);
  if (!user.is_admin) return json({ error: '관리자만 접근할 수 있습니다.' }, 403);

  const rows = await env.DB.prepare(
    `SELECT a.id, u.email, a.item_key, a.prompt, a.answer, a.page_url, a.updated_at
     FROM answers a JOIN users u ON u.id = a.user_id
     ORDER BY a.updated_at DESC LIMIT 1000`
  ).all();
  return json({ answers: rows.results || [] });
}
