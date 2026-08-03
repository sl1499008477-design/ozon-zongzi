CREATE TABLE IF NOT EXISTS ai_content_strategy_versions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  strategy_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  content JSONB NOT NULL DEFAULT '{}'::JSONB,
  content_hash TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  published_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, strategy_key, version)
);

CREATE TABLE IF NOT EXISTS ai_content_strategy_rules (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  strategy_version_id TEXT NOT NULL REFERENCES ai_content_strategy_versions(id) ON DELETE CASCADE,
  rule_kind TEXT NOT NULL CHECK (rule_kind IN ('EXACT_CATEGORY', 'ANCESTOR_CATEGORY', 'PRODUCT_STYLE')),
  rule_order INTEGER NOT NULL CHECK (rule_order > 0),
  category_id TEXT,
  ancestor_category_id TEXT,
  product_style TEXT,
  rule JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (strategy_version_id, rule_order)
);

CREATE TABLE IF NOT EXISTS auto_listing_source_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('COLLECT_BOX', 'EXCEL_SKU')),
  source_record_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  snapshot_hash TEXT NOT NULL,
  raw_response_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, source_type, source_record_id, source_version)
);

CREATE TABLE IF NOT EXISTS auto_listing_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('COLLECT_BOX', 'EXCEL_SKU')),
  status TEXT NOT NULL DEFAULT 'CREATED',
  idempotency_key TEXT NOT NULL,
  config_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  config_hash TEXT NOT NULL,
  strategy_version_id TEXT REFERENCES ai_content_strategy_versions(id) ON DELETE RESTRICT,
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS auto_listing_job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES auto_listing_jobs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES auto_listing_source_snapshots(id) ON DELETE RESTRICT,
  target_store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  target_warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED', 'SOURCE_READY', 'PLANNING', 'GENERATING', 'READY_FOR_REVIEW', 'UPLOAD_QUEUED', 'UPLOADING', 'SUCCEEDED', 'RETRYABLE_ERROR', 'BLOCKED', 'CANCELLED')),
  status_version INTEGER NOT NULL DEFAULT 1 CHECK (status_version > 0),
  visual_group_count INTEGER NOT NULL DEFAULT 0 CHECK (visual_group_count >= 0),
  failure_code TEXT,
  failure_detail_safe TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auto_listing_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES auto_listing_jobs(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES auto_listing_job_items(id) ON DELETE CASCADE,
  actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  from_status TEXT,
  to_status TEXT,
  event_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auto_listing_jobs_account_status_idx
  ON auto_listing_jobs(account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS auto_listing_jobs_strategy_version_idx
  ON auto_listing_jobs(strategy_version_id);
CREATE INDEX IF NOT EXISTS auto_listing_source_snapshots_account_source_idx
  ON auto_listing_source_snapshots(account_id, source_type, source_record_id);
CREATE INDEX IF NOT EXISTS auto_listing_job_items_job_status_idx
  ON auto_listing_job_items(job_id, status, created_at);
CREATE INDEX IF NOT EXISTS auto_listing_job_items_account_store_status_idx
  ON auto_listing_job_items(account_id, target_store_id, status);
CREATE INDEX IF NOT EXISTS auto_listing_events_job_created_idx
  ON auto_listing_events(job_id, created_at);
CREATE INDEX IF NOT EXISTS auto_listing_events_item_created_idx
  ON auto_listing_events(item_id, created_at)
  WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_content_strategy_versions_account_status_idx
  ON ai_content_strategy_versions(account_id, strategy_key, status, version DESC);
CREATE INDEX IF NOT EXISTS ai_content_strategy_rules_version_order_idx
  ON ai_content_strategy_rules(strategy_version_id, rule_order);
