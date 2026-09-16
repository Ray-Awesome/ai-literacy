import { currentUser, json } from '../auth.js';

export async function requireAdmin(request, env) {
  if (typeof env?.SESSION_SECRET !== 'string' || !env.SESSION_SECRET.trim() || env.SESSION_SECRET === 'dev-insecure-secret-change-me') {
    return { response: json({ error: 'Newsletter administration is unavailable' }, 503) };
  }

  const user = await currentUser(request, env);
  if (!user) return { response: json({ error: 'Authentication required' }, 401) };
  if (!user.is_admin) return { response: json({ error: 'Administrator access required' }, 403) };
  return { user };
}
