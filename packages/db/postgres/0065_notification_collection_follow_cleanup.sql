CREATE FUNCTION savia_core.notification_collection_follows_deleted_fn()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM savia_core.notification_subscriptions
  WHERE workspace_id=OLD.tenant_id AND collection=OLD.name;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER notification_collection_follows_deleted
AFTER DELETE ON savia_core.studio_objects
FOR EACH ROW EXECUTE FUNCTION savia_core.notification_collection_follows_deleted_fn();
