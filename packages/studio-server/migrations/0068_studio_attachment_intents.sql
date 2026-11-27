ALTER TABLE studio_file_drafts ADD COLUMN created_by TEXT;
--> statement-breakpoint
ALTER TABLE studio_file_drafts ADD COLUMN target_record_id TEXT;
--> statement-breakpoint
ALTER TABLE studio_file_drafts ADD COLUMN create_request_key TEXT;
--> statement-breakpoint
ALTER TABLE studio_files ADD COLUMN created_by TEXT;
--> statement-breakpoint
ALTER TABLE studio_files ADD COLUMN create_request_key TEXT;
