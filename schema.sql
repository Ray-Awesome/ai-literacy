CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT    NOT NULL UNIQUE,
  password_hash     TEXT    NOT NULL,
  birth_date        TEXT    NOT NULL,
  is_minor          INTEGER NOT NULL DEFAULT 0,
  guardian_name     TEXT,
  guardian_relation TEXT,
  guardian_contact  TEXT,
  agreed_terms      INTEGER NOT NULL DEFAULT 0,
  agreed_privacy    INTEGER NOT NULL DEFAULT 0,
  guardian_consent  INTEGER NOT NULL DEFAULT 0,
  is_admin          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  item_key    TEXT    NOT NULL,
  prompt      TEXT,
  answer      TEXT    NOT NULL,
  page_url    TEXT,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, item_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_answers_user ON answers(user_id);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  email                     TEXT    NOT NULL UNIQUE,
  status                    TEXT    NOT NULL DEFAULT 'pending'
                                      CHECK(status IN ('pending','active','unsubscribed','bounced','complained')),
  consent_at                TEXT    NOT NULL,
  confirmed_at              TEXT,
  unsubscribed_at           TEXT,
  confirmation_token_hash   TEXT,
  confirmation_expires_at   TEXT,
  created_at                TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_status ON newsletter_subscribers(status);

CREATE TABLE IF NOT EXISTS newsletter_confirmation_challenges (
  token_hash    TEXT    PRIMARY KEY,
  subscriber_id INTEGER NOT NULL,
  expires_at    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (subscriber_id) REFERENCES newsletter_subscribers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_newsletter_confirmation_challenges_subscriber
  ON newsletter_confirmation_challenges(subscriber_id);

CREATE TABLE IF NOT EXISTS newsletter_confirmation_delivery_state (
  subscriber_id      INTEGER PRIMARY KEY,
  current_token_hash TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (subscriber_id) REFERENCES newsletter_subscribers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS newsletters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subject         TEXT    NOT NULL,
  preview_text    TEXT    NOT NULL DEFAULT '',
  content_json    TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'draft'
                          CHECK(status IN ('draft','sending','sent','failed')),
  created_by      INTEGER NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_newsletters_status ON newsletters(status);

CREATE TABLE IF NOT EXISTS newsletter_sends (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  newsletter_id     INTEGER NOT NULL,
  source_send_id    INTEGER,
  idempotency_key   TEXT    NOT NULL UNIQUE,
  status            TEXT    NOT NULL DEFAULT 'queued'
                            CHECK(status IN ('queued','sending','completed','partial','failed')),
  target_count      INTEGER NOT NULL DEFAULT 0,
  success_count     INTEGER NOT NULL DEFAULT 0,
  failure_count     INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT,
  completed_at      TEXT,
  FOREIGN KEY (newsletter_id) REFERENCES newsletters(id)
);

CREATE INDEX IF NOT EXISTS idx_newsletter_sends_newsletter ON newsletter_sends(newsletter_id);

CREATE TABLE IF NOT EXISTS newsletter_deliveries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  send_id           INTEGER NOT NULL,
  subscriber_id     INTEGER NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','sent','failed','bounced','complained')),
  resend_message_id TEXT,
  error_code        TEXT,
  error_message     TEXT,
  delivery_certainty TEXT   NOT NULL DEFAULT 'known'
                            CHECK(delivery_certainty IN ('known','indeterminate')),
  queued_at         TEXT,
  queue_claim_key   TEXT,
  queue_claimed_at  TEXT,
  sent_at           TEXT,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(send_id, subscriber_id),
  FOREIGN KEY (send_id) REFERENCES newsletter_sends(id),
  FOREIGN KEY (subscriber_id) REFERENCES newsletter_subscribers(id)
);

CREATE INDEX IF NOT EXISTS idx_newsletter_deliveries_send_status ON newsletter_deliveries(send_id, status);
CREATE INDEX IF NOT EXISTS idx_newsletter_deliveries_queue_claim
  ON newsletter_deliveries(send_id, status, queued_at, queue_claim_key);

CREATE TABLE IF NOT EXISTS newsletter_provider_operations (
  operation_key      TEXT PRIMARY KEY,
  send_id            INTEGER NOT NULL,
  queue_claim_key    TEXT,
  delivery_ids_json  TEXT NOT NULL,
  request_body       TEXT NOT NULL,
  provider_key       TEXT NOT NULL,
  provider_result    TEXT,
  status             TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','accepted')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at        TEXT,
  expires_at         TEXT NOT NULL,
  FOREIGN KEY (send_id) REFERENCES newsletter_sends(id)
);

CREATE INDEX IF NOT EXISTS idx_newsletter_provider_operations_expiry
  ON newsletter_provider_operations(expires_at);

CREATE TABLE IF NOT EXISTS newsletter_webhook_events (
  svix_id           TEXT    PRIMARY KEY,
  claim_token       TEXT    NOT NULL,
  event_type        TEXT    NOT NULL,
  resend_message_id TEXT,
  processed_at      TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS newsletter_rate_limits (
  scope             TEXT    NOT NULL,
  key_hash          TEXT    NOT NULL,
  window_started_at INTEGER NOT NULL,
  count             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key_hash)
);
