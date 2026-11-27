CREATE TABLE identity_access_change_leases (
  principal_id TEXT NOT NULL PRIMARY KEY REFERENCES identity_principal(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL
);
