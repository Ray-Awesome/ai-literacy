CREATE TABLE IF NOT EXISTS newsletter_webhook_events (
  svix_id           TEXT    PRIMARY KEY,
  claim_token       TEXT    NOT NULL,
  event_type        TEXT    NOT NULL,
  resend_message_id TEXT,
  processed_at      TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
