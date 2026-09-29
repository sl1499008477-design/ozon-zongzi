-- Additive only: the historical orders/raw and order_items contracts are retained.
-- A separate management snapshot prevents legacy cache mirrors from replacing a
-- newer order-management sync. Costs live outside either platform snapshot.
ALTER TABLE orders ADD COLUMN management_data JSONB;
ALTER TABLE orders ADD COLUMN purchase_costs JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX orders_management_date_idx ON orders(store_id,in_process_at DESC,posting_number);

CREATE TABLE ozon_product_costs (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  unit_cost_cny NUMERIC(18,2) CHECK(unit_cost_cny>=0),
  auto_apply BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(account_id,store_id,product_id)
);

CREATE TABLE ozon_order_management_sync (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  state JSONB NOT NULL,
  next_run_at TIMESTAMPTZ,
  PRIMARY KEY(account_id,store_id)
);
CREATE INDEX ozon_order_management_sync_due_idx ON ozon_order_management_sync(next_run_at)
  WHERE next_run_at IS NOT NULL;
