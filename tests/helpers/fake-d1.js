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
      const result = row ? { id: row.id, status: row.status } : null;
      await this.onFirst?.(sql, params, result);
      return result;
    }
    if (sql.includes('SELECT subscriber_id FROM newsletter_confirmation_challenges')) {
      const challenge = this.rows.challenges.find((item) => (
        item.token_hash === params[0] && item.expires_at > '2026-09-16 00:00:00'
      ));
      return challenge ? { subscriber_id: challenge.subscriber_id } : null;
    }
    if (sql.includes('SELECT id FROM newsletter_subscribers WHERE status = \'pending\'')) {
      const row = this.rows.subscribers.find((subscriber) => (
        subscriber.status === 'pending'
        && subscriber.confirmation_token_hash === params[0]
        && subscriber.confirmation_expires_at > '2026-09-16 00:00:00'
      ));
      return row ? { id: row.id } : null;
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
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (sql.includes('INSERT INTO newsletter_confirmation_challenges')) {
      const [tokenHash, email] = params;
      const subscriber = this.rows.subscribers.find((row) => row.email === email && row.status === 'pending');
      if (!subscriber || this.rows.challenges.some((challenge) => challenge.token_hash === tokenHash)) return { meta: { changes: 0 } };
      this.rows.challenges.push({ subscriber_id: subscriber.id, token_hash: tokenHash, expires_at: '2999-01-01 00:00:00' });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("SET status = 'pending'")) {
      const [first, second] = params;
      const byId = sql.includes('WHERE id = ?');
      const row = byId
        ? this.rows.subscribers.find((subscriber) => subscriber.id === first && subscriber.status !== 'active')
        : this.rows.subscribers.find((subscriber) => subscriber.email === second && subscriber.status !== 'active');
      if (!row) return { meta: { changes: 0 } };
      row.status = 'pending';
      row.consent_at = '2026-09-16 00:00:00';
      row.confirmed_at = null;
      if (!byId) {
        row.confirmation_token_hash = first;
        row.confirmation_expires_at = '2999-01-01 00:00:00';
      }
      if (sql.includes('confirmation_token_hash = NULL')) {
        row.confirmation_token_hash = null;
        row.confirmation_expires_at = null;
      }
      return { meta: { changes: 1 } };
    }

    if (sql.includes("SET status = 'active'")) {
      const [subscriberId] = params;
      const row = this.rows.subscribers.find((subscriber) => (
        subscriber.status === 'pending'
        && subscriber.id === subscriberId
      ));
      if (!row) return { meta: { changes: 0 } };
      row.status = 'active';
      row.confirmed_at = '2026-09-16 00:00:00';
      row.confirmation_token_hash = null;
      row.confirmation_expires_at = null;
      return { meta: { changes: 1 } };
    }

    if (sql.includes('DELETE FROM newsletter_confirmation_challenges')) {
      const [subscriberId] = params;
      const before = this.rows.challenges.length;
      this.rows.challenges = this.rows.challenges.filter((challenge) => challenge.subscriber_id !== subscriberId);
      return { meta: { changes: before - this.rows.challenges.length } };
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
