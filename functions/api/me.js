import { currentUser, json, publicUser } from '../../lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: '로그인이 필요합니다.' }, 401);
  return json({ user: publicUser(user) });
}
