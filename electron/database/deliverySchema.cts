export const deliverySchemaMigration = `
  CREATE TABLE delivery_riders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    employee_code TEXT COLLATE NOCASE UNIQUE,
    contact_number TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    availability TEXT NOT NULL DEFAULT 'available'
      CHECK (availability IN ('available', 'unavailable', 'off_shift')),
    max_active_deliveries INTEGER NOT NULL DEFAULT 1 CHECK (max_active_deliveries > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  ALTER TABLE orders ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'assigned', 'dispatched', 'delivered', 'failed', 'cancelled'));
  ALTER TABLE orders ADD COLUMN delivery_rider_id TEXT REFERENCES delivery_riders(id);
  ALTER TABLE orders ADD COLUMN scheduled_pickup_at TEXT;
  ALTER TABLE orders ADD COLUMN ready_for_pickup_at TEXT;
  ALTER TABLE orders ADD COLUMN actual_pickup_at TEXT;
  ALTER TABLE orders ADD COLUMN dispatched_at TEXT;
  ALTER TABLE orders ADD COLUMN delivered_at TEXT;
  ALTER TABLE orders ADD COLUMN delivery_area TEXT NOT NULL DEFAULT '';
  ALTER TABLE orders ADD COLUMN delivery_landmark TEXT NOT NULL DEFAULT '';
  ALTER TABLE orders ADD COLUMN delivery_instructions TEXT NOT NULL DEFAULT '';

  CREATE INDEX delivery_riders_active ON delivery_riders(active, availability, name);
  CREATE INDEX orders_delivery_schedule ON orders(type, delivery_status, scheduled_delivery_at, created_at);

  CREATE TABLE delivery_events (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    event_type TEXT NOT NULL CHECK (event_type IN (
      'schedule_updated', 'customer_details_updated', 'ready_for_pickup', 'assigned',
      'reassigned', 'dispatched', 'delivered', 'failed', 'cancelled'
    )),
    previous_status TEXT,
    new_status TEXT,
    previous_rider_id TEXT REFERENCES delivery_riders(id),
    new_rider_id TEXT REFERENCES delivery_riders(id),
    actor_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX delivery_events_order_created ON delivery_events(order_id, created_at DESC);
`
