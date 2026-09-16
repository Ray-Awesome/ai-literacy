-- Apply after 0005 so existing provider operations can be settled without
-- confusing an unresolved provider acceptance with a known rejection.
ALTER TABLE newsletter_provider_operations ADD COLUMN outcome TEXT NOT NULL DEFAULT 'pending'
  CHECK(outcome IN ('pending','accepted','rejected'));
ALTER TABLE newsletter_provider_operations ADD COLUMN settled_at TEXT;
