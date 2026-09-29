CREATE TABLE ozon_promotion_stores (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  config JSONB NOT NULL,
  snapshot JSONB NOT NULL DEFAULT '{"actions":[],"products":[],"memberships":[]}',
  state JSONB NOT NULL DEFAULT '{}',
  sync_requested BOOLEAN NOT NULL DEFAULT TRUE,
  next_sync_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,store_id)
);

CREATE TABLE ozon_promotion_rules (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  body JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  next_run_at BIGINT,
  last_run_at BIGINT,
  created_at BIGINT NOT NULL,
  FOREIGN KEY(account_id,store_id) REFERENCES ozon_promotion_stores(account_id,store_id) ON DELETE CASCADE
);
CREATE INDEX ozon_promotion_rules_store ON ozon_promotion_rules(account_id,store_id,next_run_at);

CREATE TABLE ozon_promotion_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('RULE','EXIT','FLOORS')),
  status TEXT NOT NULL CHECK(status IN ('PREVIEW','QUEUED','RUNNING','COMPLETED','PARTIAL','FAILED','UNCERTAIN','CANCELLED')),
  schedule_rule_id TEXT,
  schedule_slot BIGINT,
  body JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY(account_id,store_id) REFERENCES ozon_promotion_stores(account_id,store_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ozon_promotion_runs_slot ON ozon_promotion_runs(account_id,store_id,schedule_rule_id,schedule_slot) WHERE schedule_rule_id IS NOT NULL;
CREATE INDEX ozon_promotion_runs_store ON ozon_promotion_runs(account_id,store_id,created_at DESC);
CREATE INDEX ozon_promotion_runs_pending ON ozon_promotion_runs(updated_at) WHERE status IN ('QUEUED','RUNNING');
