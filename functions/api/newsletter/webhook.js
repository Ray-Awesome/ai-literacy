const REPLAY_WINDOW_SECONDS = 5 * 60;

function badRequest() {
  return new Response('Invalid webhook', { status: 400 });
}

function validBase64(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const paddingAt = value.indexOf('=');
  const unpaddedLength = paddingAt === -1 ? value.length : paddingAt;
  return unpaddedLength % 4 !== 1 && (paddingAt === -1 || value.length % 4 === 0);
}

function decodeBase64(value) {
  if (!validBase64(value)) return null;
  try {
    const binary = atob(value.padEnd(Math.ceil(value.length / 4) * 4, '='));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(expected, candidate) {
  let difference = expected.length ^ candidate.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ (candidate[index] ?? 0);
  }
  return difference === 0;
}

async function signedByResend({ svixId, timestamp, signature, secret, rawBody }) {
  if (!secret?.startsWith('whsec_')) return false;
  const keyBytes = decodeBase64(secret.slice('whsec_'.length));
  if (!keyBytes) return false;

  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${svixId}.${timestamp}.${rawBody}`),
  ));

  const candidates = signature.split(/\s+/)
    .map((part) => part.split(',', 2))
    .filter(([version, value]) => version === 'v1' && value)
    .map(([, value]) => decodeBase64(value))
    .filter(Boolean);
  let matched = false;
  for (const candidate of candidates) matched = constantTimeEqual(expected, candidate) || matched;
  return matched;
}

function validTimestamp(value) {
  if (!/^[0-9]{1,16}$/.test(value || '')) return false;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp)
    && Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= REPLAY_WINDOW_SECONDS;
}

function parseEvent(rawBody) {
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || typeof event.type !== 'string' || !event.type
    || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return null;

  if (event.type.startsWith('email.') && (typeof event.data.email_id !== 'string' || !event.data.email_id)) return null;
  return event;
}

function suppressionFor(event) {
  if (event.type === 'email.bounced' && event.data.bounce?.type === 'Permanent') return 'bounced';
  if (event.type === 'email.complained') return 'complained';
  return null;
}

function eventStatements(svixId, claimToken, event, status) {
  const messageId = event.data.email_id ?? null;
  const statements = [];
  const bindings = [];

  if (status) {
    statements.push(
      `INSERT INTO newsletter_webhook_events (svix_id, claim_token, event_type, resend_message_id)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM newsletter_deliveries WHERE resend_message_id = ?)
       ON CONFLICT(svix_id) DO NOTHING`,
    );
    bindings.push([svixId, claimToken, event.type, messageId, messageId]);
  } else {
    statements.push(
      `INSERT INTO newsletter_webhook_events (svix_id, claim_token, event_type, resend_message_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(svix_id) DO NOTHING`,
    );
    bindings.push([svixId, claimToken, event.type, messageId]);
  }

  if (status) {
    statements.push(
      `UPDATE newsletter_deliveries
       SET status = ?, updated_at = datetime('now')
       WHERE resend_message_id = ?
         AND status NOT IN ('bounced', 'complained')
         AND EXISTS (
           SELECT 1 FROM newsletter_webhook_events
           WHERE svix_id = ? AND claim_token = ? AND processed_at IS NULL
         )`,
      `UPDATE newsletter_subscribers
       SET status = ?, updated_at = datetime('now')
       WHERE id IN (SELECT subscriber_id FROM newsletter_deliveries WHERE resend_message_id = ?)
         AND status NOT IN ('unsubscribed', 'bounced', 'complained')
         AND EXISTS (
           SELECT 1 FROM newsletter_webhook_events
           WHERE svix_id = ? AND claim_token = ? AND processed_at IS NULL
         )`,
    );
    bindings.push([status, messageId, svixId, claimToken], [status, messageId, svixId, claimToken]);
  }

  statements.push(
    `UPDATE newsletter_webhook_events
     SET processed_at = datetime('now')
     WHERE svix_id = ? AND claim_token = ? AND processed_at IS NULL`,
  );
  bindings.push([svixId, claimToken]);
  return statements.map((sql, index) => ({ sql, bindings: bindings[index] }));
}

async function suppressionEventProcessed(db, svixId) {
  return db.prepare(`
    SELECT svix_id FROM newsletter_webhook_events
    WHERE svix_id = ? AND processed_at IS NOT NULL
  `).bind(svixId).first();
}

export async function onRequestPost({ request, env }) {
  const svixId = request.headers.get('svix-id');
  const timestamp = request.headers.get('svix-timestamp');
  const signature = request.headers.get('svix-signature');
  if (!svixId || !timestamp || !signature || !validTimestamp(timestamp)) return badRequest();

  const rawBody = await request.text();
  if (!await signedByResend({
    svixId, timestamp, signature, secret: env.RESEND_WEBHOOK_SECRET, rawBody,
  })) return badRequest();

  const event = parseEvent(rawBody);
  if (!event) return badRequest();

  const claimToken = crypto.randomUUID();
  const status = suppressionFor(event);
  const statements = eventStatements(svixId, claimToken, event, status);
  try {
    await env.DB.batch(statements.map(({ sql, bindings }) => env.DB.prepare(sql).bind(...bindings)));
    if (status && !await suppressionEventProcessed(env.DB, svixId)) {
      return new Response('Webhook processing pending', { status: 500 });
    }
  } catch {
    return new Response('Webhook processing failed', { status: 500 });
  }
  return new Response(null, { status: 200 });
}
