import { currentUser, json } from '../../../lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: '로그인이 필요합니다.' }, 401);
  if (!user.is_admin) return json({ error: '관리자만 접근할 수 있습니다.' }, 403);

  const rows = await env.DB.prepare(
    `SELECT id, email, birth_date, is_minor, guardian_name, guardian_relation, guardian_contact,
       guardian_consent, is_admin, created_at,
       (SELECT COUNT(*) FROM answers a WHERE a.user_id = users.id) AS answer_count
     FROM users ORDER BY created_at DESC`
  ).all();
  return json({ users: rows.results || [] });
}
