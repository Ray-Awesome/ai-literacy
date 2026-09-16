const enc = new TextEncoder();
const dec = new TextDecoder();

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ITERATIONS = 100000;

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function ub64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(bits)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, iterStr, saltB, hashB] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const iterations = parseInt(iterStr, 10);
    const salt = ub64url(saltB);
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
    const a = new Uint8Array(bits);
    const b = ub64url(hashB);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch { return false; }
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return body + '.' + b64url(sig);
}
export async function verifyToken(token, secret) {
  try {
    const [body, sigB] = String(token).split('.');
    if (!body || !sigB) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), ub64url(sigB), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(ub64url(body)));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

export function getCookie(request, name) {
  const h = request.headers.get('Cookie') || '';
  const m = h.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
export function sessionCookie(token) {
  return `ailit_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`;
}
export function clearCookie() {
  return 'ailit_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
export function calcAge(birthDate) {
  const b = new Date(birthDate);
  if (isNaN(b)) return null;
  const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  const m = n.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
  return a;
}
export function secretOf(env) {
  return (env && env.SESSION_SECRET) || 'dev-insecure-secret-change-me';
}
export function publicUser(u) {
  return { id: u.id, email: u.email, isMinor: !!u.is_minor, isAdmin: !!u.is_admin, createdAt: u.created_at };
}

export async function currentUser(request, env) {
  const token = getCookie(request, 'ailit_session');
  if (!token) return null;
  const payload = await verifyToken(token, secretOf(env));
  if (!payload || !payload.uid) return null;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.uid).first();
  return user || null;
}
