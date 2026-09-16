import { EMAIL_RE, json } from '../../../../../lib/auth.js';
import { requireAdmin } from '../../../../../lib/newsletter/admin.js';
import { renderNewsletter } from '../../../../../lib/newsletter/content.js';
import { publicSiteUrl } from '../../../../../lib/newsletter/config.js';
import { sendEmail } from '../../../../../lib/newsletter/resend.js';
import { findNewsletter, newsletterId } from '../[id].js';

function testBanner(html) {
  const banner = '<div style="margin:0 0 20px;padding:12px 14px;border:2px solid #F97316;background:#FFF7ED;color:#9A3412;font:700 14px/1.4 Arial,sans-serif;">테스트 발송 — 실제 구독자에게는 발송되지 않았습니다.</div>';
  return html.replace(/<body([^>]*)>/i, '<body$1>' + banner);
}

export async function onRequestPost({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;
  const id = newsletterId(params?.id);
  if (!id) return json({ error: '뉴스레터 식별자가 올바르지 않습니다.' }, 400);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'email')) {
    return json({ error: '요청 내용이 올바르지 않습니다.' }, 400);
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) return json({ error: '테스트 수신 이메일 주소를 확인하세요.' }, 400);
  try {
    const newsletter = await findNewsletter(env, id);
    if (!newsletter) return json({ error: '뉴스레터를 찾을 수 없습니다.' }, 404);
    if (newsletter.status !== 'draft') return json({ error: '초안에서만 테스트 메일을 보낼 수 있습니다.' }, 409);
    const blocks = JSON.parse(newsletter.content_json);
    const rendered = renderNewsletter({
      subject: newsletter.subject,
      previewText: newsletter.preview_text,
      blocks,
      unsubscribeUrl: `${publicSiteUrl(env)}/newsletter-status.html`,
    });
    await sendEmail(env, {
      to: email,
      subject: `[테스트] ${newsletter.subject}`,
      html: testBanner(rendered.html),
      text: `[테스트 발송] 실제 구독자에게는 발송되지 않았습니다.\n\n${rendered.text}`,
      idempotencyKey: `newsletter-test-${id}-${crypto.randomUUID()}`,
    });
    return json({ message: '테스트 메일을 보냈습니다.' }, 202);
  } catch {
    return json({ error: '테스트 메일을 보내지 못했습니다. 설정을 확인한 뒤 다시 시도하세요.' }, 502);
  }
}
