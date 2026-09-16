export class FakeD1 {
  constructor(rows) {
    this.rows = rows;
    this.nextSubscriberId = 1;
    this.rateLimits = new Map();
  }

  prepare(sql) {
    return {
      bind: (...params) => ({
        first: async () => this.first(sql, params),
        run: async () => this.run(sql, params),
      }),
    };
  }

  async first(sql, params) {
    if (/SELECT id, status FROM newsletter_subscribers WHERE email = \?/.test(sql)) {
      const row = this.rows.subscribers.find((subscriber) => subscriber.email === params[0]);
      return row ? { id: row.id, status: row.status } : null;
    }
    throw new Error(`Unsupported first query: ${sql}`);
  }

  async run(sql, params) {
    if (sql.includes('newsletter_rate_limits')) return this.consumeRateLimit(params);

    if (sql.includes('INSERT INTO newsletter_subscribers')) {
      const [email, confirmationTokenHash] = params;
      if (!this.rows.subscribers.some((subscriber) => subscriber.email === email)) {
        this.rows.subscribers.push({
          id: this.nextSubscriberId++,
          email,
          status: 'pending',
          consent_at: '2026-09-16 00:00:00',
          confirmation_token_hash: confirmationTokenHash,
          confirmation_expires_at: '2999-01-01 00:00:00',
        });
      }
      return { meta: { changes: 1 } };
    }

    if (sql.includes("SET status = 'pending'")) {
      const [confirmationTokenHash, email] = params;
      const row = this.rows.subscribers.find((subscriber) => subscriber.email === email && subscriber.status !== 'active');
      if (!row) return { meta: { changes: 0 } };
      row.status = 'pending';
      row.consent_at = '2026-09-16 00:00:00';
      row.confirmed_at = null;
      row.confirmation_token_hash = confirmationTokenHash;
      row.confirmation_expires_at = '2999-01-01 00:00:00';
      return { meta: { changes: 1 } };
    }

    if (sql.includes("SET status = 'active'")) {
      const [confirmationTokenHash] = params;
      const row = this.rows.subscribers.find((subscriber) => (
        subscriber.status === 'pending'
        && subscriber.confirmation_token_hash === confirmationTokenHash
        && subscriber.confirmation_expires_at > '2026-09-16 00:00:00'
      ));
      if (!row) return { meta: { changes: 0 } };
      row.status = 'active';
      row.confirmed_at = '2026-09-16 00:00:00';
      row.confirmation_token_hash = null;
      row.confirmation_expires_at = null;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("SET status = 'unsubscribed'")) {
      const [id] = params;
      const row = this.rows.subscribers.find((subscriber) => subscriber.id === id);
      if (!row) return { meta: { changes: 0 } };
      row.status = 'unsubscribed';
      row.unsubscribed_at ||= '2026-09-16 00:00:00';
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unsupported run query: ${sql}`);
  }

  consumeRateLimit([scope, keyHash, windowStartedAt, limit]) {
    const key = `${scope}:${keyHash}`;
    const existing = this.rateLimits.get(key);
    const count = !existing || existing.windowStartedAt !== windowStartedAt ? 1 : existing.count + 1;
    if (existing && existing.windowStartedAt === windowStartedAt && existing.count >= limit) {
      return { meta: { changes: 0 } };
    }
    this.rateLimits.set(key, { count, windowStartedAt });
    return { meta: { changes: 1 } };
  }
}
