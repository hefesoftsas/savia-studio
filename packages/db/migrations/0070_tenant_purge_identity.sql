ALTER TABLE tenants ADD COLUMN purge_token TEXT CHECK (purge_token IS NULL OR is_active=0);
--> statement-breakpoint
CREATE TRIGGER tenant_purge_identity_guard
BEFORE UPDATE OF id,id_slug,name,kind,is_active,purge_token ON tenants
WHEN OLD.purge_token IS NOT NULL AND (
  NEW.id IS NOT OLD.id OR NEW.id_slug IS NOT OLD.id_slug OR NEW.name IS NOT OLD.name
  OR NEW.kind IS NOT OLD.kind OR NEW.is_active IS NOT OLD.is_active
  OR NEW.purge_token IS NOT OLD.purge_token
)
BEGIN
  SELECT RAISE(ABORT, 'TENANT_PURGE_IN_PROGRESS');
END;
