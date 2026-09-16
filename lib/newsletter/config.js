export const CONFIRMATION_TOKEN_BYTES = 32;
export const CONFIRMATION_TTL_SECONDS = 24 * 60 * 60;

export const SUBSCRIBER_STATUSES = Object.freeze(['pending', 'active', 'unsubscribed', 'bounced', 'complained']);
export const NEWSLETTER_STATUSES = Object.freeze(['draft', 'sending', 'sent', 'failed']);
export const SEND_STATUSES = Object.freeze(['queued', 'sending', 'completed', 'partial', 'failed']);
export const DELIVERY_STATUSES = Object.freeze(['pending', 'sent', 'failed', 'bounced', 'complained']);

export function publicSiteUrl(env) {
  const value = env?.PUBLIC_SITE_URL || 'https://ailiteracy.or.kr';
  return String(value).replace(/\/+$/, '');
}

export function newsletterConfig(env) {
  const missing = ['SESSION_SECRET', 'NEWSLETTER_FROM', 'PUBLIC_SITE_URL']
    .filter((name) => !env?.[name]);
  if (missing.length) throw new Error('Newsletter service is not configured');

  return {
    from: env.NEWSLETTER_FROM,
    publicSiteUrl: publicSiteUrl(env),
  };
}
