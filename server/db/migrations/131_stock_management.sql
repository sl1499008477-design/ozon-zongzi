CREATE TABLE ozon_stock_changes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  product_id TEXT NOT NULL,
  request JSONB NOT NULL,
  body JSONB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','PARTIAL','FAILED','UNCERTAIN','CLOSED')),
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ozon_stock_changes_due_idx ON ozon_stock_changes(next_run_at) WHERE next_run_at IS NOT NULL;
CREATE INDEX ozon_stock_changes_history_idx ON ozon_stock_changes(account_id,store_id,product_id,created_at DESC);
CREATE UNIQUE INDEX ozon_stock_changes_pending_idx ON ozon_stock_changes(account_id,store_id,product_id)
  WHERE status IN ('QUEUED','RUNNING','UNCERTAIN');
