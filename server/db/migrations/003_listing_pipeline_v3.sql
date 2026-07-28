CREATE TABLE IF NOT EXISTS collect_raw_payloads (
  id TEXT PRIMARY KEY,
  collect_item_id TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  data_collection_store_id TEXT NOT NULL DEFAULT '',
  source_sku TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  payload_hash TEXT NOT NULL,
  collector_version TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL,
  collected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(collect_item_id, payload_hash)
);

CREATE INDEX IF NOT EXISTS collect_raw_payloads_item_idx
  ON collect_raw_payloads(collect_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collect_raw_payloads_store_sku_idx
  ON collect_raw_payloads(store_id, source_sku);

CREATE TABLE IF NOT EXISTS collect_items (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  data_collection_store_id TEXT NOT NULL DEFAULT '',
  source_sku TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'COLLECTED',
  current_draft_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  summary JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS collect_items_account_status_idx
  ON collect_items(account_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS collect_items_store_status_idx
  ON collect_items(store_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS product_drafts (
  id TEXT PRIMARY KEY,
  collect_item_id TEXT NOT NULL UNIQUE REFERENCES collect_items(id) ON DELETE CASCADE,
  source_payload_id TEXT REFERENCES collect_raw_payloads(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  data_hash TEXT NOT NULL,
  data JSONB NOT NULL,
  normalizer_version TEXT NOT NULL DEFAULT 'v3',
  category_rule_version TEXT NOT NULL DEFAULT '',
  dictionary_version TEXT NOT NULL DEFAULT '',
  rich_content_rule_version TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE collect_items
  ADD CONSTRAINT collect_items_current_draft_fk
  FOREIGN KEY (current_draft_id) REFERENCES product_drafts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS product_draft_revisions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES product_drafts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  data_hash TEXT NOT NULL,
  data JSONB NOT NULL,
  changed_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  change_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(draft_id, version)
);

CREATE TABLE IF NOT EXISTS product_draft_variants (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES product_drafts(id) ON DELETE CASCADE,
  source_payload_id TEXT REFERENCES collect_raw_payloads(id) ON DELETE SET NULL,
  variant_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  merge_model TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  offer_id TEXT NOT NULL DEFAULT '',
  data_hash TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(draft_id, variant_key)
);

CREATE INDEX IF NOT EXISTS product_draft_variants_draft_order_idx
  ON product_draft_variants(draft_id, sort_order);

CREATE TABLE IF NOT EXISTS submission_snapshots (
  id TEXT PRIMARY KEY,
  collect_item_id TEXT REFERENCES collect_items(id) ON DELETE SET NULL,
  draft_id TEXT REFERENCES product_drafts(id) ON DELETE SET NULL,
  draft_version INTEGER NOT NULL DEFAULT 1,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  snapshot_hash TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  items JSONB NOT NULL,
  stocks JSONB NOT NULL DEFAULT '[]'::JSONB,
  normalizer_version TEXT NOT NULL DEFAULT 'v3',
  category_rule_version TEXT NOT NULL DEFAULT '',
  dictionary_version TEXT NOT NULL DEFAULT '',
  rich_content_rule_version TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS submission_snapshots_store_created_idx
  ON submission_snapshots(store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS submission_jobs (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL UNIQUE REFERENCES submission_snapshots(id) ON DELETE RESTRICT,
  collect_item_id TEXT REFERENCES collect_items(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  type TEXT NOT NULL DEFAULT 'COLLECT_BOX_DRAFT',
  status TEXT NOT NULL DEFAULT 'QUEUE_PENDING' CHECK (status IN (
    'QUEUE_PENDING', 'QUEUED', 'VALIDATING', 'SUBMITTING', 'OZON_ACCEPTED',
    'CHECKING', 'RECONCILING', 'RETRY_PENDING', 'SUCCEEDED',
    'PARTIAL_SUCCESS', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED'
  )),
  status_version INTEGER NOT NULL DEFAULT 1,
  ozon_task_id TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  status_check_count INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  status_message TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL,
  locked_by TEXT NOT NULL DEFAULT '',
  lock_expires_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result_summary JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS submission_jobs_store_status_idx
  ON submission_jobs(store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS submission_jobs_ozon_task_idx
  ON submission_jobs(ozon_task_id) WHERE ozon_task_id <> '';
CREATE INDEX IF NOT EXISTS submission_jobs_lock_idx
  ON submission_jobs(status, lock_expires_at);

CREATE TABLE IF NOT EXISTS submission_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES submission_jobs(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES submission_snapshots(id) ON DELETE RESTRICT,
  variant_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  sku TEXT NOT NULL DEFAULT '',
  offer_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  product_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  request_hash TEXT NOT NULL DEFAULT '',
  response JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, variant_key)
);

CREATE INDEX IF NOT EXISTS submission_items_job_status_idx
  ON submission_items(job_id, status, sort_order);
CREATE INDEX IF NOT EXISTS submission_items_store_offer_lookup_idx
  ON submission_items(offer_id) WHERE offer_id <> '';

CREATE TABLE IF NOT EXISTS submission_events (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES submission_jobs(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS submission_events_job_created_idx
  ON submission_events(job_id, created_at, id);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT NOT NULL DEFAULT '',
  lock_expires_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
  ON outbox_events(status, available_at, created_at)
  WHERE status IN ('PENDING', 'PUBLISHING');

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_entity_idx
  ON audit_events(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_account_created_idx
  ON audit_events(account_id, created_at DESC);
