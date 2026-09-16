import { EMAIL_RE, calcAge, hashPassword, signToken, sessionCookie, json, secretOf, publicUser } from '../../lib/auth.js';

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const birthDate = String(b.birthDate || '').trim();

  if (!EMAIL_RE.test(email)) return json({ error: '올바른 이메일 주소를 입력해 주세요.' }, 400);
  if (password.length < 8) return json({ error: '비밀번호는 8자 이상이어야 합니다.' }, 400);
  const age = calcAge(birthDate);
  if (age === null || age < 0 || age > 120) return json({ error: '생년월일을 정확히 입력해 주세요.' }, 400);
  if (!b.agreeTerms || !b.agreePrivacy) return json({ error: '이용약관과 개인정보 수집·이용에 동의해야 가입할 수 있습니다.' }, 400);

  const isMinor = age < 14;
  let gName = null, gRel = null, gContact = null, gConsent = 0;
  if (isMinor) {
    gName = String(b.guardianName || '').trim();
    gRel = String(b.guardianRelation || '').trim();
    gContact = String(b.guardianContact || '').trim();
    gConsent = b.guardianConsent ? 1 : 0;
    if (!gName || !gContact) return json({ error: '만 14세 미만은 보호자(법정대리인) 이름과 연락처가 필요합니다.' }, 400);
    if (!gConsent) return json({ error: '만 14세 미만은 보호자(법정대리인)의 동의가 필요합니다.' }, 400);
  }

  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (exists) return json({ error: '이미 가입된 이메일입니다.' }, 409);

  const hash = await hashPassword(password);
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const adminEmail = (env.ADMIN_EMAIL || '').toLowerCase();
  const isAdmin = (cnt.n === 0 || (adminEmail && email === adminEmail)) ? 1 : 0;

  const res = await env.DB.prepare(
    `INSERT INTO users (email, password_hash, birth_date, is_minor, guardian_name, guardian_relation,
       guardian_contact, agreed_terms, agreed_privacy, guardian_consent, is_admin)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(email, hash, birthDate, isMinor ? 1 : 0, gName, gRel, gContact, 1, 1, gConsent, isAdmin).run();

  const id = res.meta.last_row_id;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  const token = await signToken({ uid: id, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }, secretOf(env));
  return json({ user: publicUser(user) }, 201, { 'Set-Cookie': sessionCookie(token) });
}
