import { currentUser, json } from '../auth.js';

export async function requireAdmin(request, env) {
  const user = await currentUser(request, env);
  if (!user) return { response: json({ error: 'Authentication required' }, 401) };
  if (!user.is_admin) return { response: json({ error: 'Administrator access required' }, 403) };
  return { user };
}
