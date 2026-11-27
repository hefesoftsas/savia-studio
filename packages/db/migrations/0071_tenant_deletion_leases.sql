CREATE TABLE tenant_deletion_leases (
  tenant_id BIGINT NOT NULL PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL
);
