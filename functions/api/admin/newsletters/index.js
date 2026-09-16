import { json } from '../../../../lib/auth.js';
import { requireAdmin } from '../../../../lib/newsletter/admin.js';
import { validateBlocks } from '../../../../lib/newsletter/content.js';

function objectBody(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function documentFrom(body) {
  if (!objectBody(body)) return { error: '요청 내용이 올바르지 않습니다.' };
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const previewText = typeof body.previewText === 'string' ? body.previewText.trim() : '';
  if (!subject || subject.length > 300) return { error: '제목을 300자 이내로 입력하세요.' };
  if (!previewText || previewText.length > 300) return { error: '미리보기 문구를 300자 이내로 입력하세요.' };
  const blocks = validateBlocks(body.blocks);
  if (!blocks.ok) return { error: blocks.errors.join(' ') };
  return { subject, previewText, blocks: blocks.blocks };
}

function newsletterRow(row) {
  if (!row) return null;
  let blocks;
  try { blocks = JSON.parse(row.content_json); } catch { return null; }
  return {
    id: row.id,
    subject: row.subject,
    previewText: row.preview_text,
    blocks,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
    authorEmail: row.author_email,
    targetCount: row.target_count,
  };
}

function pagination(request) {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get('limit');
  const rawOffset = url.searchParams.get('offset');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return null;
  return { limit, offset };
}

export async function onRequestGet({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;
  const page = pagination(request);
  if (!page) return json({ error: '페이지 정보가 올바르지 않습니다.' }, 400);
  try {
    const rows = await env.DB.prepare(`
      SELECT n.id, n.subject, n.preview_text, n.content_json, n.status, n.created_by, n.created_at, n.updated_at, n.sent_at,
             u.email AS author_email,
             (SELECT COUNT(*) FROM newsletter_deliveries d JOIN newsletter_sends s ON s.id = d.send_id WHERE s.newsletter_id = n.id) AS target_count
      FROM newsletters n JOIN users u ON u.id = n.created_by
      ORDER BY n.updated_at DESC, n.id DESC LIMIT ? OFFSET ?
    `).bind(page.limit, page.offset).all();
    return json({ newsletters: (rows.results || []).map(newsletterRow).filter(Boolean), ...page });
  } catch {
    return json({ error: '뉴스레터 목록을 불러오지 못했습니다.' }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;
  const parsed = documentFrom(await request.json().catch(() => null));
  if (parsed.error) return json({ error: parsed.error }, 400);
  try {
    const row = await env.DB.prepare(`
      INSERT INTO newsletters (subject, preview_text, content_json, status, created_by)
      VALUES (?, ?, ?, 'draft', ?)
      RETURNING id, subject, preview_text, content_json, status, created_by, created_at, updated_at, sent_at
    `).bind(parsed.subject, parsed.previewText, JSON.stringify(parsed.blocks), admin.user.id).first();
    return json({ newsletter: newsletterRow(row) }, 201);
  } catch {
    return json({ error: '뉴스레터 초안을 저장하지 못했습니다.' }, 500);
  }
}

export { documentFrom, newsletterRow, pagination };
