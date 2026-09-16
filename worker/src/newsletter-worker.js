import { renderNewsletter } from '../../lib/newsletter/content.js';
import { publicSiteUrl } from '../../lib/newsletter/config.js';
import { signActionToken } from '../../lib/newsletter/tokens.js';

const MAX_BATCH_SIZE = 100;
const UNSUBSCRIBE_TTL_SECONDS = 365 * 24 * 60 * 60;

function validMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!Number.isSafeInteger(body.sendId) || body.sendId < 1 || !Array.isArray(body.deliveryIds)
    || body.deliveryIds.length < 1 || body.deliveryIds.length > MAX_BATCH_SIZE) return null;
  const ids = body.deliveryIds;
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) return null;
  return { sendId: body.sendId, deliveryIds: ids };
}

function placeholders(ids) {
  return ids.map(() => '?').join(', ');
}

function httpsSiteUrl(env) {
  const value = publicSiteUrl(env);
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('A HTTPS public site URL is required');
  return url.toString().replace(/\/$/, '');
}

async function pendingDeliveries(env, sendId, deliveryIds) {
  const list = placeholders(deliveryIds);
  await env.DB.prepare(`
    UPDATE newsletter_deliveries
    SET status = 'failed', error_code = 'inactive_subscriber', error_message = 'Subscriber is no longer active', updated_at = datetime('now')
    WHERE send_id = ? AND status = 'pending' AND id IN (${list})
      AND EXISTS (SELECT 1 FROM newsletter_subscribers WHERE id = newsletter_deliveries.subscriber_id AND status <> 'active')
  `).bind(sendId, ...deliveryIds).run();
  const result = await env.DB.prepare(`
    SELECT delivery.id, delivery.subscriber_id, subscriber.email
    FROM newsletter_deliveries AS delivery
    JOIN newsletter_subscribers AS subscriber ON subscriber.id = delivery.subscriber_id
    WHERE delivery.send_id = ? AND delivery.status = 'pending' AND subscriber.status = 'active'
      AND delivery.id IN (${list})
    ORDER BY CASE delivery.id ${deliveryIds.map((id, index) => `WHEN ${id} THEN ${index}`).join(' ')} END
  `).bind(sendId, ...deliveryIds).all();
  return result.results || [];
}

async function frozenNewsletter(env, sendId) {
  return env.DB.prepare(`
    SELECT send.id AS send_id, send.newsletter_id, newsletter.subject, newsletter.preview_text, newsletter.content_json
    FROM newsletter_sends AS send JOIN newsletters AS newsletter ON newsletter.id = send.newsletter_id
    WHERE send.id = ?
  `).bind(sendId).first();
}

async function batchPayload(env, newsletter, deliveries) {
  const siteUrl = httpsSiteUrl(env);
  const blocks = JSON.parse(newsletter.content_json);
  const now = Math.floor(Date.now() / 1000);
  return Promise.all(deliveries.map(async (delivery) => {
    const token = await signActionToken({
      sid: delivery.subscriber_id,
      purpose: 'unsubscribe',
      exp: now + UNSUBSCRIBE_TTL_SECONDS,
    }, env.SESSION_SECRET);
    const unsubscribeUrl = `${siteUrl}/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;
    const rendered = renderNewsletter({
      subject: newsletter.subject,
      previewText: newsletter.preview_text,
      blocks,
      unsubscribeUrl,
      requireHttpsImages: true,
    });
    return {
      from: env.NEWSLETTER_FROM,
      to: [delivery.email],
      subject: newsletter.subject,
      html: rendered.html,
      text: rendered.text,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tracking: { open: false, click: false },
    };
  }));
}

async function requestResend(env, messages) {
  if (!env?.RESEND_API_KEY || !env?.NEWSLETTER_FROM) throw new Error('Newsletter delivery is unavailable');
  const response = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Resend batch delivery failed');
    error.status = response.status;
    error.code = body.name || body.code || 'resend_error';
    throw error;
  }
  const data = body.data;
  if (!Array.isArray(data) || data.length !== messages.length || data.some((item) => !item || typeof item.id !== 'string' || !item.id)) {
    throw new Error('Resend returned an invalid batch result');
  }
  return data;
}

async function markSent(env, sendId, deliveries, result) {
  await env.DB.batch(deliveries.map((delivery, index) => env.DB.prepare(`
    UPDATE newsletter_deliveries
    SET status = 'sent', resend_message_id = ?, error_code = NULL, error_message = NULL,
        sent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND send_id = ? AND status = 'pending'
  `).bind(result[index].id, delivery.id, sendId)));
}

async function markPermanentFailure(env, sendId, deliveries, error) {
  await env.DB.batch(deliveries.map((delivery) => env.DB.prepare(`
    UPDATE newsletter_deliveries
    SET status = 'failed', error_code = ?, error_message = ?, updated_at = datetime('now')
    WHERE id = ? AND send_id = ? AND status = 'pending'
  `).bind(error.code || `http_${error.status || 400}`, 'Email provider rejected this delivery', delivery.id, sendId)));
}

async function recomputeSend(env, sendId) {
  const totals = await env.DB.prepare(`
    SELECT COUNT(*) AS target_count,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS success_count,
           SUM(CASE WHEN status IN ('failed', 'bounced', 'complained') THEN 1 ELSE 0 END) AS failure_count,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count
    FROM newsletter_deliveries WHERE send_id = ?
  `).bind(sendId).first();
  const target = Number(totals?.target_count || 0);
  const success = Number(totals?.success_count || 0);
  const failure = Number(totals?.failure_count || 0);
  const pending = Number(totals?.pending_count || 0);
  const status = pending > 0 ? 'sending' : failure === 0 ? 'completed' : success > 0 ? 'partial' : 'failed';
  await env.DB.prepare(`
    UPDATE newsletter_sends
    SET target_count = ?, success_count = ?, failure_count = ?, status = ?,
        completed_at = CASE WHEN ? IN ('completed', 'partial', 'failed') THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `).bind(target, success, failure, status, status, sendId).run();
  await env.DB.prepare(`
    UPDATE newsletters
    SET status = CASE WHEN ? = 'failed' THEN 'failed' WHEN ? IN ('completed', 'partial') THEN 'sent' ELSE 'sending' END,
        sent_at = CASE WHEN ? IN ('completed', 'partial') THEN COALESCE(sent_at, datetime('now')) ELSE sent_at END,
        updated_at = datetime('now')
    WHERE id = (SELECT newsletter_id FROM newsletter_sends WHERE id = ?)
  `).bind(status, status, status, sendId).run();
  return { status, target, success, failure, pending };
}

export async function processMessage(body, env) {
  const message = validMessage(body);
  if (!message) throw new Error('Invalid newsletter queue message');
  const newsletter = await frozenNewsletter(env, message.sendId);
  if (!newsletter) throw new Error('Newsletter send was not found');
  const deliveries = await pendingDeliveries(env, message.sendId, message.deliveryIds);
  if (!deliveries.length) {
    await recomputeSend(env, message.sendId);
    return;
  }
  let messages;
  try {
    messages = await batchPayload(env, newsletter, deliveries);
  } catch {
    await markPermanentFailure(env, message.sendId, deliveries, { code: 'invalid_frozen_content' });
    await recomputeSend(env, message.sendId);
    return;
  }
  let response;
  try {
    response = await requestResend(env, messages);
  } catch (error) {
    if (error?.status >= 400 && error.status < 500 && error.status !== 429) {
      await markPermanentFailure(env, message.sendId, deliveries, error);
      await recomputeSend(env, message.sendId);
      return;
    }
    throw error;
  }
  await markSent(env, message.sendId, deliveries, response);
  await recomputeSend(env, message.sendId);
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) await processMessage(message.body, env);
  },
};
