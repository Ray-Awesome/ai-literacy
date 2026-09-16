-- Approved-maintenance SQL. Back up D1 and obtain privacy-owner approval first.
-- Run as one transaction with foreign keys enabled. This is intentionally not automatic.
BEGIN;
DELETE FROM newsletter_confirmation_challenges WHERE created_at < datetime('now', '-30 days');
DELETE FROM newsletter_confirmation_delivery_state WHERE updated_at < datetime('now', '-30 days');
DELETE FROM newsletter_webhook_events WHERE created_at < datetime('now', '-90 days');
UPDATE newsletter_deliveries SET error_code = NULL, error_message = NULL
WHERE updated_at < datetime('now', '-90 days');
-- The terminal-send target/delivery history is retained for 24 months, then purged.
DELETE FROM newsletter_deliveries WHERE send_id IN (
  SELECT id FROM newsletter_sends
  WHERE status IN ('completed','partial','failed') AND completed_at < datetime('now', '-24 months')
);
-- A newer retry may refer to an expired source; preserve the retry and sever only that link.
UPDATE newsletter_sends SET source_send_id = NULL WHERE source_send_id IN (
  SELECT id FROM newsletter_sends
  WHERE status IN ('completed','partial','failed') AND completed_at < datetime('now', '-24 months')
);
DELETE FROM newsletter_sends
WHERE status IN ('completed','partial','failed') AND completed_at < datetime('now', '-24 months')
  AND NOT EXISTS (SELECT 1 FROM newsletter_deliveries d WHERE d.send_id = newsletter_sends.id);
-- Immutable editorial content remains with its send history for 24 months; delete only
-- old terminal newsletters with no remaining sends. Drafts remain under editorial control.
DELETE FROM newsletters
WHERE status IN ('sent','failed') AND sent_at < datetime('now', '-24 months')
  AND NOT EXISTS (SELECT 1 FROM newsletter_sends s WHERE s.newsletter_id = newsletters.id);
COMMIT;
