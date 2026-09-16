import { sha256 } from './tokens.js';

export async function consumeRateLimit(db, scope, key, limit, windowSeconds) {
  if (!db || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const windowStartedAt = now - (now % windowSeconds);
  const keyHash = await sha256(String(key));
  const result = await db.prepare(`
    INSERT INTO newsletter_rate_limits (scope, key_hash, window_started_at, count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(scope, key_hash) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      count = CASE
        WHEN newsletter_rate_limits.window_started_at <> excluded.window_started_at THEN 1
        ELSE newsletter_rate_limits.count + 1
      END
    WHERE newsletter_rate_limits.window_started_at <> excluded.window_started_at
       OR newsletter_rate_limits.count < ?
  `).bind(String(scope), keyHash, windowStartedAt, limit).run();

  return result.meta?.changes === 1;
}
