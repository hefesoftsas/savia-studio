ALTER TABLE identity_principal ADD COLUMN platform_admin_revoked INTEGER NOT NULL DEFAULT 0
  CHECK (platform_admin_revoked IN (0, 1));
