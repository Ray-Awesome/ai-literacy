-- Apply after 0004 to preserve immutable provider submissions and uncertainty state.
ALTER TABLE newsletter_deliveries ADD COLUMN delivery_certainty TEXT NOT NULL DEFAULT 'known';

CREATE TABLE newsletter_provider_operations (
  operation_key TEXT PRIMARY KEY,
  send_id INTEGER NOT NULL,
  queue_claim_key TEXT,
  delivery_ids_json TEXT NOT NULL,
  request_body TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  provider_result TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','accepted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (send_id) REFERENCES newsletter_sends(id)
);

CREATE INDEX IF NOT EXISTS idx_newsletter_provider_operations_expiry ON newsletter_provider_operations(expires_at);
