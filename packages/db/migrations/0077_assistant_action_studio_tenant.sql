ALTER TABLE assistant_pending_actions
  ADD COLUMN studio_tenant_id INTEGER CHECK (
    studio_tenant_id IS NULL OR studio_tenant_id >= 0
  );
