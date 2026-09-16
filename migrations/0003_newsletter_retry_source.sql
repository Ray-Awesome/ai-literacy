-- Apply after 0002 to existing D1 databases.
ALTER TABLE newsletter_sends ADD COLUMN source_send_id INTEGER;
