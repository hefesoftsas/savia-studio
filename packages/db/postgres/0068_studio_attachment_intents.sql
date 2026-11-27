ALTER TABLE savia_core.studio_file_drafts ADD COLUMN created_by TEXT;
ALTER TABLE savia_core.studio_file_drafts ADD COLUMN target_record_id TEXT;
ALTER TABLE savia_core.studio_file_drafts ADD COLUMN create_request_key TEXT;
ALTER TABLE savia_core.studio_files ADD COLUMN created_by TEXT;
ALTER TABLE savia_core.studio_files ADD COLUMN create_request_key TEXT;
