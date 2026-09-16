import { json } from '../../../../../lib/auth.js';
import { requireAdmin } from '../../../../../lib/newsletter/admin.js';
import { validateBlocks } from '../../../../../lib/newsletter/content.js';
import { findNewsletter, newsletterId } from '../[id].js';

const MAX_BATCH_SIZE = 100;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;

function idempotencyKey(request) {
  const value = request.headers.get('Idempotency-Key') || '';
  return IDEMPOTENCY_KEY.test(value) ? value : null;
}

function chunks(values) {
  const result = [];
  for (let index = 0; index < values.length; index += MAX_BATCH_SIZE) result.push(values.slice(index, index + MAX_BATCH_SIZE));
  return result;
}

function batchRow(result, index = 0) {
  return result?.[index]?.results?.[0] || null;
}

async function pendingDeliveryIds(env, sendId) {
  const result = await env.DB.prepare(`
    SELECT id FROM newsletter_deliveries
    WHERE send_id = ? AND status = 'pending' AND queued_at IS NULL
    ORDER BY id ASC
  `).bind(sendId).all();
  return (result.results || []).map((row) => row.id).filter((id) => Number.isSafeInteger(id) && id > 0);
}

async function markQueued(env, sendId, deliveryIds) {
  const placeholders = deliveryIds.map(() => '?').join(', ');
  await env.DB.prepare(`
    UPDATE newsletter_deliveries
    SET queued_at = datetime('now'), updated_at = datetime('now')
    WHERE send_id = ? AND status = 'pending' AND queued_at IS NULL AND id IN (${placeholders})
  `).bind(sendId, ...deliveryIds).run();
}

async function enqueuePending(env, sendId) {
  if (!env?.NEWSLETTER_QUEUE || typeof env.NEWSLETTER_QUEUE.send !== 'function') {
    throw new Error('Queue producer is unavailable');
  }
  const ids = await pendingDeliveryIds(env, sendId);
  for (const deliveryIds of chunks(ids)) {
    await env.NEWSLETTER_QUEUE.send({ sendId, deliveryIds });
    await markQueued(env, sendId, deliveryIds);
  }
  await env.DB.prepare(`
    UPDATE newsletter_sends
    SET status = 'queued', completed_at = NULL
    WHERE id = ? AND status IN ('queued', 'failed')
  `).bind(sendId).run();
  return ids.length;
}

async function markQueueFailure(env, sendId) {
  await env.DB.prepare(`
    UPDATE newsletter_sends SET status = 'failed', completed_at = datetime('now')
    WHERE id = ? AND status IN ('queued', 'failed')
  `).bind(sendId).run();
}

function validFrozenContent(newsletter) {
  try {
    const blocks = JSON.parse(newsletter.content_json);
    return validateBlocks(blocks).ok;
  } catch {
    return false;
  }
}

async function findSendByKey(env, key) {
  return env.DB.prepare(`
    SELECT id, newsletter_id, status FROM newsletter_sends WHERE idempotency_key = ?
  `).bind(key).first();
}

async function createInitialSend(env, newsletterIdValue, key) {
  const operations = [
    env.DB.prepare(`
      INSERT INTO newsletter_sends (newsletter_id, idempotency_key, status, started_at)
      SELECT id, ?, 'queued', datetime('now') FROM newsletters
      WHERE id = ? AND status = 'draft'
      RETURNING id, newsletter_id, status
    `).bind(key, newsletterIdValue),
    env.DB.prepare(`
      UPDATE newsletters SET status = 'sending', updated_at = datetime('now')
      WHERE id = ? AND status = 'draft'
    `).bind(newsletterIdValue),
    env.DB.prepare(`
      INSERT INTO newsletter_deliveries (send_id, subscriber_id, status)
      SELECT send.id, subscriber.id, 'pending'
      FROM newsletter_sends AS send CROSS JOIN newsletter_subscribers AS subscriber
      WHERE send.idempotency_key = ? AND subscriber.status = 'active'
      ON CONFLICT(send_id, subscriber_id) DO NOTHING
    `).bind(key),
    env.DB.prepare(`
      UPDATE newsletter_sends
      SET target_count = (SELECT COUNT(*) FROM newsletter_deliveries WHERE send_id = newsletter_sends.id)
      WHERE idempotency_key = ?
    `).bind(key),
  ];
  const result = await env.DB.batch(operations);
  return batchRow(result);
}

async function completeEmptySend(env, sendId, newsletterIdValue) {
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE newsletter_sends
      SET status = 'completed', completed_at = datetime('now'), target_count = 0, success_count = 0, failure_count = 0
      WHERE id = ?
    `).bind(sendId),
    env.DB.prepare(`
      UPDATE newsletters SET status = 'sent', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).bind(newsletterIdValue),
  ]);
}

export async function queueExistingSend(env, sendId) {
  try {
    return { queued: await enqueuePending(env, sendId) };
  } catch {
    await markQueueFailure(env, sendId);
    return { error: true };
  }
}

export async function onRequestPost({ request, env, params }) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;
  const id = newsletterId(params?.id);
  if (!id) return json({ error: '뉴스레터 식별자가 올바르지 않습니다.' }, 400);
  const key = idempotencyKey(request);
  if (!key) return json({ error: '유효한 Idempotency-Key 헤더가 필요합니다.' }, 400);

  try {
    let send = await findSendByKey(env, key);
    let created = false;
    if (send && send.newsletter_id !== id) return json({ error: 'Idempotency-Key가 다른 발송에 사용되었습니다.' }, 409);

    if (!send) {
      const newsletter = await findNewsletter(env, id);
      if (!newsletter) return json({ error: '뉴스레터를 찾을 수 없습니다.' }, 404);
      if (newsletter.status !== 'draft' || !validFrozenContent(newsletter)) {
        return json({ error: '유효한 초안에서만 전체 발송을 시작할 수 있습니다.' }, 409);
      }
      send = await createInitialSend(env, id, key);
      created = Boolean(send);
      if (!send) {
        const raced = await findSendByKey(env, key);
        if (!raced) return json({ error: '발송을 시작할 수 없습니다. 초안 상태를 다시 확인하세요.' }, 409);
        send = raced;
      }
    }

    const queued = await queueExistingSend(env, send.id);
    if (queued.error) return json({ error: '발송 대기열 등록에 실패했습니다. 같은 키로 다시 시도하세요.' }, 503);
    if (created && queued.queued === 0) await completeEmptySend(env, send.id, id);
    return json({ sendId: send.id, queued: queued.queued }, 202);
  } catch {
    return json({ error: '전체 발송을 시작하지 못했습니다. 잠시 후 다시 시도하세요.' }, 500);
  }
}

export { MAX_BATCH_SIZE, idempotencyKey, enqueuePending, pendingDeliveryIds };
