import { json } from '../../../../../lib/auth.js';
import { requireAdmin } from '../../../../../lib/newsletter/admin.js';
import { validateBlocks } from '../../../../../lib/newsletter/content.js';
import { findNewsletter, newsletterId } from '../[id].js';
import { idempotencyKey, queueExistingSend } from './send.js';

function retrySendId(body) {
  const value = body?.sendId;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validFrozenContent(newsletter) {
  try { return validateBlocks(JSON.parse(newsletter.content_json)).ok; } catch { return false; }
}

async function findRetrySource(env, sendId, newsletterIdValue) {
  return env.DB.prepare(`
    SELECT id, newsletter_id, status FROM newsletter_sends
    WHERE id = ? AND newsletter_id = ? AND status IN ('partial', 'failed')
  `).bind(sendId, newsletterIdValue).first();
}

async function createRetrySend(env, sourceId, newsletterIdValue, key) {
  const result = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO newsletter_sends (newsletter_id, idempotency_key, status, started_at, source_send_id)
      SELECT ?, ?, 'queued', datetime('now'), ?
      WHERE EXISTS (SELECT 1 FROM newsletter_sends WHERE id = ? AND newsletter_id = ? AND status IN ('partial', 'failed'))
        AND EXISTS (
          SELECT 1 FROM newsletter_deliveries AS delivery
          JOIN newsletter_subscribers AS subscriber ON subscriber.id = delivery.subscriber_id
          WHERE delivery.send_id = ? AND delivery.status = 'failed' AND delivery.delivery_certainty = 'known' AND subscriber.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM newsletter_deliveries AS prior
              JOIN newsletter_sends AS prior_send ON prior_send.id = prior.send_id
              WHERE prior_send.newsletter_id = ? AND prior.subscriber_id = delivery.subscriber_id
                AND prior.send_id <> delivery.send_id
                AND (prior.status IN ('pending', 'sent') OR prior.delivery_certainty = 'indeterminate')
            )
        )
      RETURNING id, newsletter_id, status
    `).bind(newsletterIdValue, key, sourceId, sourceId, newsletterIdValue, sourceId, newsletterIdValue),
    env.DB.prepare(`
      INSERT INTO newsletter_deliveries (send_id, subscriber_id, status)
      SELECT retry.id, delivery.subscriber_id, 'pending'
      FROM newsletter_sends AS retry JOIN newsletter_deliveries AS delivery
        ON retry.idempotency_key = ?
      JOIN newsletter_subscribers AS subscriber ON subscriber.id = delivery.subscriber_id
      WHERE delivery.send_id = ? AND delivery.status = 'failed' AND delivery.delivery_certainty = 'known' AND subscriber.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM newsletter_deliveries AS prior
          JOIN newsletter_sends AS prior_send ON prior_send.id = prior.send_id
          WHERE prior_send.newsletter_id = ? AND prior.subscriber_id = delivery.subscriber_id
            AND prior.send_id <> delivery.send_id
            AND (prior.status IN ('pending', 'sent') OR prior.delivery_certainty = 'indeterminate')
        )
      ON CONFLICT(send_id, subscriber_id) DO NOTHING
    `).bind(key, sourceId, newsletterIdValue),
    env.DB.prepare(`
      UPDATE newsletter_sends
      SET target_count = (SELECT COUNT(*) FROM newsletter_deliveries WHERE send_id = newsletter_sends.id)
      WHERE idempotency_key = ?
    `).bind(key),
    env.DB.prepare(`
      UPDATE newsletters SET status = 'sending', updated_at = datetime('now')
      WHERE id = ? AND status <> 'draft' AND EXISTS (SELECT 1 FROM newsletter_sends WHERE idempotency_key = ?)
    `).bind(newsletterIdValue, key),
  ]);
  return result?.[0]?.results?.[0] || null;
}

export async function onRequestPost({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;
  const newsletterIdValue = newsletterId(params?.id);
  if (!newsletterIdValue) return json({ error: '뉴스레터 식별자가 올바르지 않습니다.' }, 400);
  const key = idempotencyKey(request);
  if (!key) return json({ error: '유효한 Idempotency-Key 헤더가 필요합니다.' }, 400);
  const sourceId = retrySendId(await request.json().catch(() => null));
  if (!sourceId) return json({ error: '재시도할 발송 식별자가 올바르지 않습니다.' }, 400);

  try {
    let send = await env.DB.prepare(`
      SELECT id, newsletter_id, status, source_send_id FROM newsletter_sends WHERE idempotency_key = ?
    `).bind(key).first();
    if (send && (send.newsletter_id !== newsletterIdValue || send.source_send_id !== sourceId)) return json({ error: 'Idempotency-Key가 다른 재시도 요청에 사용되었습니다.' }, 409);
    if (!send) {
      const [newsletter, source] = await Promise.all([
        findNewsletter(env, newsletterIdValue), findRetrySource(env, sourceId, newsletterIdValue),
      ]);
      if (!newsletter || !source) return json({ error: '재시도할 실패 발송을 찾을 수 없습니다.' }, 404);
      if (!validFrozenContent(newsletter)) return json({ error: '고정된 뉴스레터 내용이 올바르지 않습니다.' }, 409);
      try {
        send = await createRetrySend(env, source.id, newsletterIdValue, key);
      } catch {
        send = await env.DB.prepare(`SELECT id, newsletter_id, status, source_send_id FROM newsletter_sends WHERE idempotency_key = ?`).bind(key).first();
      }
    }
    if (!send) return json({ error: '현재 재시도할 수 있는 실패 수신자가 없습니다.' }, 409);
    const queued = await queueExistingSend(env, send.id);
    if (queued.error) return json({ error: '재시도 대기열 등록에 실패했습니다. 같은 키로 다시 시도하세요.' }, 503);
    return json({ sendId: send.id, queued: queued.queued }, 202);
  } catch {
    return json({ error: '실패한 수신자 재시도를 시작하지 못했습니다.' }, 500);
  }
}
