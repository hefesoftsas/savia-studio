CREATE TABLE studio_file_deletions (
  storage_key TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX studio_file_deletions_due ON studio_file_deletions(next_attempt_at, storage_key);
--> statement-breakpoint
CREATE INDEX studio_file_deletions_file ON studio_file_deletions(tenant_id, file_id, storage_key);
