CREATE TABLE identity_directory_revision (
  id BIGINT NOT NULL PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
