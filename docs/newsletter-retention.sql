DELETE FROM newsletter_confirmation_challenges WHERE created_at < datetime('now', '-30 days');
DELETE FROM newsletter_confirmation_delivery_state WHERE updated_at < datetime('now', '-30 days');
DELETE FROM newsletter_webhook_events WHERE created_at < datetime('now', '-90 days');
UPDATE newsletter_deliveries SET error_code = NULL, error_message = NULL WHERE updated_at < datetime('now', '-90 days');

-- Provider operation bodies are server-only data. Purge only settled, accepted
-- operations after 30 days; retain pending or indeterminate evidence for an
-- authorized provider reconciliation before allowing its parent send to age out.
DELETE FROM newsletter_provider_operations
WHERE expires_at <= datetime('now') AND status = 'accepted'
  AND NOT EXISTS (
    SELECT 1 FROM newsletter_deliveries AS delivery
    WHERE delivery.send_id = newsletter_provider_operations.send_id
      AND (delivery.status = 'pending' OR delivery.delivery_certainty = 'indeterminate')
  );

-- Protect sends and delivery evidence that still have a retained provider
-- operation. This keeps the following terminal-history deletes FK-safe.
UPDATE newsletter_sends SET source_send_id = NULL
WHERE source_send_id IN (
  SELECT old_send.id FROM newsletter_sends AS old_send
  WHERE old_send.status IN ('completed','partial','failed')
    AND old_send.completed_at < datetime('now', '-24 months')
    AND NOT EXISTS (SELECT 1 FROM newsletter_provider_operations AS operation WHERE operation.send_id = old_send.id)
);
DELETE FROM newsletter_deliveries
WHERE send_id IN (
  SELECT old_send.id FROM newsletter_sends AS old_send
  WHERE old_send.status IN ('completed','partial','failed')
    AND old_send.completed_at < datetime('now', '-24 months')
    AND NOT EXISTS (SELECT 1 FROM newsletter_provider_operations AS operation WHERE operation.send_id = old_send.id)
);
DELETE FROM newsletter_sends
WHERE status IN ('completed','partial','failed') AND completed_at < datetime('now', '-24 months')
  AND NOT EXISTS (SELECT 1 FROM newsletter_deliveries AS delivery WHERE delivery.send_id = newsletter_sends.id)
  AND NOT EXISTS (SELECT 1 FROM newsletter_provider_operations AS operation WHERE operation.send_id = newsletter_sends.id);
DELETE FROM newsletters
WHERE ((status = 'sent' AND sent_at < datetime('now', '-24 months')) OR (status = 'failed' AND updated_at < datetime('now', '-24 months')))
  AND NOT EXISTS (SELECT 1 FROM newsletter_sends AS send WHERE send.newsletter_id = newsletters.id);
