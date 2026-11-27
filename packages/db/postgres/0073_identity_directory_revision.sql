CREATE TABLE savia_core.identity_directory_revision (
  id BIGINT NOT NULL PRIMARY KEY CHECK (id = 1),
  revision BIGINT NOT NULL CHECK (revision >= 0)
);
