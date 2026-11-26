CREATE TRIGGER notification_collection_follows_deleted
AFTER DELETE ON studio_objects
BEGIN
  DELETE FROM notification_subscriptions
  WHERE workspace_id=OLD.tenant_id AND collection=OLD.name;
END;
