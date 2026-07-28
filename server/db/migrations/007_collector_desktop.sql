CREATE TABLE IF NOT EXISTS collector_devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, device_key)
);

CREATE INDEX IF NOT EXISTS collector_devices_account_status_idx
  ON collector_devices(account_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS collector_tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operating_store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  data_collection_store_id TEXT REFERENCES data_collection_stores(id) ON DELETE RESTRICT,
  name TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL CHECK (task_type <> ''),
  source TEXT NOT NULL DEFAULT 'ozon',
  status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN (
    'NOT_STARTED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'
  )),
  status_version INTEGER NOT NULL DEFAULT 1 CHECK (status_version > 0),
  concurrency INTEGER NOT NULL DEFAULT 4 CHECK (concurrency BETWEEN 1 AND 64),
  current_run_id TEXT,
  configuration JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS collector_tasks_account_status_idx
  ON collector_tasks(account_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS collector_tasks_scope_idx
  ON collector_tasks(account_id, operating_store_id, data_collection_store_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS collector_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES collector_tasks(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operating_store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  data_collection_store_id TEXT NOT NULL REFERENCES data_collection_stores(id) ON DELETE RESTRICT,
  pricing_config_version_id TEXT NOT NULL REFERENCES pricing_config_versions(id) ON DELETE RESTRICT,
  run_no INTEGER NOT NULL CHECK (run_no > 0),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN (
    'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'
  )),
  status_version INTEGER NOT NULL DEFAULT 1 CHECK (status_version > 0),
  idempotency_key TEXT NOT NULL DEFAULT '',
  configuration_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  claimed_by_device_id TEXT REFERENCES collector_devices(id) ON DELETE SET NULL,
  lease_token_hash TEXT NOT NULL DEFAULT '',
  lock_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  claim_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  qualified_count INTEGER NOT NULL DEFAULT 0 CHECK (qualified_count >= 0),
  filtered_count INTEGER NOT NULL DEFAULT 0 CHECK (filtered_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  result_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, run_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS collector_task_runs_idempotency_uq
  ON collector_task_runs(account_id, idempotency_key)
  WHERE idempotency_key <> '';

CREATE UNIQUE INDEX IF NOT EXISTS collector_task_runs_active_task_uq
  ON collector_task_runs(task_id)
  WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX IF NOT EXISTS collector_task_runs_claim_idx
  ON collector_task_runs(account_id, status, lock_expires_at, queued_at);

CREATE INDEX IF NOT EXISTS collector_task_runs_scope_idx
  ON collector_task_runs(account_id, operating_store_id, data_collection_store_id, created_at DESC);

ALTER TABLE collector_tasks
  ADD CONSTRAINT collector_tasks_current_run_fk
  FOREIGN KEY (current_run_id) REFERENCES collector_task_runs(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS collector_task_items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES collector_tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES collector_task_runs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operating_store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  data_collection_store_id TEXT NOT NULL REFERENCES data_collection_stores(id) ON DELETE RESTRICT,
  collect_item_id TEXT REFERENCES collect_items(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'ozon',
  source_key TEXT NOT NULL,
  source_sku TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN (
    'DISCOVERED', 'ENRICHED', 'QUALIFIED', 'FILTERED_OUT', 'FAILED'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  analytics JSONB NOT NULL DEFAULT '{}'::JSONB,
  sourcing JSONB NOT NULL DEFAULT '{}'::JSONB,
  pricing JSONB NOT NULL DEFAULT '{}'::JSONB,
  filter_result JSONB NOT NULL DEFAULT '{}'::JSONB,
  export_data JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, source, source_key)
);

CREATE INDEX IF NOT EXISTS collector_task_items_run_status_idx
  ON collector_task_items(account_id, run_id, status, sort_order, created_at);

CREATE INDEX IF NOT EXISTS collector_task_items_source_sku_idx
  ON collector_task_items(account_id, data_collection_store_id, source, source_sku)
  WHERE source_sku <> '';

CREATE INDEX IF NOT EXISTS collector_task_items_collect_item_idx
  ON collector_task_items(collect_item_id)
  WHERE collect_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS collector_task_events (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES collector_tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES collector_task_runs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operating_store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  data_collection_store_id TEXT REFERENCES data_collection_stores(id) ON DELETE RESTRICT,
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'INFO' CHECK (level IN ('DEBUG', 'INFO', 'WARN', 'ERROR')),
  message TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS collector_task_events_run_created_idx
  ON collector_task_events(account_id, run_id, created_at, id);

CREATE INDEX IF NOT EXISTS collector_task_events_task_created_idx
  ON collector_task_events(account_id, task_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS collector_exports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES collector_tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES collector_task_runs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operating_store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  data_collection_store_id TEXT NOT NULL REFERENCES data_collection_stores(id) ON DELETE RESTRICT,
  file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'GENERATING', 'READY', 'FAILED')),
  format TEXT NOT NULL DEFAULT 'xlsx',
  file_name TEXT NOT NULL DEFAULT '',
  object_key TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
  sha256 TEXT NOT NULL DEFAULT '',
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (run_id, version)
);

CREATE INDEX IF NOT EXISTS collector_exports_account_created_idx
  ON collector_exports(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collector_market_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES collector_tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES collector_task_runs(id) ON DELETE SET NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operating_store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  data_collection_store_id TEXT NOT NULL REFERENCES data_collection_stores(id) ON DELETE RESTRICT,
  seller_company_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ozon_seller_analytics',
  snapshot_key TEXT NOT NULL,
  source_sku TEXT NOT NULL DEFAULT '',
  product_id TEXT NOT NULL DEFAULT '',
  category_id TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL CHECK (period IN ('WEEKLY', 'MONTHLY')),
  period_start DATE,
  period_end DATE,
  request_id TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
  payload JSONB NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, operating_store_id, data_collection_store_id, snapshot_key)
);

CREATE INDEX IF NOT EXISTS collector_market_snapshots_lookup_idx
  ON collector_market_snapshots(account_id, data_collection_store_id, period, category_id, collected_at DESC);

CREATE INDEX IF NOT EXISTS collector_market_snapshots_sku_idx
  ON collector_market_snapshots(account_id, data_collection_store_id, source_sku, collected_at DESC)
  WHERE source_sku <> '';

CREATE TABLE IF NOT EXISTS collector_category_mappings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operating_store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  data_collection_store_id TEXT NOT NULL REFERENCES data_collection_stores(id) ON DELETE RESTRICT,
  source TEXT NOT NULL DEFAULT 'ozon_seller_analytics',
  root_category_id TEXT NOT NULL,
  root_category_name TEXT NOT NULL DEFAULT '',
  leaf_category_id TEXT NOT NULL,
  leaf_category_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (
    account_id, operating_store_id, data_collection_store_id,
    source, root_category_id, leaf_category_id
  )
);

CREATE INDEX IF NOT EXISTS collector_category_mappings_lookup_idx
  ON collector_category_mappings(
    account_id, operating_store_id, data_collection_store_id,
    source, root_category_id, status, leaf_category_name
  );
