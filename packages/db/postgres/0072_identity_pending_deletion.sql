ALTER TABLE savia_core.identity_principal ADD COLUMN deletion_started_at TEXT
  CHECK (deletion_started_at IS NULL OR is_active=0);
