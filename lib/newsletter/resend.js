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
