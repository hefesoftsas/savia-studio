ALTER TABLE savia_core.identity_principal ADD COLUMN platform_admin_revoked BIGINT NOT NULL DEFAULT 0
  CHECK (platform_admin_revoked IN (0, 1));
