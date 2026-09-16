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

function batchRow(result, index = 0) {
  return result?.[index]?.results?.[0] || null;
}

async function deliveryCount(env, sendId) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS target_count FROM newsletter_deliveries WHERE send_id = ?`).bind(sendId).first();
  return Number(row?.target_count || 0);
}

async function claimedDeliveryIds(env, sendId, claimKey) {
  const result = await env.DB.prepare(`
    SELECT id FROM newsletter_deliveries
    WHERE send_id = ? AND status = 'pending' AND queued_at IS NULL AND queue_claim_key = ?
    ORDER BY id ASC
  `).bind(sendId, claimKey).all();
  return (result.results || []).map((row) => row.id).filter((id) => Number.isSafeInteger(id) && id > 0);
}

async function claimNextDeliveries(env, sendId) {
  const existing = await env.DB.prepare(`
    SELECT queue_claim_key FROM newsletter_deliveries
    WHERE send_id = ? AND status = 'pending' AND queued_at IS NULL AND queue_claim_key IS NOT NULL
    ORDER BY queue_claimed_at ASC, id ASC LIMIT 1
  `).bind(sendId).first();
  if (existing?.queue_claim_key) return { claimKey: existing.queue_claim_key, deliveryIds: await claimedDeliveryIds(env, sendId, existing.queue_claim_key) };
  const claimKey = crypto.randomUUID();
  const result = await env.DB.prepare(`
    UPDATE newsletter_deliveries
    SET queue_claim_key = ?, queue_claimed_at = datetime('now'), updated_at = datetime('now')
    WHERE id IN (
      SELECT id FROM newsletter_deliveries
      WHERE send_id = ? AND status = 'pending' AND queued_at IS NULL AND queue_claim_key IS NULL
      ORDER BY id ASC LIMIT ${MAX_BATCH_SIZE}
    )
    RETURNING id
  `).bind(claimKey, sendId).all();
  const deliveryIds = (result.results || []).map((row) => row.id).filter((id) => Number.isSafeInteger(id) && id > 0);
  return deliveryIds.length ? { claimKey, deliveryIds } : null;
}

async function markQueued(env, sendId, claimKey, deliveryIds) {
  const placeholders = deliveryIds.map(() => '?').join(', ');
  await env.DB.prepare(`
    UPDATE newsletter_deliveries
    SET queued_at = datetime('now'), updated_at = datetime('now')
    WHERE send_id = ? AND status = 'pending' AND queued_at IS NULL AND queue_claim_key = ? AND id IN (${placeholders})
  `).bind(sendId, claimKey, ...deliveryIds).run();
}

async function enqueuePending(env, sendId) {
  const targetCount = await deliveryCount(env, sendId);
  let queued = 0;
  while (true) {
    const claim = await claimNextDeliveries(env, sendId);
    if (!claim?.deliveryIds.length) break;
    if (!env?.NEWSLETTER_QUEUE || typeof env.NEWSLETTER_QUEUE.send !== 'function') throw new Error('Queue producer is unavailable');
    await env.NEWSLETTER_QUEUE.send({ sendId, deliveryIds: claim.deliveryIds, queueClaimKey: claim.claimKey });
    await markQueued(env, sendId, claim.claimKey, claim.deliveryIds);
    queued += claim.deliveryIds.length;
  }
  await env.DB.prepare(`
    UPDATE newsletter_sends
    SET status = 'queued', completed_at = NULL
    WHERE id = ? AND status IN ('queued', 'failed')
  `).bind(sendId).run();
  return { queued, targetCount };
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
      UPDATE newsletters SET status = 'sent', sent_at = COALESCE(sent_at, datetime('now')), updated_at = datetime('now')
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM newsletter_sends AS newer WHERE newer.newsletter_id = newsletters.id AND newer.id > ?)
    `).bind(newsletterIdValue, sendId),
  ]);
}

export async function queueExistingSend(env, sendId) {
  try {
    return await enqueuePending(env, sendId);
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
    if (send && send.newsletter_id !== id) return json({ error: 'Idempotency-Key가 다른 발송에 사용되었습니다.' }, 409);

    if (!send) {
      const newsletter = await findNewsletter(env, id);
      if (!newsletter) return json({ error: '뉴스레터를 찾을 수 없습니다.' }, 404);
      if (newsletter.status !== 'draft' || !validFrozenContent(newsletter)) {
        return json({ error: '유효한 초안에서만 전체 발송을 시작할 수 있습니다.' }, 409);
      }
      try {
        send = await createInitialSend(env, id, key);
      } catch {
        send = await findSendByKey(env, key);
      }
      if (!send) {
        const raced = await findSendByKey(env, key);
        if (!raced) return json({ error: '발송을 시작할 수 없습니다. 초안 상태를 다시 확인하세요.' }, 409);
        send = raced;
      }
    }

    const queued = await queueExistingSend(env, send.id);
    if (queued.error) return json({ error: '발송 대기열 등록에 실패했습니다. 같은 키로 다시 시도하세요.' }, 503);
    if (queued.targetCount === 0) await completeEmptySend(env, send.id, id);
    return json({ sendId: send.id, queued: queued.queued }, 202);
  } catch {
    return json({ error: '전체 발송을 시작하지 못했습니다. 잠시 후 다시 시도하세요.' }, 500);
  }
}

export { MAX_BATCH_SIZE, idempotencyKey, enqueuePending, claimedDeliveryIds };
