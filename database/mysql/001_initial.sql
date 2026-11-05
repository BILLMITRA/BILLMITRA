-- BillMitra central database for MySQL 8.4 LTS.
-- Run on an empty billmitra database with a dedicated application account.
-- Amounts are integer paise; timestamps are UTC; IDs are application UUID strings.
-- Every operational query must include branch_id and check the authenticated branch.

CREATE TABLE schema_migrations (
  version INT UNSIGNED PRIMARY KEY,
  applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE restaurants (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  legal_name VARCHAR(160) NOT NULL,
  trading_name VARCHAR(160) NOT NULL,
  gstin VARCHAR(20) NOT NULL DEFAULT '',
  fssai_number VARCHAR(30) NOT NULL DEFAULT '',
  phone VARCHAR(30) NOT NULL DEFAULT '',
  email VARCHAR(160) NOT NULL DEFAULT '',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE branches (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  restaurant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  address TEXT NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  currency_code CHAR(3) CHARACTER SET ascii NOT NULL DEFAULT 'INR',
  invoice_prefix VARCHAR(16) NOT NULL DEFAULT 'INV',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_branches_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  INDEX branches_restaurant (restaurant_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  restaurant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  username VARCHAR(80) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  role ENUM('owner','manager','cashier','waiter','kitchen','inventory','accountant') NOT NULL,
  password_salt VARCHAR(128) CHARACTER SET ascii NOT NULL,
  password_hash VARCHAR(256) CHARACTER SET ascii NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until TIMESTAMP(6) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY staff_restaurant_username (restaurant_id, username),
  CONSTRAINT fk_staff_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_branch_access (
  staff_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (staff_id, branch_id),
  CONSTRAINT fk_access_staff FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_access_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE customers (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  restaurant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL DEFAULT '',
  phone VARCHAR(30) NOT NULL DEFAULT '',
  normalized_phone VARCHAR(30) CHARACTER SET ascii NOT NULL DEFAULT '',
  email VARCHAR(160) NOT NULL DEFAULT '',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_customers_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  INDEX customers_phone (restaurant_id, normalized_phone),
  INDEX customers_name (restaurant_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE customer_addresses (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  customer_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  address TEXT NOT NULL,
  area VARCHAR(120) NOT NULL DEFAULT '',
  landmark VARCHAR(160) NOT NULL DEFAULT '',
  instructions VARCHAR(300) NOT NULL DEFAULT '',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_address_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  INDEX addresses_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE menu_categories (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  restaurant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_category_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  INDEX category_order (restaurant_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE menu_items (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  restaurant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  tax_rate_bps INT UNSIGNED NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT menu_item_tax CHECK (tax_rate_bps <= 10000),
  CONSTRAINT fk_item_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  CONSTRAINT fk_item_category FOREIGN KEY (category_id) REFERENCES menu_categories(id),
  INDEX items_category (category_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE branch_menu_prices (
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  price_paise BIGINT UNSIGNED NOT NULL,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (branch_id, item_id),
  CONSTRAINT fk_price_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_price_item FOREIGN KEY (item_id) REFERENCES menu_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE floors (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(80) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY floor_branch_name (branch_id, name),
  CONSTRAINT fk_floor_branch FOREIGN KEY (branch_id) REFERENCES branches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE dining_tables (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  floor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  label VARCHAR(20) NOT NULL,
  capacity INT UNSIGNED NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE KEY table_branch_label (branch_id, label),
  CONSTRAINT table_capacity CHECK (capacity > 0),
  CONSTRAINT fk_table_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_table_floor FOREIGN KEY (floor_id) REFERENCES floors(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE orders (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_number BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  order_type ENUM('dine_in','parcel','delivery') NOT NULL,
  status ENUM('ordering','preparing','ready','payment_pending','paid','voided','joined') NOT NULL DEFAULT 'ordering',
  table_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  service_slot SMALLINT UNSIGNED NULL,
  customer_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  customer_name VARCHAR(120) NOT NULL DEFAULT '',
  contact_number VARCHAR(30) NOT NULL DEFAULT '',
  delivery_address TEXT NOT NULL,
  delivery_area VARCHAR(120) NOT NULL DEFAULT '',
  delivery_landmark VARCHAR(160) NOT NULL DEFAULT '',
  delivery_instructions VARCHAR(300) NOT NULL DEFAULT '',
  subtotal_paise BIGINT UNSIGNED NOT NULL DEFAULT 0,
  discount_paise BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tax_paise BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_paise BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  paid_at TIMESTAMP(6) NULL,
  voided_at TIMESTAMP(6) NULL,
  void_reason VARCHAR(250) NOT NULL DEFAULT '',
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY orders_branch_number (branch_id, display_number),
  UNIQUE KEY orders_branch_request (branch_id, request_id),
  CONSTRAINT order_service_slot CHECK (service_slot IS NULL OR service_slot BETWEEN 1 AND 100),
  CONSTRAINT fk_order_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_order_table FOREIGN KEY (table_id) REFERENCES dining_tables(id),
  CONSTRAINT fk_order_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  INDEX orders_branch_status (branch_id, status, created_at),
  INDEX orders_branch_slot (branch_id, order_type, service_slot, paid_at, voided_at),
  INDEX orders_branch_phone (branch_id, contact_number),
  INDEX orders_branch_customer (branch_id, customer_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE order_items (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  menu_item_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  item_name VARCHAR(160) NOT NULL,
  unit_price_paise BIGINT UNSIGNED NOT NULL,
  tax_rate_bps INT UNSIGNED NOT NULL,
  quantity SMALLINT UNSIGNED NOT NULL,
  note VARCHAR(200) NOT NULL DEFAULT '',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT order_item_qty CHECK (quantity > 0),
  CONSTRAINT order_item_tax CHECK (tax_rate_bps <= 10000),
  CONSTRAINT fk_order_item_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_order_item_menu FOREIGN KEY (menu_item_id) REFERENCES menu_items(id),
  INDEX order_items_order (order_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE payment_tenders (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  method ENUM('cash','card','upi') NOT NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  received_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT tender_positive CHECK (amount_paise > 0),
  CONSTRAINT fk_tender_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_tender_staff FOREIGN KEY (received_by) REFERENCES staff_users(id),
  INDEX tenders_order (order_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE payment_refunds (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tender_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  amount_paise BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(250) NOT NULL,
  approved_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT refund_positive CHECK (amount_paise > 0),
  CONSTRAINT fk_refund_tender FOREIGN KEY (tender_id) REFERENCES payment_tenders(id),
  CONSTRAINT fk_refund_staff FOREIGN KEY (approved_by) REFERENCES staff_users(id),
  INDEX refunds_tender (tender_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE document_sequences (
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  financial_year CHAR(7) CHARACTER SET ascii NOT NULL,
  document_type ENUM('invoice','credit_note') NOT NULL,
  next_number BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (branch_id, financial_year, document_type),
  CONSTRAINT sequence_positive CHECK (next_number > 0),
  CONSTRAINT fk_sequence_branch FOREIGN KEY (branch_id) REFERENCES branches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sales_documents (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  document_type ENUM('invoice','credit_note') NOT NULL,
  document_number VARCHAR(50) NOT NULL,
  issued_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  issued_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_snapshot JSON NOT NULL,
  customer_snapshot JSON NOT NULL,
  totals_snapshot JSON NOT NULL,
  items_snapshot JSON NOT NULL,
  UNIQUE KEY document_branch_number (branch_id, document_number),
  CONSTRAINT fk_document_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_document_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_document_staff FOREIGN KEY (issued_by) REFERENCES staff_users(id),
  INDEX documents_order (order_id),
  INDEX documents_issued (branch_id, issued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE delivery_riders (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(30) NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT fk_rider_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  INDEX riders_branch (branch_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE delivery_assignments (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rider_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assigned_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assigned_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  ended_at TIMESTAMP(6) NULL,
  CONSTRAINT fk_assignment_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_assignment_rider FOREIGN KEY (rider_id) REFERENCES delivery_riders(id),
  CONSTRAINT fk_assignment_staff FOREIGN KEY (assigned_by) REFERENCES staff_users(id),
  INDEX assignments_rider_open (rider_id, ended_at, assigned_at),
  INDEX assignments_order (order_id, assigned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE cash_shifts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  opened_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  closed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  opening_float_paise BIGINT UNSIGNED NOT NULL DEFAULT 0,
  expected_cash_paise BIGINT NOT NULL DEFAULT 0,
  counted_cash_paise BIGINT UNSIGNED NULL,
  opened_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  closed_at TIMESTAMP(6) NULL,
  note VARCHAR(300) NOT NULL DEFAULT '',
  CONSTRAINT fk_shift_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_shift_opened FOREIGN KEY (opened_by) REFERENCES staff_users(id),
  CONSTRAINT fk_shift_closed FOREIGN KEY (closed_by) REFERENCES staff_users(id),
  INDEX shifts_branch_open (branch_id, closed_at, opened_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE inventory_items (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(160) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  quantity_milli BIGINT NOT NULL DEFAULT 0,
  reorder_at_milli BIGINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT fk_inventory_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  UNIQUE KEY inventory_branch_name (branch_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE stock_movements (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  item_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  delta_milli BIGINT NOT NULL,
  reason VARCHAR(250) NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_stock_item FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  CONSTRAINT fk_stock_actor FOREIGN KEY (actor_id) REFERENCES staff_users(id),
  INDEX stock_item_time (item_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE audit_events (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  event_type VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason VARCHAR(250) NOT NULL DEFAULT '',
  details JSON NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_audit_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES staff_users(id),
  INDEX audit_branch_time (branch_id, created_at),
  INDEX audit_entity (entity_type, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE device_sync_requests (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  branch_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action VARCHAR(80) NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json JSON NOT NULL,
  completed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY sync_device_request (branch_id, device_id, request_id),
  CONSTRAINT fk_sync_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  INDEX sync_branch_time (branch_id, completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO schema_migrations(version) VALUES (1);
