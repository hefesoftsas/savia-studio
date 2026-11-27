ALTER TABLE savia_core.tenants ADD COLUMN purge_token TEXT CHECK (purge_token IS NULL OR is_active=0);

CREATE FUNCTION savia_core.guard_tenant_purge_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.purge_token IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.id_slug IS DISTINCT FROM OLD.id_slug
    OR NEW.name IS DISTINCT FROM OLD.name OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.is_active IS DISTINCT FROM OLD.is_active
    OR NEW.purge_token IS DISTINCT FROM OLD.purge_token
  ) THEN
    RAISE EXCEPTION 'TENANT_PURGE_IN_PROGRESS' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_purge_identity_guard
BEFORE UPDATE OF id,id_slug,name,kind,is_active,purge_token ON savia_core.tenants
FOR EACH ROW EXECUTE FUNCTION savia_core.guard_tenant_purge_identity();
