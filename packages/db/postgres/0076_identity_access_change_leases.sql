CREATE TABLE savia_core.identity_access_change_leases (
  principal_id TEXT NOT NULL PRIMARY KEY REFERENCES savia_core.identity_principal(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL,
  lease_until BIGINT NOT NULL
);
