CREATE INDEX notification_deliveries_retention
  ON savia_core.notification_deliveries (created_at, id);
