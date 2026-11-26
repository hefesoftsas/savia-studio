CREATE INDEX notification_deliveries_retention
  ON notification_deliveries (created_at, id);
