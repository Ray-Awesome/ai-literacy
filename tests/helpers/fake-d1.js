export class FakeD1 {
  constructor(rows) {
    this.rows = rows;
    this.nextSubscriberId = 1;
    this.rateLimits = new Map();
    this.operations = [];
  }

  prepare(sql) {
    return {
      bind: (...params) => ({
        sql,
        params,
        first: async () => {
          this.operations.push('first');
          return this.first(sql, params);
        },
        run: async () => {
          this.operations.push('run');
          return this.run(sql, params);
        },
      }),
    };
  }

  async batch(statements) {
    this.operations.push('batch');
    this.batchDepth = (this.batchDepth || 0) + 1;
    try {
      const results = [];
      for (const statement of statements) {
        const result = await this.run(statement.sql, statement.params);
        results.push({ meta: result.meta, results: result.result ? [result.result] : [] });
      }
      return results;
    } finally {
      this.batchDepth -= 1;
      if (!this.batchDepth && this.challengeInsertedDuringBatch) {
        this.challengeInsertedDuringBatch = false;
        await this.onChallengeInserted?.();
      }
    }
  }

  async first(sql, params) {
    if (sql.includes("SET status = 'active'")) {
      const result = await this.run(sql, params);
      return result.result || null;
    }
    if (sql.includes('INSERT INTO newsletter_subscribers') && sql.includes('ON CONFLICT(email)')) {
      const [email] = params;
      let row = this.rows.subscribers.find((subscriber) => subscriber.email === email);
      if (!row) {
        row = { id: this.nextSubscriberId++, email, status: 'pending', consent_at: '2026-09-16 00:00:00' };
        this.rows.subscribers.push(row);
      } else if (!['active', 'bounced', 'complained'].includes(row.status)) {
        const wasPending = row.status === 'pending';
        row.status = 'pending';
        row.consent_at = '2026-09-16 00:00:00';
        row.confirmed_at = wasPending ? row.confirmed_at : null;
        if (!wasPending) {
          row.confirmation_token_hash = null;
          row.confirmation_expires_at = null;
        }
      }
      const result = { id: row.id, status: row.status };
      await this.onSubscriberUpsert?.(row, result);
      return result;
    }
    if (sql.includes('INSERT INTO newsletter_confirmation_challenges')) {
      const result = await this.run(sql, params);
      return result.result || null;
    }
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
      await this.onChallengeValidation?.();
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
    if (this.failNextRun) {
      this.failNextRun = false;
      throw new Error('Simulated D1 failure');
    }
    if (sql.includes('newsletter_rate_limits')) return this.consumeRateLimit(params);

    if (sql.includes('DELETE FROM newsletter_confirmation_challenges') && sql.includes("status <> 'pending'")) {
      const [email] = params;
      const subscriber = this.rows.subscribers.find((row) => row.email === email && row.status !== 'pending');
      if (!subscriber) return { meta: { changes: 0 } };
      const before = this.rows.challenges.length;
      this.rows.challenges = this.rows.challenges.filter((challenge) => challenge.subscriber_id !== subscriber.id);
      return { meta: { changes: before - this.rows.challenges.length } };
    }

    if (sql.includes('SET updated_at = updated_at')) {
      const [email] = params;
      return { meta: { changes: this.rows.subscribers.some((subscriber) => subscriber.email === email) ? 1 : 0 } };
    }

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
      if (this.batchDepth) this.challengeInsertedDuringBatch = true;
      else await this.onChallengeInserted?.();
      return { meta: { changes: 1 }, result: { subscriber_id: subscriber.id } };
    }

    if (sql.includes('INSERT INTO newsletter_confirmation_delivery_state')) {
      const [tokenHash, email] = params;
      const subscriber = this.rows.subscribers.find((row) => row.email === email && row.status === 'pending');
      const challenge = subscriber && this.rows.challenges.find((item) => item.subscriber_id === subscriber.id && item.token_hash === tokenHash);
      if (!challenge) return { meta: { changes: 0 } };
      const current = this.rows.deliveryStates.find((item) => item.subscriber_id === subscriber.id);
      if (current) current.current_token_hash = tokenHash;
      else this.rows.deliveryStates.push({ subscriber_id: subscriber.id, current_token_hash: tokenHash });
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
      await this.onChallengeValidation?.();
      const [value] = params;
      const atomicChallenge = sql.includes('newsletter_confirmation_challenges');
      const row = this.rows.subscribers.find((subscriber) => (
        subscriber.status === 'pending'
        && (atomicChallenge
          ? this.rows.challenges.some((challenge) => challenge.subscriber_id === subscriber.id && challenge.token_hash === value && challenge.expires_at > '2026-09-16 00:00:00')
          : subscriber.confirmation_token_hash === value && subscriber.confirmation_expires_at > '2026-09-16 00:00:00')
      ));
      if (!row) return { meta: { changes: 0 } };
      row.status = 'active';
      row.confirmed_at = '2026-09-16 00:00:00';
      row.confirmation_token_hash = null;
      row.confirmation_expires_at = null;
      return { meta: { changes: 1 }, result: { id: row.id } };
    }

    if (sql.includes('DELETE FROM newsletter_confirmation_challenges')) {
      const [subscriberId, tokenHash] = params;
      if (sql.includes('token_hash <>')) {
        const state = this.rows.deliveryStates.find((item) => item.subscriber_id === subscriberId);
        const subscriber = this.rows.subscribers.find((item) => item.id === subscriberId);
        if (!state || state.current_token_hash !== tokenHash || subscriber?.status !== 'pending') return { meta: { changes: 0 } };
        const before = this.rows.challenges.length;
        this.rows.challenges = this.rows.challenges.filter((challenge) => challenge.subscriber_id !== subscriberId || challenge.token_hash === tokenHash);
        return { meta: { changes: before - this.rows.challenges.length } };
      }
      if (sql.includes("status = 'active'")) {
        const subscriber = this.rows.subscribers.find((item) => item.id === subscriberId);
        if (subscriber?.status !== 'active') return { meta: { changes: 0 } };
      }
      const before = this.rows.challenges.length;
      this.rows.challenges = this.rows.challenges.filter((challenge) => challenge.subscriber_id !== subscriberId);
      return { meta: { changes: before - this.rows.challenges.length } };
    }

    if (sql.includes('DELETE FROM newsletter_confirmation_delivery_state')) {
      const [subscriberId] = params;
      const subscriber = this.rows.subscribers.find((item) => item.id === subscriberId);
      if (subscriber?.status !== 'active') return { meta: { changes: 0 } };
      const before = this.rows.deliveryStates.length;
      this.rows.deliveryStates = this.rows.deliveryStates.filter((item) => item.subscriber_id !== subscriberId);
      return { meta: { changes: before - this.rows.deliveryStates.length } };
    }

    if (sql.includes('SET confirmation_token_hash = NULL') && sql.includes('newsletter_confirmation_delivery_state')) {
      const [subscriberId, tokenHash] = params;
      const subscriber = this.rows.subscribers.find((item) => item.id === subscriberId && item.status === 'pending');
      const state = this.rows.deliveryStates.find((item) => item.subscriber_id === subscriberId && item.current_token_hash === tokenHash);
      if (!subscriber || !state) return { meta: { changes: 0 } };
      subscriber.confirmation_token_hash = null;
      subscriber.confirmation_expires_at = null;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("SET status = 'unsubscribed'") || sql.includes("ELSE 'unsubscribed'")) {
      const [id] = params;
      const row = this.rows.subscribers.find((subscriber) => subscriber.id === id);
      if (!row) return { meta: { changes: 0 } };
      if (!['bounced', 'complained'].includes(row.status)) {
        row.status = 'unsubscribed';
        row.unsubscribed_at ||= '2026-09-16 00:00:00';
      }
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
