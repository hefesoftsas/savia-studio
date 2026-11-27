CREATE TABLE savia_core.tenant_deletion_leases (
  tenant_id BIGINT NOT NULL PRIMARY KEY REFERENCES savia_core.tenants(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL,
  lease_until BIGINT NOT NULL
);
