import { json } from '../../../lib/auth.js';
import { requireAdmin } from '../../../lib/newsletter/admin.js';
import { pagination } from './newsletters/index.js';

function publicSend(row) {
  return {
    id: row.id,
    newsletterId: row.newsletter_id,
    subject: row.subject,
    status: row.status,
    targetCount: row.target_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    retryableFailureCount: row.retryable_failure_count,
    indeterminateCount: row.indeterminate_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function publicDelivery(row) {
  return {
    id: row.id,
    sendId: row.send_id,
    subscriberId: row.subscriber_id,
    email: row.email,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    certainty: row.delivery_certainty,
    sentAt: row.sent_at,
    updatedAt: row.updated_at,
  };
}

function queryId(request, name) {
  const value = new URL(request.url).searchParams.get(name);
  if (value === null) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function onRequestGet({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;
  const page = pagination(request);
  if (!page) return json({ error: '페이지 정보가 올바르지 않습니다.' }, 400);
  const sendId = queryId(request, 'sendId');
  if (sendId === null) return json({ error: '발송 식별자가 올바르지 않습니다.' }, 400);
  try {
    if (sendId) {
      const rows = await env.DB.prepare(`
        SELECT d.id, d.send_id, d.subscriber_id, sub.email, d.status, d.error_code, d.error_message, d.delivery_certainty, d.sent_at, d.updated_at
        FROM newsletter_deliveries d JOIN newsletter_subscribers sub ON sub.id = d.subscriber_id
        WHERE d.send_id = ?
        ORDER BY d.id DESC LIMIT ? OFFSET ?
      `).bind(sendId, page.limit, page.offset).all();
      return json({ deliveries: (rows.results || []).map(publicDelivery), sendId, ...page });
    }
    const rows = await env.DB.prepare(`
      SELECT s.id, s.newsletter_id, n.subject, s.status, s.target_count, s.success_count, s.failure_count, s.started_at, s.completed_at,
        COALESCE(SUM(CASE WHEN d.status = 'failed' AND d.delivery_certainty = 'known' THEN 1 ELSE 0 END), 0) AS retryable_failure_count,
        COALESCE(SUM(CASE WHEN d.delivery_certainty = 'indeterminate' THEN 1 ELSE 0 END), 0) AS indeterminate_count
      FROM newsletter_sends s JOIN newsletters n ON n.id = s.newsletter_id
      LEFT JOIN newsletter_deliveries d ON d.send_id = s.id
      GROUP BY s.id
      ORDER BY s.started_at DESC, s.id DESC LIMIT ? OFFSET ?
    `).bind(page.limit, page.offset).all();
    return json({ sends: (rows.results || []).map(publicSend), ...page });
  } catch {
    return json({ error: '발송 기록을 불러오지 못했습니다.' }, 500);
  }
}
