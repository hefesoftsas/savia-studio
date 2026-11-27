ALTER TABLE savia_core.assistant_pending_actions
  ADD COLUMN studio_tenant_id BIGINT CHECK (
    studio_tenant_id IS NULL OR studio_tenant_id >= 0
  );
