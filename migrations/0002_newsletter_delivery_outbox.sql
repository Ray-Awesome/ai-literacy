-- Apply once to D1 databases created before Task 6. New databases receive these columns from schema.sql.
ALTER TABLE newsletter_deliveries ADD COLUMN queued_at TEXT;
ALTER TABLE newsletter_deliveries ADD COLUMN queue_claim_key TEXT;
ALTER TABLE newsletter_deliveries ADD COLUMN queue_claimed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_newsletter_deliveries_queue_claim
  ON newsletter_deliveries(send_id, status, queued_at, queue_claim_key);
