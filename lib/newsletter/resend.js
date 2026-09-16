export class ResendError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ResendError';
    this.status = status;
    this.code = code;
  }
}

export async function sendEmail(env, message) {
  if (!env?.RESEND_API_KEY) throw new ResendError(503, 'not_configured', 'Email delivery is unavailable');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Entity-Ref-ID': String(message.idempotencyKey),
    },
    body: JSON.stringify({
      from: message.from || env.NEWSLETTER_FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.headers ? { headers: message.headers } : {}),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ResendError(response.status, body.name || body.code || 'resend_error', body.message || 'Email delivery failed');
  }
  return { id: body.id };
}

export async function retirePriorChallenges(env, subscriberId, tokenHash) {
  await env.DB.prepare(`
    UPDATE newsletter_subscribers
    SET confirmation_token_hash = NULL, confirmation_expires_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
      AND EXISTS (
        SELECT 1 FROM newsletter_confirmation_delivery_state
        WHERE subscriber_id = newsletter_subscribers.id AND current_token_hash = ?
      )
  `).bind(subscriberId, tokenHash).run();
  await env.DB.prepare(`
    DELETE FROM newsletter_confirmation_challenges
    WHERE subscriber_id = ? AND token_hash <> ?
      AND EXISTS (
        SELECT 1 FROM newsletter_confirmation_delivery_state
        WHERE subscriber_id = ? AND current_token_hash = ?
      )
      AND EXISTS (
        SELECT 1 FROM newsletter_subscribers
        WHERE id = ? AND status = 'pending'
      )
  `).bind(subscriberId, tokenHash, subscriberId, tokenHash, subscriberId).run();
}
