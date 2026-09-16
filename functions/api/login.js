import { verifyPassword, signToken, sessionCookie, json, secretOf, publicUser } from '../../lib/auth.js';

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401);
  }
  const token = await signToken({ uid: user.id, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }, secretOf(env));
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token) });
}
