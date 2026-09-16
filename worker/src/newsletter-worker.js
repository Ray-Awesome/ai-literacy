import { renderNewsletter } from '../../lib/newsletter/content.js';
import { sha256, signActionToken } from '../../lib/newsletter/tokens.js';

const MAX_BATCH_SIZE = 100;
const DLQ_NAME = 'ailit-newsletter-dead-letter';
const STABLE_UNSUBSCRIBE_EXPIRY = 4_102_444_800;
const PERMANENT_RESEND_CODES = new Set(['validation_error', 'invalid_attachment', 'invalid_parameter', 'missing_required_field', 'missing_required_parameter']);

function validMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.sendId) || body.sendId < 1
    || !Array.isArray(body.deliveryIds) || body.deliveryIds.length < 1 || body.deliveryIds.length > MAX_BATCH_SIZE) return null;
  if (body.deliveryIds.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(body.deliveryIds).size !== body.deliveryIds.length) return null;
  return { sendId: body.sendId, deliveryIds: body.deliveryIds };
}

function placeholders(ids) { return ids.map(() => '?').join(', '); }

function workerConfig(env) {
  for (const key of ['SESSION_SECRET', 'NEWSLETTER_FROM', 'PUBLIC_SITE_URL', 'RESEND_API_KEY']) {
    if (typeof env?.[key] !== 'string' || !env[key].trim()) throw new Error(`Missing ${key}`);
  }
  const url = new URL(env.PUBLIC_SITE_URL);
  if (url.protocol !== 'https:') throw new Error('PUBLIC_SITE_URL must use HTTPS');
  return { siteUrl: url.toString().replace(/\/$/, '') };
}

async function frozenNewsletter(env, sendId) {
  return env.DB.prepare(`SELECT send.id AS send_id, send.newsletter_id, newsletter.subject, newsletter.preview_text, newsletter.content_json
    FROM newsletter_sends AS send JOIN newsletters AS newsletter ON newsletter.id = send.newsletter_id WHERE send.id = ?`).bind(sendId).first();
}

async function pendingDeliveries(env, sendId, deliveryIds) {
  const list = placeholders(deliveryIds);
  await env.DB.prepare(`UPDATE newsletter_deliveries SET status = 'failed', error_code = 'inactive_subscriber', error_message = 'Subscriber is no longer active', updated_at = datetime('now')
    WHERE send_id = ? AND status = 'pending' AND id IN (${list}) AND EXISTS (SELECT 1 FROM newsletter_subscribers WHERE id = newsletter_deliveries.subscriber_id AND status <> 'active')`).bind(sendId, ...deliveryIds).run();
  const result = await env.DB.prepare(`SELECT delivery.id, delivery.subscriber_id, subscriber.email FROM newsletter_deliveries AS delivery
    JOIN newsletter_subscribers AS subscriber ON subscriber.id = delivery.subscriber_id
    WHERE delivery.send_id = ? AND delivery.status = 'pending' AND subscriber.status = 'active' AND delivery.id IN (${list})
    ORDER BY CASE delivery.id ${deliveryIds.map((id, index) => `WHEN ${id} THEN ${index}`).join(' ')} END`).bind(sendId, ...deliveryIds).all();
  return result.results || [];
}

async function buildMessages(env, config, newsletter, deliveries) {
  let blocks;
  try { blocks = JSON.parse(newsletter.content_json); } catch { throw Object.assign(new Error('Invalid frozen newsletter content'), { permanentContent: true }); }
  return Promise.all(deliveries.map(async (delivery) => {
    const token = await signActionToken({ sid: delivery.subscriber_id, purpose: 'unsubscribe', exp: STABLE_UNSUBSCRIBE_EXPIRY }, env.SESSION_SECRET);
    const unsubscribeUrl = `${config.siteUrl}/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;
    let rendered;
    try { rendered = renderNewsletter({ subject: newsletter.subject, previewText: newsletter.preview_text, blocks, unsubscribeUrl, requireHttpsImages: true }); } catch {
      throw Object.assign(new Error('Invalid frozen newsletter content'), { permanentContent: true });
    }
    return { from: env.NEWSLETTER_FROM, to: [delivery.email], subject: newsletter.subject, html: rendered.html, text: rendered.text,
      headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
  }));
}

async function requestResend(env, messages, key) {
  const response = await fetch('https://api.resend.com/emails/batch', { method: 'POST', headers: {
    Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key,
  }, body: JSON.stringify(messages) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error('Resend batch delivery failed'), { status: response.status, code: body.name || body.code || 'resend_error' });
  if (!Array.isArray(body.data) || body.data.length !== messages.length || body.data.some((item) => !item || typeof item.id !== 'string' || !item.id)) throw new Error('Resend returned an invalid batch result');
  return body.data;
}

async function markResult(env, sendId, deliveries, result, failure) {
  await env.DB.batch(deliveries.map((delivery, index) => failure
    ? env.DB.prepare(`UPDATE newsletter_deliveries SET status = 'failed', error_code = ?, error_message = ?, updated_at = datetime('now') WHERE id = ? AND send_id = ? AND status = 'pending'`)
      .bind(result.code, result.message, delivery.id, sendId)
    : env.DB.prepare(`UPDATE newsletter_deliveries SET status = 'sent', resend_message_id = ?, error_code = NULL, error_message = NULL, sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND send_id = ? AND status = 'pending'`)
      .bind(result[index].id, delivery.id, sendId)));
}

export async function recomputeSend(env, sendId) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE newsletter_sends SET target_count = (SELECT COUNT(*) FROM newsletter_deliveries WHERE send_id = newsletter_sends.id),
      success_count = (SELECT COUNT(*) FROM newsletter_deliveries WHERE send_id = newsletter_sends.id AND status = 'sent'),
      failure_count = (SELECT COUNT(*) FROM newsletter_deliveries WHERE send_id = newsletter_sends.id AND status IN ('failed', 'bounced', 'complained')),
      status = CASE WHEN EXISTS (SELECT 1 FROM newsletter_deliveries WHERE send_id = newsletter_sends.id AND status = 'pending') THEN 'sending'
        WHEN NOT EXISTS (SELECT 1 FROM newsletter_deliveries WHERE send_id = newsletter_sends.id AND status IN ('failed', 'bounced', 'complained')) THEN 'completed'
        WHEN EXISTS (SELECT 1 FROM newsletter_deliveries WHERE send_id = newsletter_sends.id AND status = 'sent') THEN 'partial' ELSE 'failed' END,
      completed_at = CASE WHEN EXISTS (SELECT 1 FROM newsletter_deliveries WHERE send_id = newsletter_sends.id AND status = 'pending') THEN NULL ELSE datetime('now') END WHERE id = ?`).bind(sendId),
    env.DB.prepare(`UPDATE newsletters SET status = CASE (SELECT status FROM newsletter_sends WHERE id = ?) WHEN 'failed' THEN 'failed' WHEN 'completed' THEN 'sent' WHEN 'partial' THEN 'sent' ELSE 'sending' END,
      sent_at = CASE WHEN (SELECT status FROM newsletter_sends WHERE id = ?) IN ('completed', 'partial') THEN COALESCE(sent_at, datetime('now')) ELSE sent_at END, updated_at = datetime('now')
      WHERE id = (SELECT newsletter_id FROM newsletter_sends WHERE id = ?) AND NOT EXISTS
        (SELECT 1 FROM newsletter_sends AS newer WHERE newer.newsletter_id = newsletters.id AND newer.id > ?)` ).bind(sendId, sendId, sendId, sendId),
  ]);
}

export async function processMessage(body, env) {
  const message = validMessage(body);
  if (!message) throw new Error('Invalid newsletter queue message');
  const config = workerConfig(env);
  const newsletter = await frozenNewsletter(env, message.sendId);
  if (!newsletter) throw new Error('Newsletter send was not found');
  const deliveries = await pendingDeliveries(env, message.sendId, message.deliveryIds);
  if (!deliveries.length) { await recomputeSend(env, message.sendId); return; }
  let messages;
  try { messages = await buildMessages(env, config, newsletter, deliveries); } catch (error) {
    if (!error?.permanentContent) throw error;
    await markResult(env, message.sendId, deliveries, { code: 'invalid_frozen_content', message: 'Frozen newsletter content is invalid' }, true);
    await recomputeSend(env, message.sendId); return;
  }
  const key = `newsletter-${message.sendId}-${await sha256(JSON.stringify(messages))}`;
  let result;
  try { result = await requestResend(env, messages, key); } catch (error) {
    if (!(error?.status >= 400 && error.status < 500 && PERMANENT_RESEND_CODES.has(error.code))) throw error;
    await markResult(env, message.sendId, deliveries, { code: error.code, message: 'Email provider rejected this delivery' }, true);
    await recomputeSend(env, message.sendId); return;
  }
  await markResult(env, message.sendId, deliveries, result, false);
  await recomputeSend(env, message.sendId);
}

export async function reconcileDlq(body, env) {
  const message = validMessage(body);
  if (!message) return;
  const list = placeholders(message.deliveryIds);
  await env.DB.prepare(`UPDATE newsletter_deliveries SET status = 'failed', error_code = 'queue_retries_exhausted', error_message = 'Queue retries were exhausted', updated_at = datetime('now')
    WHERE send_id = ? AND status = 'pending' AND id IN (${list})`).bind(message.sendId, ...message.deliveryIds).run();
  await recomputeSend(env, message.sendId);
}

export default { async queue(batch, env) {
  if (batch.queue === DLQ_NAME) { for (const message of batch.messages || []) await reconcileDlq(message.body, env); return; }
  for (const message of batch.messages || []) await processMessage(message.body, env);
} };
