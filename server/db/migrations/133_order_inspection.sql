-- Rules and read receipts are account-owned; detected orders stay in orders.
CREATE TABLE order_inspection_settings (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  prefixes TEXT[] NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE order_inspection_reads (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL CHECK(order_number<>''),
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(account_id,store_id,order_number)
);
CREATE TABLE order_inspection_sync (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  state JSONB NOT NULL,
  next_run_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(account_id,store_id)
);
CREATE INDEX order_inspection_sync_due_idx ON order_inspection_sync(next_run_at);
CREATE INDEX orders_inspection_prefix_idx ON orders(store_id,
  (LEFT(COALESCE(NULLIF(management_data->>'orderNumber',''),raw->>'order_number',''),5)));
